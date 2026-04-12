use crate::app_state::{
    AppDirs, AppState, LiveInputLevelsView, SessionMetaView, StartRecordingResponse,
    UiSyncStateView, UpdateSessionDetailsRequest,
};
use crate::domain::session::{format_ru_date, SessionArtifacts, SessionMeta, SessionStatus};
use crate::storage::fs_layout::{build_session_relative_dir, summary_name, transcript_name};
use crate::storage::session_store::{load_meta, save_meta};
use crate::storage::sqlite_repo::{
    add_event, delete_session as repo_delete_session, get_meta_path, get_session_dir,
    list_sessions as repo_list_sessions, upsert_session, SessionListItem,
};
use crate::{get_settings_from_dirs, root_recordings_dir, set_tray_indicator_from_state};
use chrono::{Duration, Local};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

fn open_path_in_file_manager(path: &Path, preferred_app: Option<&str>) -> Result<(), String> {
    let target = path
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .trim();
    if target.is_empty() {
        return Err("Path is empty".to_string());
    }

    let preferred_app = preferred_app.map(str::trim).filter(|v| !v.is_empty());
    if let Some(app) = preferred_app {
        let status = if cfg!(target_os = "macos") {
            std::process::Command::new("open")
                .arg("-a")
                .arg(app)
                .arg(target)
                .status()
                .map_err(|e| e.to_string())?
        } else {
            std::process::Command::new(app)
                .arg(target)
                .status()
                .map_err(|e| e.to_string())?
        };

        if status.success() {
            return Ok(());
        }
        return Err(format!(
            "failed to open path with preferred app: exit status {status}"
        ));
    }

    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(target)
            .status()
            .map_err(|e| e.to_string())?
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(target)
            .status()
            .map_err(|e| e.to_string())?
    } else {
        std::process::Command::new("xdg-open")
            .arg(target)
            .status()
            .map_err(|e| e.to_string())?
    };

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "failed to open session folder: exit status {status}"
        ))
    }
}

fn resolve_artifact_path(
    session_dir: &Path,
    meta: &SessionMeta,
    artifact_kind: &str,
) -> Result<PathBuf, String> {
    let file_name = match artifact_kind {
        "transcript" => &meta.artifacts.transcript_file,
        "summary" => &meta.artifacts.summary_file,
        _ => return Err("Unsupported artifact kind".to_string()),
    };
    Ok(session_dir.join(file_name))
}

fn remove_session_catalog(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

fn supported_audio_extension(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Unsupported audio file".to_string())?;
    match ext.as_str() {
        "opus" | "mp3" | "m4a" | "ogg" | "wav" => Ok(ext),
        _ => Err("Unsupported audio file".to_string()),
    }
}

fn imported_topic_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Imported audio")
        .to_string()
}

fn unique_session_dir(root_dir: &Path, primary_tag: &str) -> PathBuf {
    let now = Local::now();
    let relative = build_session_relative_dir(primary_tag, now);
    let candidate = root_dir.join(&relative);
    if !candidate.exists() {
        return candidate;
    }

    let parent = candidate
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root_dir.to_path_buf());
    let stem = candidate
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("meeting");
    for suffix in 2.. {
        let next = parent.join(format!("{stem}_{suffix}"));
        if !next.exists() {
            return next;
        }
    }
    unreachable!()
}

fn probe_audio_duration_seconds(path: &Path) -> Option<i64> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let seconds = stdout.trim().parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(seconds.round() as i64)
}

