use crate::app_state::{AppDirs, AppState, StartRecordingRequest, StartRecordingResponse};
use crate::command_core::{validate_start_request, PipelineInvocation};
use crate::domain::session::{SessionArtifacts, SessionMeta};
use crate::services::pipeline_runner::{run_pipeline_core, PipelineMode};
use crate::settings::secret_store::{get_secret, set_secret};
use crate::storage::fs_layout::{build_session_relative_dir, summary_name, transcript_name};
use crate::storage::session_store::save_meta;
use crate::storage::sqlite_repo::{add_event, upsert_session};
use crate::{
    get_settings_from_dirs, root_recordings_dir, set_tray_indicator_from_state,
    stop_active_recording_internal,
};
use chrono::{DateTime, Local};
#[cfg(test)]
use std::cell::RefCell;
use uuid::Uuid;

#[cfg(test)]
thread_local! {
    static TEST_MACOS_SYSTEM_AUDIO_PERMISSION_STATUS: RefCell<Option<crate::commands::settings::MacosSystemAudioPermissionStatus>> = const { RefCell::new(None) };
}

#[tauri::command]
pub fn set_api_secret(
    dirs: tauri::State<AppDirs>,
    name: String,
    value: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Secret name must not be empty".to_string());
    }
    set_secret(&dirs.app_data_dir, name.trim(), value.trim())
}

#[tauri::command]
pub fn get_api_secret(dirs: tauri::State<AppDirs>, name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Secret name must not be empty".to_string());
    }
    get_secret(&dirs.app_data_dir, name.trim())
}

#[tauri::command]
pub fn start_recording(
    dirs: tauri::State<AppDirs>,
    state: tauri::State<AppState>,
    payload: StartRecordingRequest,
) -> Result<StartRecordingResponse, String> {
    start_recording_impl(dirs.inner(), state.inner(), payload)
}

fn apply_recording_input_mute(
    control: &crate::audio::capture::SharedRecordingControl,
    channel: &str,
    muted: bool,
) -> Result<crate::audio::capture::RecordingMuteState, String> {
    control.set_channel(channel, muted)?;
    Ok(control.snapshot())
}

fn apply_capture_input_mute_for_state(
    state: &AppState,
    channel: &str,
    muted: bool,
) -> Result<(), String> {
    if let Ok(capture_guard) = state.active_capture.lock() {
        if let Some(capture) = capture_guard.as_ref() {
            capture.set_channel_muted(channel.trim(), muted)?;
        }
    }
    Ok(())
}

fn apply_recording_input_mute_for_state(
    state: &AppState,
    session_id: &str,
    channel: &str,
    muted: bool,
) -> Result<crate::audio::capture::RecordingMuteState, String> {
    let guard = state
        .active_session
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let active_session = guard
        .as_ref()
        .ok_or_else(|| "No active recording session".to_string())?;
    if active_session.session_id != session_id {
        return Err("Recording session mismatch".to_string());
    }
    apply_capture_input_mute_for_state(state, channel, muted)?;
    apply_recording_input_mute(&state.recording_control, channel, muted)
}

#[tauri::command]
pub fn set_recording_input_muted(
    state: tauri::State<AppState>,
    session_id: String,
    channel: String,
    muted: bool,
) -> Result<crate::audio::capture::RecordingMuteState, String> {
    apply_recording_input_mute_for_state(state.inner(), session_id.trim(), channel.trim(), muted)
}

