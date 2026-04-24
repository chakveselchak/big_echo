mod app_state;
mod audio;
mod command_core;
mod commands;
mod domain;
mod hotkey_manager;
mod pipeline;
mod services;
mod settings;
mod storage;
mod text_editors;
mod tray_manager;
mod window_manager;

#[cfg(test)]
use app_state::StartRecordingResponse;
use app_state::{AppDirs, AppState};
use chrono::{DateTime, Local};
use command_core::{ensure_stop_session_matches, PipelineInvocation};
use commands::recording::{
    get_api_secret, retry_pipeline, run_pipeline, run_summary, run_transcription, set_api_secret,
    set_recording_input_muted, start_recording, stop_active_recording, stop_recording,
};
use commands::sessions::{
    auto_delete_old_session_audio, delete_session, delete_session_audio, get_live_input_levels,
    get_session_meta, get_ui_sync_state, import_audio_session, list_known_tags, list_sessions,
    open_session_artifact, open_session_folder, read_session_artifact, search_session_artifacts,
    set_ui_sync_state, sync_sessions, update_session_details,
};
use commands::settings::{
    detect_system_source_device, get_computer_name, get_macos_system_audio_permission_status,
    get_settings, list_audio_input_devices, list_text_editor_apps,
    open_macos_system_audio_settings, open_settings_window, open_tray_window, pick_recording_root,
    save_public_settings,
};
use commands::updates::{check_for_update, open_external_url};
use commands::yandex_sync::{
    yandex_sync_clear_token, yandex_sync_has_token, yandex_sync_now, yandex_sync_set_token,
    yandex_sync_status,
};
#[cfg(test)]
use domain::session::SessionMeta;
use domain::session::SessionStatus;
use services::pipeline_runner::{run_pipeline_core, spawn_retry_worker, PipelineMode};
#[cfg(test)]
use settings::public_settings::save_settings;
use settings::public_settings::{load_settings, PublicSettings};
use std::fs;
use std::path::{Path, PathBuf};
use storage::fs_layout::build_session_relative_dir;
use storage::session_store::save_meta;
use storage::sqlite_repo::{add_event, upsert_session};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent};

#[cfg(test)]
const MAX_PIPELINE_RETRY_ATTEMPTS: i64 = 4;

// ── App-data helpers ─────────────────────────────────────────────────────────

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

pub(crate) fn root_recordings_dir(
    app_data_dir: &std::path::Path,
    settings: &PublicSettings,
) -> Result<PathBuf, String> {
    let root = PathBuf::from(&settings.recording_root);
    if root.is_absolute() {
        Ok(root)
    } else {
        Ok(app_data_dir.join(root))
    }
}

pub(crate) fn get_settings_from_dirs(dirs: &AppDirs) -> Result<PublicSettings, String> {
    load_settings(&dirs.app_data_dir)
}

// ── Pipeline helpers ─────────────────────────────────────────────────────────

fn should_auto_run_pipeline_after_stop(settings: &PublicSettings) -> bool {
    let transcription_ready = if settings.transcription_provider == "salute_speech" {
        true
    } else {
        !settings.transcription_url.trim().is_empty()
    };
    settings.auto_run_pipeline_on_stop
        && transcription_ready
        && !settings.summary_url.trim().is_empty()
}

// ── Capture artifact recovery ────────────────────────────────────────────────

fn move_artifact_to_recovery(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if dst.exists() {
        fs::remove_file(dst).map_err(|e| e.to_string())?;
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(src, dst).map_err(|e| e.to_string())?;
            fs::remove_file(src).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

fn preserve_capture_artifacts_for_recovery(
    session_dir: &Path,
    artifacts: &audio::capture::CaptureArtifacts,
) -> Result<Vec<PathBuf>, String> {
    fs::create_dir_all(session_dir).map_err(|e| e.to_string())?;
    let mut preserved = Vec::new();

    let mic_dst = session_dir.join("audio_recovery_mic.raw");
    move_artifact_to_recovery(&artifacts.mic_path, &mic_dst)?;
    if mic_dst.exists() {
        preserved.push(mic_dst);
    }

    if let Some(system_path) = &artifacts.system_path {
        let system_dst = session_dir.join("audio_recovery_system.raw");
        move_artifact_to_recovery(system_path, &system_dst)?;
        if system_dst.exists() {
            preserved.push(system_dst);
        }
    }

    Ok(preserved)
}

// ── Core stop implementation ─────────────────────────────────────────────────

pub(crate) fn stop_active_recording_internal(
    dirs: &AppDirs,
    state: &AppState,
    session_id: Option<&str>,
    app: Option<&AppHandle>,
) -> Result<String, String> {
    let mut guard = state
        .active_session
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;

    let mut meta = guard
        .take()
        .ok_or_else(|| "No active recording session".to_string())?;

    ensure_stop_session_matches(&meta.session_id, session_id)?;

    meta.ended_at_iso = Some(Local::now().to_rfc3339());

    let settings = get_settings_from_dirs(dirs)?;
    let started_at: DateTime<Local> = DateTime::parse_from_rfc3339(&meta.started_at_iso)
        .map_err(|e| e.to_string())?
        .with_timezone(&Local);
    let rel_dir = build_session_relative_dir(&meta.primary_tag, started_at);
    let abs_dir = root_recordings_dir(&dirs.app_data_dir, &settings)?.join(&rel_dir);
    let data_dir = dirs.app_data_dir.clone();
    let audio_output_path = abs_dir.join(&meta.artifacts.audio_file);

    let mut cap_guard = state
        .active_capture
        .lock()
        .map_err(|_| "capture state lock poisoned".to_string())?;
    let mut finalize_error: Option<String> = None;
    if let Some(capture) = cap_guard.take() {
        match capture.stop_and_take_artifacts() {
            Ok(artifacts) => match audio::file_writer::write_capture_to_audio_file(
                &audio_output_path,
                &settings.audio_format,
                &artifacts,
                settings.opus_bitrate_kbps,
            ) {
                Ok(()) => audio::capture::cleanup_artifacts(&artifacts),
                Err(err) => {
                    let preserved = preserve_capture_artifacts_for_recovery(&abs_dir, &artifacts)?;
                    let recovery_paths = preserved
                        .iter()
                        .map(|v| v.to_string_lossy().to_string())
                        .collect::<Vec<_>>()
                        .join(", ");
                    finalize_error = Some(format!(
                        "Audio encoding failed: {err}. Raw capture preserved: {recovery_paths}"
                    ));
                }
            },
            Err(err) => {
                finalize_error = Some(format!("Audio capture finalization failed: {err}"));
            }
        }
    } else if let Err(err) = audio::file_writer::write_silence_audio_file(
        &audio_output_path,
        &settings.audio_format,
        settings.opus_bitrate_kbps,
    ) {
        finalize_error = Some(format!("Audio encoding failed: {err}"));
    }
    state.live_levels.reset();
    state.recording_control.reset();

    if let Some(app) = app {
        let _ = tray_manager::set_tray_indicator(app, false);
    } else {
        tray_manager::set_tray_indicator_from_state(state, false);
    }

    if let Some(err) = finalize_error {
        meta.status = SessionStatus::Failed;
        meta.errors.push(err.clone());
        save_meta(&abs_dir.join("meta.json"), &meta)?;
        upsert_session(&data_dir, &meta, &abs_dir, &abs_dir.join("meta.json"))?;
        add_event(
            &data_dir,
            &meta.session_id,
            "recording_finalize_failed",
            &err,
        )?;
        return Err(err);
    }

    meta.status = SessionStatus::Recorded;
    save_meta(&abs_dir.join("meta.json"), &meta)?;
    upsert_session(&data_dir, &meta, &abs_dir, &abs_dir.join("meta.json"))?;
    add_event(
        &data_dir,
        &meta.session_id,
        "recording_stopped",
        "Audio capture stopped",
    )?;

    if should_auto_run_pipeline_after_stop(&settings) {
        let dirs_for_pipeline = dirs.clone();
        let session_id = meta.session_id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = run_pipeline_core(
                dirs_for_pipeline,
                &session_id,
                PipelineInvocation::Run,
                PipelineMode::Full,
                None,
            )
            .await;
        });
    }

    Ok("recorded".to_string())
}