fn import_audio_session_from_path(
    dirs: &AppDirs,
    selected_audio: &Path,
) -> Result<StartRecordingResponse, String> {
    if !selected_audio.exists() || !selected_audio.is_file() {
        return Err("Selected audio file was not found".to_string());
    }

    let audio_extension = supported_audio_extension(selected_audio)?;
    let settings = get_settings_from_dirs(dirs)?;
    let recordings_root = root_recordings_dir(&dirs.app_data_dir, &settings)?;
    let now = Local::now();
    let session_id = Uuid::new_v4().to_string();
    let session_dir = unique_session_dir(&recordings_root, "other");
    let topic = imported_topic_from_path(selected_audio);
    let duration_seconds = probe_audio_duration_seconds(selected_audio).unwrap_or(0);

    fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;

    let mut meta = SessionMeta::new(session_id.clone(), vec!["other".to_string()], topic, vec![]);
    meta.status = SessionStatus::Recorded;
    meta.created_at_iso = now.to_rfc3339();
    meta.started_at_iso = now.to_rfc3339();
    meta.ended_at_iso = Some((now + Duration::seconds(duration_seconds)).to_rfc3339());
    meta.display_date_ru = format_ru_date(now);
    meta.artifacts = SessionArtifacts {
        audio_file: format!("audio.{audio_extension}"),
        transcript_file: transcript_name(now),
        summary_file: summary_name(now),
        meta_file: "meta.json".to_string(),
    };

    let audio_dst = session_dir.join(&meta.artifacts.audio_file);
    fs::copy(selected_audio, &audio_dst).map_err(|e| e.to_string())?;

    let meta_path = session_dir.join(&meta.artifacts.meta_file);
    save_meta(&meta_path, &meta)?;
    fs::write(session_dir.join(&meta.artifacts.transcript_file), "").map_err(|e| e.to_string())?;
    fs::write(session_dir.join(&meta.artifacts.summary_file), "").map_err(|e| e.to_string())?;
    upsert_session(&dirs.app_data_dir, &meta, &session_dir, &meta_path)?;
    add_event(
        &dirs.app_data_dir,
        &meta.session_id,
        "audio_imported",
        "Imported external audio into native session",
    )?;

    Ok(StartRecordingResponse {
        session_id,
        session_dir: session_dir.to_string_lossy().to_string(),
        status: "recorded".to_string(),
    })
}

#[tauri::command]
pub fn import_audio_session(
    dirs: tauri::State<AppDirs>,
) -> Result<Option<StartRecordingResponse>, String> {
    let Some(selected_audio) = pick_audio_file_with_system_dialog()? else {
        return Ok(None);
    };
    import_audio_session_from_path(dirs.inner(), &selected_audio).map(Some)
}

#[cfg(target_os = "macos")]
fn pick_audio_file_with_system_dialog() -> Result<Option<PathBuf>, String> {
    let script = r#"
try
  set chosenFile to POSIX path of (choose file with prompt "Choose audio file")
  return chosenFile
on error number -128
  return ""
end try
"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed to choose audio file".to_string()
        } else {
            stderr
        });
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if selected.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(selected)))
    }
}