fn start_recording_impl(
    dirs: &AppDirs,
    state: &AppState,
    payload: StartRecordingRequest,
) -> Result<StartRecordingResponse, String> {
    validate_start_request(&payload.topic, &payload.participants)?;

    let mut guard = state
        .active_session
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;

    if guard.is_some() {
        return Err("Recording already active".to_string());
    }

    state.recording_control.reset();

    #[cfg(target_os = "macos")]
    {
        let permission_status = current_macos_system_audio_permission_status();
        ensure_macos_system_audio_permission(&permission_status)?;
    }

    let session_id = Uuid::new_v4().to_string();
    let source_from_payload = payload
        .tags
        .first()
        .cloned()
        .unwrap_or_else(|| "zoom".to_string());
    let topic_from_payload = payload.topic.clone();
    let meta = SessionMeta::new(
        session_id.clone(),
        payload.tags,
        payload.topic,
        payload.participants,
    );

    let settings = get_settings_from_dirs(dirs)?;
    let started_at: DateTime<Local> = DateTime::parse_from_rfc3339(&meta.started_at_iso)
        .map_err(|e| e.to_string())?
        .with_timezone(&Local);

    let rel_dir = build_session_relative_dir(&meta.primary_tag, started_at);
    let abs_dir = root_recordings_dir(&dirs.app_data_dir, &settings)?.join(&rel_dir);
    let mut meta = meta;
    meta.artifacts = SessionArtifacts {
        audio_file: crate::audio::file_writer::audio_file_name(&settings.audio_format),
        transcript_file: transcript_name(started_at),
        summary_file: summary_name(started_at),
        meta_file: "meta.json".to_string(),
    };

    let mic_name = if settings.mic_device_name.trim().is_empty() {
        None
    } else {
        Some(settings.mic_device_name.clone())
    };
    #[cfg(not(target_os = "macos"))]
    let system_source = if settings.system_device_name.trim().is_empty() {
        crate::audio::capture::detect_system_source_device()?
    } else {
        Some(settings.system_device_name.clone())
    };

    #[cfg(target_os = "macos")]
    let system_source = None;

    let capture = crate::audio::capture::ContinuousCapture::start(
        mic_name,
        system_source,
        state.live_levels.clone(),
        state.recording_control.clone(),
    )?;

    let persist_result = (|| -> Result<(), String> {
        std::fs::create_dir_all(&abs_dir).map_err(|e| e.to_string())?;
        save_meta(&abs_dir.join("meta.json"), &meta)?;
        let data_dir = dirs.app_data_dir.clone();
        upsert_session(&data_dir, &meta, &abs_dir, &abs_dir.join("meta.json"))?;
        add_event(
            &data_dir,
            &meta.session_id,
            "recording_started",
            "Session created",
        )?;
        std::fs::write(abs_dir.join(&meta.artifacts.transcript_file), "")
            .map_err(|e| e.to_string())?;
        std::fs::write(abs_dir.join(&meta.artifacts.summary_file), "")
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(err) = persist_result {
        stop_and_cleanup_started_capture(capture);
        return Err(err);
    }

    let mut cap_guard = state
        .active_capture
        .lock()
        .map_err(|_| "capture state lock poisoned".to_string())?;
    *cap_guard = Some(capture);

    *guard = Some(meta.clone());
    if let Ok(mut ui) = state.ui_sync.lock() {
        ui.source = source_from_payload;
        ui.topic = topic_from_payload;
    }
    set_tray_indicator_from_state(state, true);
    Ok(StartRecordingResponse {
        session_id,
        session_dir: abs_dir.to_string_lossy().to_string(),
        status: "recording".to_string(),
    })
}

fn stop_and_cleanup_started_capture(capture: crate::audio::capture::ContinuousCapture) {
    if let Ok(artifacts) = capture.stop_and_take_artifacts() {
        crate::audio::capture::cleanup_artifacts(&artifacts);
    }
}

#[tauri::command]
pub fn stop_recording(
    dirs: tauri::State<AppDirs>,
    state: tauri::State<AppState>,
    session_id: String,
) -> Result<String, String> {
    stop_active_recording_internal(dirs.inner(), state.inner(), Some(session_id.as_str()), None)
}

#[tauri::command]
pub fn stop_active_recording(
    dirs: tauri::State<AppDirs>,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    stop_active_recording_internal(dirs.inner(), state.inner(), None, None)
}

#[tauri::command]
pub async fn run_pipeline(
    dirs: tauri::State<'_, AppDirs>,
    session_id: String,
) -> Result<String, String> {
    run_pipeline_core(
        dirs.inner().clone(),
        &session_id,
        PipelineInvocation::Run,
        PipelineMode::Full,
        None,
    )
    .await
}

#[tauri::command]
pub async fn retry_pipeline(
    dirs: tauri::State<'_, AppDirs>,
    session_id: String,
) -> Result<String, String> {
    run_pipeline_core(
        dirs.inner().clone(),
        &session_id,
        PipelineInvocation::Retry,
        PipelineMode::Full,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_transcription(
    dirs: tauri::State<'_, AppDirs>,
    session_id: String,
) -> Result<String, String> {
    run_pipeline_core(
        dirs.inner().clone(),
        &session_id,
        PipelineInvocation::Manual,
        PipelineMode::TranscriptionOnly,
        None,
    )
    .await
}

#[tauri::command]
pub async fn run_summary(
    dirs: tauri::State<'_, AppDirs>,
    session_id: String,
    custom_prompt: Option<String>,
) -> Result<String, String> {
    run_pipeline_core(
        dirs.inner().clone(),
        &session_id,
        PipelineInvocation::Manual,
        PipelineMode::SummaryOnly,
        custom_prompt,
    )
    .await
}

fn ensure_macos_system_audio_permission(
    _status: &crate::commands::settings::MacosSystemAudioPermissionStatus,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn current_macos_system_audio_permission_status(
) -> crate::commands::settings::MacosSystemAudioPermissionStatus {
    #[cfg(test)]
    if let Some(status) = test_macos_system_audio_permission_status() {
        return status;
    }

    crate::audio::macos_system_audio::permission_status()
}

#[cfg(not(target_os = "macos"))]
fn current_macos_system_audio_permission_status(
) -> crate::commands::settings::MacosSystemAudioPermissionStatus {
    crate::audio::macos_system_audio::permission_status()
}

#[cfg(test)]
fn test_macos_system_audio_permission_status(
) -> Option<crate::commands::settings::MacosSystemAudioPermissionStatus> {
    TEST_MACOS_SYSTEM_AUDIO_PERMISSION_STATUS.with(|cell| cell.borrow().clone())
}

#[cfg(test)]
fn set_test_macos_system_audio_permission_status(
    status: Option<crate::commands::settings::MacosSystemAudioPermissionStatus>,
) {
    TEST_MACOS_SYSTEM_AUDIO_PERMISSION_STATUS.with(|cell| {
        *cell.borrow_mut() = status;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn allows_start_attempt_for_non_granted_macos_system_audio_permission_state() {
        let status = crate::commands::settings::MacosSystemAudioPermissionStatus {
            kind: crate::audio::macos_system_audio::MacosSystemAudioPermissionKind::Denied,
            can_request: false,
        };

        assert!(
            ensure_macos_system_audio_permission(&status).is_ok(),
            "permission status should not short-circuit a native capture start attempt"
        );
    }

    #[test]
    fn accepts_granted_macos_system_audio_permission() {
        let status = crate::commands::settings::MacosSystemAudioPermissionStatus {
            kind: crate::audio::macos_system_audio::MacosSystemAudioPermissionKind::Granted,
            can_request: false,
        };

        assert!(
            ensure_macos_system_audio_permission(&status).is_ok(),
            "granted permission should pass"
        );
    }

    #[test]
    fn apply_recording_input_mute_rejects_unknown_channel() {
        let control = crate::audio::capture::SharedRecordingControl::new();
        let error = apply_recording_input_mute(&control, "other", true).unwrap_err();
        assert_eq!(error, "Unsupported recording input channel");
    }

    #[test]
    fn apply_recording_input_mute_rejects_when_no_recording_is_active() {
        let state = AppState::default();

        let error = apply_recording_input_mute_for_state(&state, "missing-session", "mic", true)
            .unwrap_err();

        assert_eq!(error, "No active recording session");
        assert_eq!(
            state.recording_control.snapshot(),
            crate::audio::capture::RecordingMuteState::default()
        );
    }

    #[test]
    fn apply_recording_input_mute_rejects_session_mismatch() {
        let state = AppState::default();
        *state.active_session.lock().expect("session lock") = Some(SessionMeta::new(
            "active-session".to_string(),
            vec!["zoom".to_string()],
            String::new(),
            vec![],
        ));

        let error =
            apply_recording_input_mute_for_state(&state, "stale-session", "mic", true).unwrap_err();

        assert_eq!(error, "Recording session mismatch");
        assert_eq!(
            state.recording_control.snapshot(),
            crate::audio::capture::RecordingMuteState::default()
        );
    }

    #[test]
    fn apply_recording_input_mute_preserves_shared_state_when_capture_update_fails() {
        let state = AppState::default();
        *state.active_session.lock().expect("session lock") = Some(SessionMeta::new(
            "active-session".to_string(),
            vec!["zoom".to_string()],
            String::new(),
            vec![],
        ));
        *state.active_capture.lock().expect("capture lock") = Some(
            crate::audio::capture::ContinuousCapture::test_stub(state.recording_control.clone()),
        );
        crate::audio::capture::set_test_set_channel_muted_result(Some(Err(
            "native system mute failed".to_string(),
        )));

        let error =
            apply_recording_input_mute_for_state(&state, "active-session", "system", true)
                .unwrap_err();

        crate::audio::capture::set_test_set_channel_muted_result(None);
        assert_eq!(error, "native system mute failed");
        assert_eq!(
            state.recording_control.snapshot(),
            crate::audio::capture::RecordingMuteState::default()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn denied_macos_permission_does_not_short_circuit_native_capture_start_attempt() {
        let temp = tempdir().expect("tempdir");
        let dirs = AppDirs {
            app_data_dir: temp.path().to_path_buf(),
        };
        let state = AppState::default();
        let payload = StartRecordingRequest {
            tags: vec!["zoom".to_string()],
            topic: String::new(),
            participants: vec![],
        };
        let denied = crate::commands::settings::MacosSystemAudioPermissionStatus {
            kind: crate::audio::macos_system_audio::MacosSystemAudioPermissionKind::Denied,
            can_request: false,
        };

        set_test_macos_system_audio_permission_status(Some(denied));
        crate::audio::capture::set_test_macos_system_audio_start_capture_result(Some(Err(
            "native system capture failed".to_string(),
        )));
        let result = start_recording_impl(&dirs, &state, payload);
        crate::audio::capture::set_test_macos_system_audio_start_capture_result(None);
        set_test_macos_system_audio_permission_status(None);

        assert!(matches!(
            result,
            Err(ref err) if err == "native system capture failed"
        ));
        assert!(!temp.path().join("recordings").exists());
        assert!(state.active_session.lock().expect("session lock").is_none());
        assert!(state.active_capture.lock().expect("capture lock").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_capture_start_failure_prevents_session_side_effects() {
        let temp = tempdir().expect("tempdir");
        let dirs = AppDirs {
            app_data_dir: temp.path().to_path_buf(),
        };
        let state = AppState::default();
        let payload = StartRecordingRequest {
            tags: vec!["zoom".to_string()],
            topic: String::new(),
            participants: vec![],
        };
        let granted = crate::commands::settings::MacosSystemAudioPermissionStatus {
            kind: crate::audio::macos_system_audio::MacosSystemAudioPermissionKind::Granted,
            can_request: false,
        };

        set_test_macos_system_audio_permission_status(Some(granted));
        crate::audio::capture::set_test_macos_system_audio_start_capture_result(Some(Err(
            "native system capture failed".to_string(),
        )));
        let result = start_recording_impl(&dirs, &state, payload);
        crate::audio::capture::set_test_macos_system_audio_start_capture_result(None);
        set_test_macos_system_audio_permission_status(None);

        assert!(matches!(
            result,
            Err(ref err) if err == "native system capture failed"
        ));
        assert!(!temp.path().join("recordings").exists());
        assert!(state.active_session.lock().expect("session lock").is_none());
        assert!(state.active_capture.lock().expect("capture lock").is_none());
    }
}