// ── Test-only helpers ────────────────────────────────────────────────────────

#[cfg(test)]
fn schedule_retry_for_session(
    data_dir: &std::path::Path,
    session_id: &str,
    error: &str,
) -> Result<(), String> {
    services::pipeline_runner::schedule_retry_for_session(data_dir, session_id, error)
}

#[cfg(test)]
async fn process_retry_jobs_once(
    dirs: &AppDirs,
    now_epoch: i64,
    limit: usize,
) -> Result<(), String> {
    services::pipeline_runner::process_retry_jobs_once(dirs, now_epoch, limit).await
}

// ── Entry point ──────────────────────────────────────────────────────────────

fn main() {
    let builder = tauri::Builder::default();
    let builder = builder.setup(|app| {
        let data_dir = app_data_dir(&app.handle())?;
        app.manage(AppDirs {
            app_data_dir: data_dir.clone(),
        });
        window_manager::register_close_to_tray_for_main(&app.handle());
        let _ = tray_manager::apply_app_icons_for_theme(
            &app.handle(),
            tray_manager::resolve_system_theme(&app.handle()),
        );
        if let Ok(mut tray_app) = app.state::<AppState>().tray_app.lock() {
            *tray_app = Some(app.handle().clone());
        }
        if window_manager::should_start_hidden_on_launch_from_env() {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        spawn_retry_worker(AppDirs {
            app_data_dir: data_dir.clone(),
        });
        tauri::async_runtime::spawn(services::yandex_disk::scheduler::run_loop(
            app.handle().clone(),
        ));
        window_manager::spawn_live_levels_worker(
            app.handle().clone(),
            AppDirs {
                app_data_dir: data_dir.clone(),
            },
        );
        window_manager::prewarm_tray_window(&app.handle())?;
        tray_manager::spawn_tray_idle_release_worker(app.handle().clone());
        #[cfg(target_os = "macos")]
        {
            let app_menu = tray_manager::build_macos_app_menu(app)?;
            app.set_menu(app_menu).map_err(|e| e.to_string())?;
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "app_settings" {
                    let _ = window_manager::open_settings_window_internal(app);
                }
            });
        }

        let open_item = MenuItem::with_id(app, "open", "Open BigEcho", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let recorder_item = MenuItem::with_id(app, "recorder", "Recorder", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let toggle_item =
            MenuItem::with_id(app, "toggle", "Show/Hide BigEcho", true, None::<&str>)
                .map_err(|e| e.to_string())?;
        let start_item =
            MenuItem::with_id(app, "start", "Start Recording", true, None::<&str>)
                .map_err(|e| e.to_string())?;
        let stop_item = MenuItem::with_id(app, "stop", "Stop Recording", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
            .map_err(|e| e.to_string())?;

        let menu = Menu::with_items(
            app,
            &[
                &open_item,
                &recorder_item,
                &toggle_item,
                &start_item,
                &stop_item,
                &settings_item,
                &quit_item,
            ],
        )
        .map_err(|e| e.to_string())?;

        let initial_tray_icon = tray_manager::load_png_icon(tray_manager::tray_icon_bytes(
            tray_manager::choose_tray_icon_variant(
                tray_manager::resolve_system_theme(&app.handle()),
                false,
            ),
        ))?;
        let left_click_context_menu =
            tray_manager::should_show_context_menu_on_left_click(std::env::consts::OS);

        TrayIconBuilder::with_id(tray_manager::TRAY_ICON_ID)
            .icon(initial_tray_icon)
            .menu(&menu)
            .tooltip("BigEcho IDLE")
            .show_menu_on_left_click(left_click_context_menu)
            .on_menu_event(|tray, event| {
                let app = tray.app_handle();
                match event.id().as_ref() {
                    "open" => {
                        let _ = window_manager::focus_main_window(app);
                    }
                    "toggle" => {
                        let _ = window_manager::toggle_main_window_visibility(app);
                    }
                    "recorder" => {
                        let _ = window_manager::open_tray_window_internal(app);
                    }
                    "start" => {
                        let _ = window_manager::focus_main_window(app);
                        let _ = app.emit("tray:start", ());
                    }
                    "stop" => {
                        let _ = app.emit("tray:stop", ());
                        let state = app.state::<AppState>();
                        let dirs = app.state::<AppDirs>();
                        let _ = stop_active_recording_internal(
                            dirs.inner(),
                            state.inner(),
                            None,
                            Some(app),
                        );
                    }
                    "settings" => {
                        let _ = window_manager::open_settings_window_internal(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    position,
                    ..
                } = event
                {
                    if tray_manager::should_toggle_tray_popover_on_left_click(
                        std::env::consts::OS,
                    ) {
                        let _ = window_manager::toggle_tray_window_visibility(
                            tray.app_handle(),
                            Some(position),
                        );
                    }
                }
            })
            .build(app)
            .map_err(|e| e.to_string())?;
        let _ = tray_manager::set_tray_indicator(&app.handle(), false);

        let app_handle = app.handle().clone();
        let _status_listener = app.listen("recording:status", move |event: tauri::Event| {
            let recording = tray_manager::parse_recording_flag(event.payload());
            let _ = tray_manager::set_tray_indicator(&app_handle, recording);
        });
        let app_handle = app.handle().clone();
        let _ui_recording_listener = app.listen("ui:recording", move |event: tauri::Event| {
            let recording = tray_manager::parse_recording_flag(event.payload());
            let _ = tray_manager::set_tray_indicator(&app_handle, recording);
        });
        Ok(())
    });

    let app = builder
        .plugin(hotkey_manager::build_global_shortcut_plugin())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_public_settings,
            pick_recording_root,
            get_macos_system_audio_permission_status,
            open_macos_system_audio_settings,
            list_text_editor_apps,
            get_computer_name,
            list_audio_input_devices,
            detect_system_source_device,
            open_settings_window,
            open_tray_window,
            open_session_folder,
            open_session_artifact,
            read_session_artifact,
            delete_session,
            delete_session_audio,
            auto_delete_old_session_audio,
            list_sessions,
            list_known_tags,
            search_session_artifacts,
            import_audio_session,
            get_ui_sync_state,
            set_ui_sync_state,
            get_live_input_levels,
            get_session_meta,
            update_session_details,
            set_api_secret,
            get_api_secret,
            start_recording,
            stop_recording,
            stop_active_recording,
            set_recording_input_muted,
            run_pipeline,
            retry_pipeline,
            run_transcription,
            run_summary,
            sync_sessions,
            check_for_update,
            open_external_url,
            yandex_sync_set_token,
            yandex_sync_clear_token,
            yandex_sync_has_token,
            yandex_sync_status,
            yandex_sync_now
        ])
        .build(tauri::generate_context!())
        .expect("error while building bigecho app");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            let main_window_visible = app_handle
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if window_manager::should_reveal_main_window_on_app_reopen(
                has_visible_windows,
                main_window_visible,
            ) {
                let _ = window_manager::focus_main_window(app_handle);
            }
        }
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod ipc_runtime_tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use serde_json::json;
    use storage::session_store::{load_meta, save_meta};
    use storage::sqlite_repo::{
        fetch_due_retry_jobs, list_session_events, list_sessions, schedule_retry_job,
        upsert_session,
    };
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    #[test]
    fn auto_pipeline_after_stop_requires_toggle_and_urls() {
        let disabled = PublicSettings::default();
        assert!(!should_auto_run_pipeline_after_stop(&disabled));

        let no_urls = PublicSettings {
            auto_run_pipeline_on_stop: true,
            transcription_url: String::new(),
            summary_url: String::new(),
            ..Default::default()
        };
        assert!(!should_auto_run_pipeline_after_stop(&no_urls));

        let ready = PublicSettings {
            transcription_url: "https://example.com/transcribe".to_string(),
            summary_url: "https://example.com/summary".to_string(),
            summary_prompt: "Есть стенограмма встречи. Подготовь краткое саммари.".to_string(),
            auto_run_pipeline_on_stop: true,
            ..Default::default()
        };
        assert!(should_auto_run_pipeline_after_stop(&ready));
    }

    #[test]
    fn preserves_raw_artifacts_in_session_dir_on_finalize_failure() {
        let temp = tempfile::tempdir().expect("tempdir");
        let session_dir = temp.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("create session dir");

        let mic_src = temp.path().join("mic.raw");
        let sys_src = temp.path().join("sys.raw");
        std::fs::write(&mic_src, [1_u8, 2, 3, 4]).expect("write mic");
        std::fs::write(&sys_src, [5_u8, 6, 7, 8]).expect("write system");

        let artifacts = crate::audio::capture::CaptureArtifacts {
            mic_path: mic_src.clone(),
            mic_rate: 48_000,
            system_path: Some(sys_src.clone()),
            system_rate: 48_000,
        };

        let preserved = preserve_capture_artifacts_for_recovery(&session_dir, &artifacts)
            .expect("preserve artifacts");

        assert!(session_dir.join("audio_recovery_mic.raw").exists());
        assert!(session_dir.join("audio_recovery_system.raw").exists());
        assert!(!mic_src.exists());
        assert!(!sys_src.exists());
        assert_eq!(preserved.len(), 2);
    }

    #[test]
    fn audio_duration_is_formatted_as_hh_mm_ss() {
        let mut meta = SessionMeta::new(
            "s-duration".to_string(),
            "slack".to_string(),
            vec!["slack".to_string()],
            "".to_string(),
            String::new(),
        );
        meta.started_at_iso = "2026-03-11T10:00:00+03:00".to_string();
        meta.ended_at_iso = Some("2026-03-11T11:02:03+03:00".to_string());
        assert_eq!(
            crate::storage::sqlite_repo::audio_duration_hms(&meta),
            "01:02:03"
        );
    }

    fn invoke_request(cmd: &str, body: serde_json::Value) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().expect("valid test url"),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    fn extract_err_string(err: serde_json::Value) -> String {
        match err {
            serde_json::Value::String(v) => v,
            other => other.to_string(),
        }
    }

    fn extract_ok_json(body: InvokeResponseBody) -> serde_json::Value {
        match body {
            InvokeResponseBody::Json(v) => {
                serde_json::from_str(&v).expect("json response should be valid")
            }
            InvokeResponseBody::Raw(v) => {
                serde_json::from_slice(v.as_ref()).expect("raw body should be valid json")
            }
        }
    }

    fn build_test_app() -> (tauri::App<tauri::test::MockRuntime>, std::path::PathBuf) {
        let mut ctx = mock_context(noop_assets());
        ctx.config_mut().identifier = "dev.bigecho.tests".to_string();
        let app_data_dir =
            std::env::temp_dir().join(format!("bigecho_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&app_data_dir).expect("create app-data");
        let dirs = AppDirs {
            app_data_dir: app_data_dir.clone(),
        };

        let app = mock_builder()
            .manage(AppState::default())
            .manage(dirs)
            .invoke_handler(tauri::generate_handler![
                get_settings,
                save_public_settings,
                pick_recording_root,
                get_macos_system_audio_permission_status,
                open_macos_system_audio_settings,
                list_text_editor_apps,
                get_computer_name,
                list_sessions,
                search_session_artifacts,
                import_audio_session,
                get_live_input_levels,
                open_session_folder,
                open_session_artifact,
                read_session_artifact,
                delete_session,
                delete_session_audio,
                auto_delete_old_session_audio,
                list_known_tags,
                get_session_meta,
                update_session_details,
                start_recording,
                stop_recording,
                stop_active_recording,
                set_recording_input_muted,
                run_pipeline,
                retry_pipeline,
                run_transcription,
                run_summary,
                sync_sessions,
                yandex_sync_set_token,
                yandex_sync_clear_token,
                yandex_sync_has_token,
                yandex_sync_status,
                yandex_sync_now
            ])
            .build(ctx)
            .expect("failed to build test app");
        (app, app_data_dir)
    }

    fn spawn_mock_pipeline_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let addr = listener.local_addr().expect("local addr");
        thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept");
                let request_line = read_http_request_line(&mut stream);
                let body = if request_line.contains("/transcribe") {
                    r#"{"text":"mock transcript"}"#
                } else if request_line.contains("/summary") {
                    r#"{"choices":[{"message":{"content":"mock summary"}}]}"#
                } else {
                    r#"{"error":"not found"}"#
                };
                write_http_json_response(&mut stream, body);
            }
        });
        format!("http://{addr}")
    }

    fn spawn_mock_pipeline_capture_server() -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let addr = listener.local_addr().expect("local addr");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured_requests = Arc::clone(&requests);
        thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                let body = if request.starts_with("POST /transcribe ") {
                    r#"{"text":"mock transcript"}"#
                } else if request.starts_with("POST /summary ") {
                    r#"{"choices":[{"message":{"content":"mock summary"}}]}"#
                } else {
                    r#"{"error":"not found"}"#
                };
                captured_requests
                    .lock()
                    .expect("lock requests")
                    .push(request);
                write_http_json_response(&mut stream, body);
            }
        });
        (format!("http://{addr}"), requests)
    }

    fn spawn_summary_capture_server() -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind summary server");
        let addr = listener.local_addr().expect("local addr");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured_requests = Arc::clone(&requests);
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let request = read_http_request(&mut stream);
            captured_requests
                .lock()
                .expect("lock requests")
                .push(request);
            write_http_json_response(
                &mut stream,
                r#"{"choices":[{"message":{"content":"mock summary"}}]}"#,
            );
        });
        (format!("http://{addr}"), requests)
    }

    fn read_http_request_line(stream: &mut TcpStream) -> String {
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut line = String::new();
        reader.read_line(&mut line).expect("read request line");

        let mut content_length = 0usize;
        loop {
            let mut header_line = String::new();
            reader
                .read_line(&mut header_line)
                .expect("read header line");
            if header_line == "\r\n" {
                break;
            }
            let lower = header_line.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("content-length:") {
                content_length = rest.trim().parse::<usize>().unwrap_or(0);
            }
        }
        if content_length > 0 {
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).expect("read request body");
        }
        line
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut request = String::new();
        let mut line = String::new();
        reader.read_line(&mut line).expect("read request line");
        request.push_str(&line);

        let mut content_length = 0usize;
        loop {
            let mut header_line = String::new();
            reader
                .read_line(&mut header_line)
                .expect("read header line");
            request.push_str(&header_line);
            if header_line == "\r\n" {
                break;
            }
            let lower = header_line.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("content-length:") {
                content_length = rest.trim().parse::<usize>().unwrap_or(0);
            }
        }
        if content_length > 0 {
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).expect("read request body");
            request.push_str(&String::from_utf8_lossy(&body));
        }
        request
    }

    fn write_http_json_response(stream: &mut TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
        stream.flush().expect("flush response");
    }

    fn request_json_payload(request: &str) -> serde_json::Value {
        let request_body = request
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        serde_json::from_str(request_body).expect("valid json payload")
    }

    fn expected_pipeline_markdown_artifact(body: &str) -> String {
        format!(
            "---\nsource: \"zoom\"\ntags:\n  - \"zoom\"\nnotes: \"Notes\"\ntopic: \"Weekly sync\"\n---\n\n{body}"
        )
    }

    fn assert_summary_request_user_content(request: &str, expected: &str) {
        let payload = request_json_payload(request);
        assert_eq!(payload["messages"][1]["content"].as_str(), Some(expected));
    }

    fn seed_pipeline_ready_session(
        app_data_dir: &std::path::Path,
        session_id: &str,
        base_url: &str,
    ) {
        let settings = PublicSettings {
            recording_root: app_data_dir
                .join("recordings")
                .to_string_lossy()
                .to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: format!("{base_url}/transcribe"),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_CORP".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
            summary_url: format!("{base_url}/summary"),
            summary_prompt: "Есть стенограмма встречи. Подготовь краткое саммари.".to_string(),
            openai_model: "gpt-4.1-mini".to_string(),
            audio_format: "opus".to_string(),
            opus_bitrate_kbps: 24,
            mic_device_name: String::new(),
            system_device_name: String::new(),
            artifact_opener_app: String::new(),
            auto_run_pipeline_on_stop: false,
            api_call_logging_enabled: false,
            auto_delete_audio_enabled: false,
            auto_delete_audio_days: 30,
            yandex_sync_enabled: false,
            yandex_sync_interval: "24h".to_string(),
            yandex_sync_remote_folder: "BigEcho".to_string(),
        };
        save_settings(app_data_dir, &settings).expect("save settings");

        let session_dir = app_data_dir.join("sessions").join(session_id);
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let meta_path = session_dir.join("meta.json");
        let mut meta = SessionMeta::new(
            session_id.to_string(),
            "zoom".to_string(),
            vec!["zoom".to_string()],
            "Weekly sync".to_string(),
            "Notes".to_string(),
        );
        meta.artifacts.audio_file =
            crate::audio::file_writer::audio_file_name(&settings.audio_format);
        meta.artifacts.transcript_file = "transcript.txt".to_string();
        meta.artifacts.summary_file = "summary.md".to_string();
        save_meta(&meta_path, &meta).expect("save meta");
        std::fs::write(session_dir.join(&meta.artifacts.audio_file), b"OggS")
            .expect("write audio fixture");
        upsert_session(app_data_dir, &meta, &session_dir, &meta_path).expect("upsert session");
    }

    fn seed_pipeline_missing_audio_session(
        app_data_dir: &std::path::Path,
        session_id: &str,
        base_url: &str,
    ) {
        let settings = PublicSettings {
            recording_root: app_data_dir
                .join("recordings")
                .to_string_lossy()
                .to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: format!("{base_url}/transcribe"),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_CORP".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
            summary_url: format!("{base_url}/summary"),
            summary_prompt: "Есть стенограмма встречи. Подготовь краткое саммари.".to_string(),
            openai_model: "gpt-4.1-mini".to_string(),
            audio_format: "opus".to_string(),
            opus_bitrate_kbps: 24,
            mic_device_name: String::new(),
            system_device_name: String::new(),
            artifact_opener_app: String::new(),
            auto_run_pipeline_on_stop: false,
            api_call_logging_enabled: false,
            auto_delete_audio_enabled: false,
            auto_delete_audio_days: 30,
            yandex_sync_enabled: false,
            yandex_sync_interval: "24h".to_string(),
            yandex_sync_remote_folder: "BigEcho".to_string(),
        };
        save_settings(app_data_dir, &settings).expect("save settings");

        let session_dir = app_data_dir.join("sessions").join(session_id);
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let meta_path = session_dir.join("meta.json");
        let mut meta = SessionMeta::new(
            session_id.to_string(),
            "zoom".to_string(),
            vec!["zoom".to_string()],
            "Weekly sync".to_string(),
            "Notes".to_string(),
        );
        meta.artifacts.audio_file = "audio.opus".to_string();
        meta.artifacts.transcript_file = "transcript.txt".to_string();
        meta.artifacts.summary_file = "summary.md".to_string();
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(app_data_dir, &meta, &session_dir, &meta_path).expect("upsert session");
    }

    #[test]
    fn invoke_start_allows_empty_topic() {
        let (app, _) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let response = get_ipc_response(
            &webview,
            invoke_request(
                "start_recording",
                json!({
                    "payload": {"source":"", "tags":["zoom"], "topic":"", "notes":""}
                }),
            ),
        );
        let out = extract_ok_json(response.expect("command must succeed"));
        let parsed: StartRecordingResponse = serde_json::from_value(out).expect("parse response");
        assert!(!parsed.session_id.is_empty());
        assert_eq!(parsed.status, "recording");
    }

    #[test]
    fn invoke_update_session_details_persists_values() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");

        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_ready_session(&app_data_dir, "session-details", &base_url);
        let session_dir = app_data_dir.join("sessions").join("session-details");
        std::fs::write(
            session_dir.join("transcript.txt"),
            expected_pipeline_markdown_artifact("Original transcript"),
        )
        .expect("write transcript");
        std::fs::write(
            session_dir.join("summary.md"),
            expected_pipeline_markdown_artifact("Original summary"),
        )
        .expect("write summary");

        let update_response = get_ipc_response(
            &webview,
            invoke_request(
                "update_session_details",
                json!({
                    "payload": {
                        "session_id":"session-details",
                        "source":" telegram ",
                        "notes":" Follow up on renewal ",
                        "customSummaryPrompt":" Сделай саммари только по решениям ",
                        "topic":" ",
                        "tags":[" renewal ", "client-a", "renewal", " "]
                    }
                }),
            ),
        );
        let update_out = extract_ok_json(update_response.expect("update should succeed"));
        assert_eq!(update_out, serde_json::Value::String("updated".to_string()));

        let get_response = get_ipc_response(
            &webview,
            invoke_request("get_session_meta", json!({ "sessionId":"session-details" })),
        );
        let get_out = extract_ok_json(get_response.expect("get should succeed"));
        let details = get_out.as_object().expect("session details object");
        assert_eq!(details["source"], "telegram");
        assert_eq!(details["notes"], "Follow up on renewal");
        assert_eq!(
            details["custom_summary_prompt"],
            "Сделай саммари только по решениям"
        );
        assert_eq!(details["topic"], "");
        assert_eq!(
            serde_json::from_value::<Vec<String>>(details["tags"].clone()).expect("tags"),
            vec!["client-a".to_string(), "renewal".to_string()]
        );
        let transcript =
            std::fs::read_to_string(session_dir.join("transcript.txt")).expect("read transcript");
        assert!(transcript.contains("source: \"telegram\"\n"));
        assert!(transcript.contains("  - \"client-a\"\n  - \"renewal\"\n"));
        assert!(transcript.contains("notes: \"Follow up on renewal\"\n"));
        assert!(transcript.ends_with("Original transcript"));
        let summary =
            std::fs::read_to_string(session_dir.join("summary.md")).expect("read summary");
        assert!(summary.contains("source: \"telegram\"\n"));
        assert!(summary.ends_with("Original summary"));
    }

    #[test]
    fn invoke_stop_rejects_without_active_session() {
        let (app, _) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let response = get_ipc_response(
            &webview,
            invoke_request("stop_recording", json!({ "sessionId":"missing-session" })),
        );
        let err = response.expect_err("command must fail");
        assert_eq!(extract_err_string(err), "No active recording session");
    }

    #[test]
    fn invoke_pipeline_rejects_unknown_session() {
        let (app, _) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let response = get_ipc_response(
            &webview,
            invoke_request("run_pipeline", json!({ "sessionId":"missing-session" })),
        );
        let err = response.expect_err("command must fail");
        assert_eq!(extract_err_string(err), "Session not found");
    }

    #[test]
    fn invoke_pipeline_success_writes_transcript_and_summary() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let (base_url, requests) = spawn_mock_pipeline_capture_server();
        seed_pipeline_ready_session(&app_data_dir, "session-success", &base_url);
        let mut settings = load_settings(&app_data_dir).expect("load settings");
        settings.api_call_logging_enabled = true;
        save_settings(&app_data_dir, &settings).expect("save settings");

        let response = get_ipc_response(
            &webview,
            invoke_request("run_pipeline", json!({ "sessionId":"session-success" })),
        )
        .expect("run_pipeline should succeed");
        assert_eq!(
            response.deserialize::<String>().expect("done string"),
            "done".to_string()
        );

        let session_dir = app_data_dir.join("sessions").join("session-success");
        let transcript =
            std::fs::read_to_string(session_dir.join("transcript.txt")).expect("read transcript");
        let summary =
            std::fs::read_to_string(session_dir.join("summary.md")).expect("read summary");
        assert_eq!(
            transcript,
            expected_pipeline_markdown_artifact("mock transcript")
        );
        assert_eq!(summary, expected_pipeline_markdown_artifact("mock summary"));
        let captured = requests.lock().expect("lock requests");
        let summary_request = captured
            .iter()
            .find(|request| request.starts_with("POST /summary "))
            .expect("summary request should be captured");
        assert_summary_request_user_content(summary_request, "mock transcript");
        let api_log =
            std::fs::read_to_string(session_dir.join("api_calls.txt")).expect("read api_calls.txt");
        assert!(api_log.contains("api_transcription_request"));
        assert!(api_log.contains("api_transcription_success"));
        assert!(api_log.contains("api_summary_request"));
        assert!(api_log.contains("api_summary_success"));
        assert!(api_log.contains("api_http_request"));
        assert!(api_log.contains("api_http_response"));
        assert!(api_log.contains("method: POST"));
        assert!(api_log.contains(&format!("url: {base_url}/transcribe")));
        assert!(api_log.contains(&format!("url: {base_url}/summary")));
        assert!(api_log.contains("status: 200 OK"));
        assert!(api_log.contains("\"text\": \"mock transcript\""));
        assert!(api_log.contains("\"content\": \"mock summary\""));

        let meta = load_meta(&session_dir.join("meta.json")).expect("load meta");
        assert_eq!(meta.status, SessionStatus::Done);

        let listed = list_sessions(&app_data_dir).expect("list sessions");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, "done");

        let due_retry =
            fetch_due_retry_jobs(&app_data_dir, i64::MAX, 10).expect("fetch retry jobs");
        assert!(due_retry.is_empty());

        let events = list_session_events(&app_data_dir, "session-success").expect("load events");
        assert!(events
            .iter()
            .any(|e| e.event_type == "api_transcription_request"));
        assert!(events
            .iter()
            .any(|e| e.event_type == "api_transcription_success"));
        assert!(events.iter().any(|e| e.event_type == "api_summary_request"));
        assert!(events.iter().any(|e| e.event_type == "api_summary_success"));
    }

    #[test]
    fn invoke_retry_pipeline_success_writes_transcript_and_summary() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_ready_session(&app_data_dir, "session-retry-success", &base_url);

        let response = get_ipc_response(
            &webview,
            invoke_request(
                "retry_pipeline",
                json!({ "sessionId":"session-retry-success" }),
            ),
        )
        .expect("retry_pipeline should succeed");
        assert_eq!(
            response.deserialize::<String>().expect("done string"),
            "done".to_string()
        );

        let session_dir = app_data_dir.join("sessions").join("session-retry-success");
        let transcript =
            std::fs::read_to_string(session_dir.join("transcript.txt")).expect("read transcript");
        let summary =
            std::fs::read_to_string(session_dir.join("summary.md")).expect("read summary");
        assert_eq!(
            transcript,
            expected_pipeline_markdown_artifact("mock transcript")
        );
        assert_eq!(summary, expected_pipeline_markdown_artifact("mock summary"));

        let listed = list_sessions(&app_data_dir).expect("list sessions");
        assert_eq!(listed[0].status, "done");
    }

    #[test]
    fn invoke_run_transcription_writes_only_transcript() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_ready_session(&app_data_dir, "session-get-text", &base_url);

        let response = get_ipc_response(
            &webview,
            invoke_request(
                "run_transcription",
                json!({ "sessionId":"session-get-text" }),
            ),
        )
        .expect("run_transcription should succeed");
        assert_eq!(
            response
                .deserialize::<String>()
                .expect("transcribed string"),
            "transcribed".to_string()
        );

        let session_dir = app_data_dir.join("sessions").join("session-get-text");
        let transcript =
            std::fs::read_to_string(session_dir.join("transcript.txt")).expect("read transcript");
        assert_eq!(
            transcript,
            expected_pipeline_markdown_artifact("mock transcript")
        );
        assert!(!session_dir.join("summary.md").exists());

        let listed = list_sessions(&app_data_dir).expect("list sessions");
        assert_eq!(listed[0].status, "transcribed");
    }

    #[test]
    fn invoke_run_summary_from_existing_transcript() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let (base_url, requests) = spawn_summary_capture_server();
        seed_pipeline_ready_session(&app_data_dir, "session-summary-only", &base_url);
        let session_dir = app_data_dir.join("sessions").join("session-summary-only");
        std::fs::write(
            session_dir.join("transcript.txt"),
            expected_pipeline_markdown_artifact("existing transcript"),
        )
        .expect("write transcript");

        let response = get_ipc_response(
            &webview,
            invoke_request("run_summary", json!({ "sessionId":"session-summary-only" })),
        )
        .expect("run_summary should succeed");
        assert_eq!(
            response.deserialize::<String>().expect("done string"),
            "done".to_string()
        );

        let summary =
            std::fs::read_to_string(session_dir.join("summary.md")).expect("read summary");
        assert_eq!(summary, expected_pipeline_markdown_artifact("mock summary"));
        let captured = requests.lock().expect("lock requests");
        assert_summary_request_user_content(&captured[0], "existing transcript");
    }

    #[test]
    fn invoke_run_summary_uses_explicit_custom_prompt() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let (base_url, requests) = spawn_summary_capture_server();
        seed_pipeline_ready_session(&app_data_dir, "session-summary-custom", &base_url);
        let session_dir = app_data_dir.join("sessions").join("session-summary-custom");
        std::fs::write(session_dir.join("transcript.txt"), "existing transcript")
            .expect("write transcript");

        let response = get_ipc_response(
            &webview,
            invoke_request(
                "run_summary",
                json!({
                    "sessionId":"session-summary-custom",
                    "customPrompt":"Сделай саммари только по рискам и решениям"
                }),
            ),
        )
        .expect("run_summary should succeed");
        assert_eq!(
            response.deserialize::<String>().expect("done string"),
            "done".to_string()
        );

        let captured = requests.lock().expect("lock requests");
        let request_body = captured[0]
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value =
            serde_json::from_str(request_body).expect("valid json payload");
        assert_eq!(
            payload["messages"][0]["content"].as_str(),
            Some("Сделай саммари только по рискам и решениям")
        );
    }

    #[test]
    fn invoke_run_summary_uses_persisted_session_prompt_when_override_is_missing() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let (base_url, requests) = spawn_summary_capture_server();
        seed_pipeline_ready_session(&app_data_dir, "session-summary-persisted", &base_url);
        let session_dir = app_data_dir
            .join("sessions")
            .join("session-summary-persisted");
        std::fs::write(session_dir.join("transcript.txt"), "existing transcript")
            .expect("write transcript");

        let meta_path = session_dir.join("meta.json");
        let mut meta = load_meta(&meta_path).expect("load meta");
        meta.custom_summary_prompt = "Сделай саммари только по action items".to_string();
        save_meta(&meta_path, &meta).expect("save meta");

        let response = get_ipc_response(
            &webview,
            invoke_request(
                "run_summary",
                json!({ "sessionId":"session-summary-persisted" }),
            ),
        )
        .expect("run_summary should succeed");
        assert_eq!(
            response.deserialize::<String>().expect("done string"),
            "done".to_string()
        );

        let captured = requests.lock().expect("lock requests");
        let request_body = captured[0]
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value =
            serde_json::from_str(request_body).expect("valid json payload");
        assert_eq!(
            payload["messages"][0]["content"].as_str(),
            Some("Сделай саммари только по action items")
        );
    }

    #[test]
    fn invoke_run_summary_without_custom_prompt_uses_settings_prompt() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let (base_url, requests) = spawn_summary_capture_server();
        seed_pipeline_ready_session(&app_data_dir, "session-summary-default", &base_url);
        let session_dir = app_data_dir
            .join("sessions")
            .join("session-summary-default");
        std::fs::write(session_dir.join("transcript.txt"), "existing transcript")
            .expect("write transcript");

        let response = get_ipc_response(
            &webview,
            invoke_request(
                "run_summary",
                json!({ "sessionId":"session-summary-default" }),
            ),
        )
        .expect("run_summary should succeed");
        assert_eq!(
            response.deserialize::<String>().expect("done string"),
            "done".to_string()
        );

        let captured = requests.lock().expect("lock requests");
        let request_body = captured[0]
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value =
            serde_json::from_str(request_body).expect("valid json payload");
        assert_eq!(
            payload["messages"][0]["content"].as_str(),
            Some("Есть стенограмма встречи. Подготовь краткое саммари.")
        );
    }

    #[test]
    fn invoke_retry_pipeline_audio_missing_schedules_retry_job() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");

        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_missing_audio_session(&app_data_dir, "session-retry-failed", &base_url);

        let response = get_ipc_response(
            &webview,
            invoke_request(
                "retry_pipeline",
                json!({ "sessionId":"session-retry-failed" }),
            ),
        );
        let err = response.expect_err("retry_pipeline should fail");
        assert_eq!(extract_err_string(err), "Audio file is missing");

        let due_retry =
            fetch_due_retry_jobs(&app_data_dir, i64::MAX, 10).expect("fetch retry jobs");
        assert_eq!(due_retry.len(), 1);
        assert_eq!(due_retry[0].session_id, "session-retry-failed");
        assert_eq!(due_retry[0].attempts, 1);
    }

    #[test]
    fn invoke_delete_session_removes_catalog_and_db_record() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_ready_session(&app_data_dir, "session-delete", &base_url);

        let session_dir = app_data_dir.join("sessions").join("session-delete");
        assert!(session_dir.exists());
        assert_eq!(
            list_sessions(&app_data_dir).expect("list sessions").len(),
            1
        );

        let response = get_ipc_response(
            &webview,
            invoke_request("delete_session", json!({ "sessionId":"session-delete" })),
        )
        .expect("delete_session should succeed");
        assert_eq!(
            response.deserialize::<String>().expect("deleted string"),
            "deleted".to_string()
        );

        assert!(!session_dir.exists());
        assert!(list_sessions(&app_data_dir)
            .expect("list sessions")
            .is_empty());
        assert!(list_session_events(&app_data_dir, "session-delete")
            .expect("load events")
            .is_empty());
    }

    #[test]
    fn invoke_delete_session_force_allows_active_session_cleanup() {
        let (app, app_data_dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_ready_session(&app_data_dir, "session-delete-active", &base_url);

        {
            let state = app.state::<AppState>();
            let mut active = state.active_session.lock().expect("active session lock");
            *active = Some(SessionMeta::new(
                "session-delete-active".to_string(),
                "zoom".to_string(),
                vec!["zoom".to_string()],
                "Broken active".to_string(),
                String::new(),
            ));
        }

        let blocked = get_ipc_response(
            &webview,
            invoke_request(
                "delete_session",
                json!({ "sessionId":"session-delete-active" }),
            ),
        )
        .expect_err("delete_session without force should fail");
        assert_eq!(
            extract_err_string(blocked),
            "Cannot delete active recording session"
        );

        let response = get_ipc_response(
            &webview,
            invoke_request(
                "delete_session",
                json!({ "sessionId":"session-delete-active", "force": true }),
            ),
        )
        .expect("forced delete_session should succeed");
        assert_eq!(
            response.deserialize::<String>().expect("deleted string"),
            "deleted".to_string()
        );

        let state = app.state::<AppState>();
        let active = state.active_session.lock().expect("active session lock");
        assert!(active.is_none());
        assert!(!app_data_dir
            .join("sessions")
            .join("session-delete-active")
            .exists());
    }

    #[test]
    fn retry_worker_exhausts_attempts_and_clears_job() {
        let app_data_dir =
            std::env::temp_dir().join(format!("bigecho_worker_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&app_data_dir).expect("create app data");
        let dirs = AppDirs {
            app_data_dir: app_data_dir.clone(),
        };

        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_missing_audio_session(&app_data_dir, "session-worker-exhaust", &base_url);

        for _ in 0..MAX_PIPELINE_RETRY_ATTEMPTS {
            let _ = schedule_retry_job(
                &app_data_dir,
                "session-worker-exhaust",
                "seed retry",
                MAX_PIPELINE_RETRY_ATTEMPTS,
            )
            .expect("seed retry attempt");
        }

        let initial_jobs =
            fetch_due_retry_jobs(&app_data_dir, i64::MAX, 10).expect("fetch initial jobs");
        assert_eq!(initial_jobs.len(), 1);
        assert_eq!(initial_jobs[0].attempts, MAX_PIPELINE_RETRY_ATTEMPTS);

        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let result = rt.block_on(run_pipeline_core(
            dirs.clone(),
            "session-worker-exhaust",
            PipelineInvocation::WorkerRetry,
            PipelineMode::Full,
            None,
        ));
        let err = result.expect_err("worker run should fail without audio");
        assert_eq!(err, "Audio file is missing");

        schedule_retry_for_session(&app_data_dir, "session-worker-exhaust", &err)
            .expect("schedule followup retry");
        let final_jobs =
            fetch_due_retry_jobs(&app_data_dir, i64::MAX, 10).expect("fetch final jobs");
        assert!(final_jobs.is_empty());

        let events =
            list_session_events(&app_data_dir, "session-worker-exhaust").expect("load event log");
        assert!(events
            .iter()
            .any(|e| e.event_type == "pipeline_retry_exhausted"));
    }

    #[test]
    fn retry_worker_process_once_handles_partial_failures() {
        let app_data_dir =
            std::env::temp_dir().join(format!("bigecho_worker_mix_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&app_data_dir).expect("create app data");
        let dirs = AppDirs {
            app_data_dir: app_data_dir.clone(),
        };

        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_ready_session(&app_data_dir, "session-worker-ok", &base_url);
        seed_pipeline_missing_audio_session(&app_data_dir, "session-worker-fail", &base_url);

        schedule_retry_job(
            &app_data_dir,
            "session-worker-ok",
            "seed retry",
            MAX_PIPELINE_RETRY_ATTEMPTS,
        )
        .expect("schedule ok");
        schedule_retry_job(
            &app_data_dir,
            "session-worker-fail",
            "seed retry",
            MAX_PIPELINE_RETRY_ATTEMPTS,
        )
        .expect("schedule fail");

        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(process_retry_jobs_once(&dirs, i64::MAX, 10))
            .expect("process retry jobs");

        let ok_meta = load_meta(
            &app_data_dir
                .join("sessions")
                .join("session-worker-ok")
                .join("meta.json"),
        )
        .expect("load ok meta");
        let fail_meta = load_meta(
            &app_data_dir
                .join("sessions")
                .join("session-worker-fail")
                .join("meta.json"),
        )
        .expect("load fail meta");
        assert_eq!(ok_meta.status, SessionStatus::Done);
        assert_eq!(fail_meta.status, SessionStatus::Failed);

        let due_jobs = fetch_due_retry_jobs(&app_data_dir, i64::MAX, 10).expect("fetch jobs");
        assert_eq!(due_jobs.len(), 1);
        assert_eq!(due_jobs[0].session_id, "session-worker-fail");
        assert_eq!(due_jobs[0].attempts, 2);

        let ok_events = list_session_events(&app_data_dir, "session-worker-ok").expect("ok events");
        let fail_events =
            list_session_events(&app_data_dir, "session-worker-fail").expect("fail events");
        assert!(ok_events
            .iter()
            .any(|e| e.event_type == "pipeline_retry_success"));
        assert!(fail_events
            .iter()
            .any(|e| e.event_type == "pipeline_retry_scheduled"));
    }

    #[test]
    fn retry_worker_process_once_respects_limit() {
        let app_data_dir =
            std::env::temp_dir().join(format!("bigecho_worker_limit_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&app_data_dir).expect("create app data");
        let dirs = AppDirs {
            app_data_dir: app_data_dir.clone(),
        };

        let base_url = spawn_mock_pipeline_server();
        seed_pipeline_missing_audio_session(&app_data_dir, "session-limit-a", &base_url);
        seed_pipeline_missing_audio_session(&app_data_dir, "session-limit-b", &base_url);

        schedule_retry_job(
            &app_data_dir,
            "session-limit-a",
            "seed retry",
            MAX_PIPELINE_RETRY_ATTEMPTS,
        )
        .expect("schedule a");
        schedule_retry_job(
            &app_data_dir,
            "session-limit-b",
            "seed retry",
            MAX_PIPELINE_RETRY_ATTEMPTS,
        )
        .expect("schedule b");

        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(process_retry_jobs_once(&dirs, i64::MAX, 1))
            .expect("process retry jobs");

        let due_jobs = fetch_due_retry_jobs(&app_data_dir, i64::MAX, 10).expect("fetch jobs");
        assert_eq!(due_jobs.len(), 2);
        let attempts = due_jobs.iter().map(|j| j.attempts).collect::<Vec<_>>();
        assert!(attempts.contains(&1));
        assert!(attempts.contains(&2));

        let events_a = list_session_events(&app_data_dir, "session-limit-a").expect("events a");
        let events_b = list_session_events(&app_data_dir, "session-limit-b").expect("events b");
        let scheduled_count = events_a
            .iter()
            .chain(events_b.iter())
            .filter(|e| e.event_type == "pipeline_retry_scheduled")
            .count();
        assert_eq!(scheduled_count, 1);
    }

    #[test]
    fn invoke_yandex_sync_now_errors_when_already_running() {
        let (app, _dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        {
            let state = app.state::<AppState>();
            let mut g = state.yandex_sync.lock().expect("yandex_sync lock");
            g.is_running = true;
        }
        let response =
            get_ipc_response(&webview, invoke_request("yandex_sync_now", serde_json::json!({})));
        let err = response.expect_err("should fail");
        assert_eq!(extract_err_string(err), "Yandex sync already running");
    }

    #[test]
    fn invoke_yandex_sync_status_returns_current_snapshot() {
        let (app, _dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let response = get_ipc_response(
            &webview,
            invoke_request("yandex_sync_status", serde_json::json!({})),
        )
        .expect("status must succeed");
        let value = extract_ok_json(response);
        assert_eq!(value["is_running"], serde_json::Value::Bool(false));
        assert!(value["last_run"].is_null());
    }

    #[test]
    fn invoke_yandex_sync_has_token_returns_false_when_unset() {
        let (app, _dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let response = get_ipc_response(
            &webview,
            invoke_request("yandex_sync_has_token", serde_json::json!({})),
        )
        .expect("has_token must succeed");
        let value = extract_ok_json(response);
        assert_eq!(value, serde_json::Value::Bool(false));
    }

    #[test]
    fn invoke_yandex_sync_set_then_has_token() {
        let (app, _dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let set = get_ipc_response(
            &webview,
            invoke_request("yandex_sync_set_token", serde_json::json!({ "token": "abc" })),
        );
        assert!(set.is_ok());
        let response = get_ipc_response(
            &webview,
            invoke_request("yandex_sync_has_token", serde_json::json!({})),
        )
        .expect("has_token must succeed");
        let value = extract_ok_json(response);
        assert_eq!(value, serde_json::Value::Bool(true));
    }
}