#[cfg(target_os = "windows")]
fn pick_audio_file_with_system_dialog() -> Result<Option<PathBuf>, String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose audio file'
$dialog.Filter = 'Audio Files|*.opus;*.mp3;*.m4a;*.ogg;*.wav'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}
"#;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed to choose audio file".to_string()
        } else {
            stderr
        });
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if selected.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(selected)))
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn pick_audio_file_with_system_dialog() -> Result<Option<PathBuf>, String> {
    if command_exists("zenity") {
        let output = Command::new("zenity")
            .args([
                "--file-selection",
                "--title=Choose audio file",
                "--file-filter=Audio files | *.opus *.mp3 *.m4a *.ogg *.wav",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return if selected.is_empty() {
                Ok(None)
            } else {
                Ok(Some(PathBuf::from(selected)))
            };
        }
        return Ok(None);
    }

    if command_exists("kdialog") {
        let output = Command::new("kdialog")
            .args([
                "--getopenfilename",
                ".",
                "*.opus *.mp3 *.m4a *.ogg *.wav|Audio files",
                "--title",
                "Choose audio file",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return if selected.is_empty() {
                Ok(None)
            } else {
                Ok(Some(PathBuf::from(selected)))
            };
        }
        return Ok(None);
    }

    Err("Audio file picker is not available on this platform".to_string())
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn command_exists(program: &str) -> bool {
    Command::new("which")
        .arg(program)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SessionArtifactSearchHit {
    pub transcript_match: bool,
    pub summary_match: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SessionArtifactReadResponse {
    pub path: String,
    pub text: String,
}

fn file_contains_query(path: &Path, query_lower: &str) -> bool {
    if query_lower.is_empty() || !path.exists() {
        return false;
    }
    let normalized_query = query_lower.to_lowercase();
    fs::read_to_string(path)
        .ok()
        .map(|content| content.to_lowercase().contains(&normalized_query))
        .unwrap_or(false)
}

fn search_session_artifacts_in_dir(
    session_dir: &Path,
    meta: &SessionMeta,
    query_lower: &str,
) -> SessionArtifactSearchHit {
    let transcript_match = file_contains_query(
        &session_dir.join(&meta.artifacts.transcript_file),
        query_lower,
    );
    let summary_match =
        file_contains_query(&session_dir.join(&meta.artifacts.summary_file), query_lower);
    SessionArtifactSearchHit {
        transcript_match,
        summary_match,
    }
}

#[tauri::command]
pub fn open_session_folder(session_dir: String) -> Result<String, String> {
    let target = PathBuf::from(session_dir);
    open_path_in_file_manager(&target, None)?;
    Ok("opened".to_string())
}

#[tauri::command]
pub fn open_session_artifact(
    dirs: tauri::State<AppDirs>,
    session_id: String,
    artifact_kind: String,
) -> Result<String, String> {
    let meta_path = get_meta_path(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta = load_meta(&meta_path)?;
    let session_dir = meta_path
        .parent()
        .ok_or_else(|| "Invalid session directory".to_string())?;
    let artifact_path = resolve_artifact_path(session_dir, &meta, artifact_kind.trim())?;
    if !artifact_path.exists() {
        return Err("Artifact file not found".to_string());
    }

    let settings = get_settings_from_dirs(dirs.inner())?;
    open_path_in_file_manager(&artifact_path, Some(&settings.artifact_open_app))?;
    Ok("opened".to_string())
}

#[tauri::command]
pub fn read_session_artifact(
    dirs: tauri::State<AppDirs>,
    session_id: String,
    artifact_kind: String,
) -> Result<SessionArtifactReadResponse, String> {
    let meta_path = get_meta_path(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta = load_meta(&meta_path)?;
    let session_dir = meta_path
        .parent()
        .ok_or_else(|| "Invalid session directory".to_string())?;
    let artifact_path = resolve_artifact_path(session_dir, &meta, artifact_kind.trim())?;
    if !artifact_path.exists() {
        return Err("Artifact file not found".to_string());
    }

    let text = fs::read_to_string(&artifact_path).map_err(|e| e.to_string())?;
    Ok(SessionArtifactReadResponse {
        path: artifact_path.to_string_lossy().to_string(),
        text,
    })
}

#[tauri::command]
pub fn delete_session(
    dirs: tauri::State<AppDirs>,
    state: tauri::State<AppState>,
    session_id: String,
    force: Option<bool>,
) -> Result<String, String> {
    let force_delete = force.unwrap_or(false);
    let active_session_id = state
        .active_session
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .as_ref()
        .map(|meta| meta.session_id.clone());
    if active_session_id.as_deref() == Some(session_id.as_str()) {
        if !force_delete {
            return Err("Cannot delete active recording session".to_string());
        }
        let mut capture_guard = state
            .active_capture
            .lock()
            .map_err(|_| "capture state lock poisoned".to_string())?;
        if let Some(capture) = capture_guard.take() {
            let _ = capture.stop_and_take_artifacts();
        }
        drop(capture_guard);
        let mut session_guard = state
            .active_session
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        *session_guard = None;
        state.live_levels.reset();
        set_tray_indicator_from_state(state.inner(), false);
    }

    let session_dir = get_session_dir(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    remove_session_catalog(&session_dir)?;
    let deleted = repo_delete_session(&dirs.app_data_dir, &session_id)?;
    if !deleted {
        return Err("Session not found".to_string());
    }
    Ok("deleted".to_string())
}

#[tauri::command]
pub fn list_sessions(dirs: tauri::State<AppDirs>) -> Result<Vec<SessionListItem>, String> {
    repo_list_sessions(&dirs.app_data_dir)
}

#[tauri::command]
pub fn search_session_artifacts(
    dirs: tauri::State<AppDirs>,
    query: String,
) -> Result<HashMap<String, SessionArtifactSearchHit>, String> {
    let query_lower = query.trim().to_lowercase();
    if query_lower.is_empty() {
        return Ok(HashMap::new());
    }

    let sessions = repo_list_sessions(&dirs.app_data_dir)?;
    let mut found = HashMap::new();
    for session in sessions {
        let Some(meta_path) = get_meta_path(&dirs.app_data_dir, &session.session_id)? else {
            continue;
        };
        let Ok(meta) = load_meta(&meta_path) else {
            continue;
        };
        let search_hit =
            search_session_artifacts_in_dir(Path::new(&session.session_dir), &meta, &query_lower);
        if search_hit.transcript_match || search_hit.summary_match {
            found.insert(session.session_id, search_hit);
        }
    }
    Ok(found)
}

#[tauri::command]
pub fn get_ui_sync_state(state: tauri::State<AppState>) -> Result<UiSyncStateView, String> {
    build_ui_sync_state_view(state.inner())
}

fn build_ui_sync_state_view(state: &AppState) -> Result<UiSyncStateView, String> {
    let ui = state
        .ui_sync
        .lock()
        .map_err(|_| "ui state lock poisoned".to_string())?
        .clone();
    let active = state
        .active_session
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let active_session_id = active.as_ref().map(|s| s.session_id.clone());
    Ok(UiSyncStateView {
        source: ui.source,
        topic: ui.topic,
        is_recording: active.is_some(),
        active_session_id,
        mute_state: state.recording_control.snapshot(),
    })
}

#[tauri::command]
pub fn get_live_input_levels(state: tauri::State<AppState>) -> Result<LiveInputLevelsView, String> {
    if let Ok(capture_guard) = state.active_capture.lock() {
        if let Some(capture) = capture_guard.as_ref() {
            capture.refresh_native_system_level(&state.live_levels);
        }
    }
    let levels = state.live_levels.snapshot();
    Ok(LiveInputLevelsView {
        mic: levels.mic,
        system: levels.system,
    })
}

#[tauri::command]
pub fn set_ui_sync_state(
    state: tauri::State<AppState>,
    source: String,
    topic: String,
) -> Result<String, String> {
    let mut ui = state
        .ui_sync
        .lock()
        .map_err(|_| "ui state lock poisoned".to_string())?;
    if !source.trim().is_empty() {
        ui.source = source.trim().to_string();
    }
    ui.topic = topic;
    Ok("updated".to_string())
}

#[tauri::command]
pub fn get_session_meta(
    dirs: tauri::State<AppDirs>,
    session_id: String,
) -> Result<SessionMetaView, String> {
    let meta_path = get_meta_path(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta = load_meta(&meta_path)?;
    let custom_tag = meta
        .tags
        .iter()
        .skip(1)
        .find(|v| !v.trim().is_empty())
        .cloned()
        .unwrap_or_default();
    Ok(SessionMetaView {
        session_id: meta.session_id,
        source: meta.primary_tag,
        custom_tag,
        custom_summary_prompt: meta.custom_summary_prompt,
        topic: meta.topic,
        participants: meta.participants,
    })
}

#[tauri::command]
pub fn update_session_details(
    dirs: tauri::State<AppDirs>,
    payload: UpdateSessionDetailsRequest,
) -> Result<String, String> {
    let meta_path = get_meta_path(&dirs.app_data_dir, &payload.session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let mut meta = load_meta(&meta_path)?;

    let source = if payload.source.trim().is_empty() {
        meta.primary_tag.clone()
    } else {
        payload.source.trim().to_string()
    };
    let custom_tag = payload.custom_tag.trim().to_string();
    let mut tags = vec![source.clone()];
    if !custom_tag.is_empty() {
        tags.push(custom_tag.clone());
    }

    meta.primary_tag = source;
    meta.tags = tags;
    meta.custom_summary_prompt = payload.custom_summary_prompt.trim().to_string();
    meta.topic = payload.topic.trim().to_string();
    meta.participants = payload
        .participants
        .into_iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();

    let session_dir = meta_path
        .parent()
        .ok_or_else(|| "Invalid session directory".to_string())?;
    save_meta(&meta_path, &meta)?;
    upsert_session(&dirs.app_data_dir, &meta, session_dir, &meta_path)?;
    add_event(
        &dirs.app_data_dir,
        &meta.session_id,
        "session_details_updated",
        "Source/topic/participants/summary prompt updated",
    )?;
    Ok("updated".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::AppState;
    use crate::domain::session::{SessionArtifacts, SessionStatus};
    use crate::settings::public_settings::{save_settings, PublicSettings};
    use crate::storage::sqlite_repo::list_sessions as repo_list_sessions;
    use chrono::Local;
    use tempfile::tempdir;

    fn sample_meta() -> SessionMeta {
        let mut meta = SessionMeta::new(
            "s1".to_string(),
            vec!["slack".to_string()],
            "Topic".to_string(),
            vec![],
        );
        meta.artifacts = SessionArtifacts {
            audio_file: "audio.opus".to_string(),
            transcript_file: "transcript.txt".to_string(),
            summary_file: "summary.md".to_string(),
            meta_file: "meta.json".to_string(),
        };
        meta
    }

    #[test]
    fn resolves_transcript_artifact_path() {
        let dir = PathBuf::from("/tmp/s1");
        let path = resolve_artifact_path(&dir, &sample_meta(), "transcript").expect("path");
        assert_eq!(path, PathBuf::from("/tmp/s1/transcript.txt"));
    }

    #[test]
    fn rejects_unknown_artifact_kind() {
        let dir = PathBuf::from("/tmp/s1");
        let result = resolve_artifact_path(&dir, &sample_meta(), "audio");
        assert_eq!(result, Err("Unsupported artifact kind".to_string()));
    }

    #[test]
    fn search_artifacts_matches_transcript_and_summary_case_insensitively() {
        let tmp = tempdir().expect("tempdir");
        let dir = tmp.path().join("s1");
        fs::create_dir_all(&dir).expect("create session dir");
        fs::write(
            dir.join("transcript.txt"),
            "Обсудили ACME renewal risk и дедлайн поставки",
        )
        .expect("write transcript");
        fs::write(dir.join("summary.md"), "Decision: postpone rollout").expect("write summary");
        let hit = search_session_artifacts_in_dir(&dir, &sample_meta(), "acme renewal risk");
        assert_eq!(
            hit,
            SessionArtifactSearchHit {
                transcript_match: true,
                summary_match: false
            }
        );

        let summary_hit = search_session_artifacts_in_dir(&dir, &sample_meta(), "POSTPONE");
        assert_eq!(
            summary_hit,
            SessionArtifactSearchHit {
                transcript_match: false,
                summary_match: true
            }
        );
    }

    #[test]
    fn search_artifacts_ignores_legacy_summary_txt_when_summary_md_is_missing() {
        let tmp = tempdir().expect("tempdir");
        let dir = tmp.path().join("s1");
        fs::create_dir_all(&dir).expect("create session dir");
        fs::write(dir.join("summary.txt"), "Decision: postpone rollout").expect("write summary");

        let hit = search_session_artifacts_in_dir(&dir, &sample_meta(), "postpone");
        assert_eq!(
            hit,
            SessionArtifactSearchHit {
                transcript_match: false,
                summary_match: false
            }
        );
    }

    #[test]
    fn ui_sync_state_view_includes_authoritative_mute_state() {
        let state = AppState::default();
        {
            let mut ui = state.ui_sync.lock().expect("ui lock");
            ui.source = "telegram".to_string();
            ui.topic = "Daily sync".to_string();
        }
        *state.active_session.lock().expect("session lock") = Some(SessionMeta::new(
            "active-session".to_string(),
            vec!["telegram".to_string()],
            "Daily sync".to_string(),
            vec![],
        ));
        state
            .recording_control
            .set_channel("mic", true)
            .expect("mute mic");

        let view = build_ui_sync_state_view(&state).expect("ui sync view");

        assert_eq!(view.source, "telegram");
        assert_eq!(view.topic, "Daily sync");
        assert!(view.is_recording);
        assert_eq!(view.active_session_id.as_deref(), Some("active-session"));
        assert_eq!(
            view.mute_state,
            crate::audio::capture::RecordingMuteState {
                mic_muted: true,
                system_muted: false,
            }
        );
    }

    #[test]
    fn import_selected_audio_creates_native_session() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        fs::create_dir_all(&app_data_dir).expect("create app-data");
        let recording_root = tmp.path().join("recordings");
        let settings = PublicSettings {
            recording_root: recording_root.to_string_lossy().to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: String::new(),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_CORP".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
            summary_url: String::new(),
            summary_prompt: String::new(),
            openai_model: "gpt-4.1-mini".to_string(),
            audio_format: "opus".to_string(),
            opus_bitrate_kbps: 24,
            mic_device_name: String::new(),
            system_device_name: String::new(),
            artifact_opener_app: String::new(),
            auto_run_pipeline_on_stop: false,
            api_call_logging_enabled: false,
        };
        save_settings(&app_data_dir, &settings).expect("save settings");

        let selected_audio = tmp.path().join("dictaphone-note.wav");
        fs::write(&selected_audio, b"RIFFfake").expect("write audio fixture");

        let dirs = AppDirs {
            app_data_dir: app_data_dir.clone(),
        };
        let response =
            import_audio_session_from_path(&dirs, &selected_audio).expect("import audio");
        let session_dir = PathBuf::from(&response.session_dir);

        assert_eq!(response.status, "recorded");
        assert!(session_dir.starts_with(recording_root.join(Local::now().format("%d.%m.%Y").to_string())));
        assert!(!session_dir
            .components()
            .any(|component| component.as_os_str() == "other"));
        assert!(session_dir
            .to_string_lossy()
            .contains(&Local::now().format("%d.%m.%Y").to_string()));
        assert!(session_dir.join("audio.wav").exists());
        assert!(session_dir.join("meta.json").exists());
        assert!(session_dir
            .join("transcript_".to_string() + &Local::now().format("%d.%m.%Y").to_string() + ".txt")
            .exists());
        assert!(session_dir
            .join("summary_".to_string() + &Local::now().format("%d.%m.%Y").to_string() + ".md")
            .exists());

        let meta = load_meta(&session_dir.join("meta.json")).expect("load meta");
        assert_eq!(meta.primary_tag, "other");
        assert_eq!(meta.tags, vec!["other".to_string()]);
        assert_eq!(meta.status, SessionStatus::Recorded);
        assert_eq!(meta.artifacts.audio_file, "audio.wav");

        let listed = repo_list_sessions(&app_data_dir).expect("list sessions");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].primary_tag, "other");
        assert_eq!(listed[0].audio_format, "wav");
        assert_eq!(
            listed[0].meta.as_ref().map(|meta| meta.source.as_str()),
            Some("other")
        );
    }
}
