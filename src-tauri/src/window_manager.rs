use crate::app_state::{AppDirs, AppState};
use crate::settings::public_settings::load_settings;
use crate::tray_manager::{
    apply_app_icons_for_theme, mark_tray_hidden_now, mark_tray_visible, position_tray_popover,
    register_tray_window_events, resolve_system_theme, set_tray_indicator,
    should_hide_tray_when_main_window_focuses,
};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub(crate) const LIVE_LEVELS_IDLE_POLL_MS: u64 = 260;

// ── Close-to-tray ────────────────────────────────────────────────────────────

fn should_intercept_close_to_tray(window_label: &str) -> bool {
    window_label == "main"
}

pub(crate) fn register_close_to_tray_for_main(app: &AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        let label = main_window.label().to_string();
        let window_for_event = main_window.clone();
        main_window.on_window_event(move |event| {
            if let tauri::WindowEvent::ThemeChanged(theme) = event {
                let app = window_for_event.app_handle();
                let _ = apply_app_icons_for_theme(&app, theme.clone());
                let state = app.state::<AppState>();
                let is_recording = crate::tray_manager::is_recording_active(state.inner());
                let _ = set_tray_indicator(&app, is_recording);
            }
            if let tauri::WindowEvent::Focused(focused) = event {
                if should_hide_tray_when_main_window_focuses(*focused) {
                    let app = window_for_event.app_handle();
                    let _ = hide_tray_window(&app);
                }
            }
            if !should_intercept_close_to_tray(&label) {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_for_event.hide();
            }
        });
    }
}

// ── Window focus / visibility ────────────────────────────────────────────────

pub(crate) fn hide_tray_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray") {
        if window.is_visible().map_err(|e| e.to_string())? {
            window.hide().map_err(|e| e.to_string())?;
            mark_tray_hidden_now();
        }
    }
    Ok(())
}

pub(crate) fn focus_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        hide_tray_window(app)?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn toggle_tray_window_visibility(
    app: &AppHandle,
    anchor: Option<PhysicalPosition<f64>>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray") {
        let is_visible = window.is_visible().map_err(|e| e.to_string())?;
        let is_focused = window.is_focused().map_err(|e| e.to_string())?;
        if crate::tray_manager::should_hide_tray_popover_on_toggle_request(is_visible, is_focused) {
            window.hide().map_err(|e| e.to_string())?;
            mark_tray_hidden_now();
        } else {
            if let Some(anchor) = anchor {
                let _ = position_tray_popover(&window, anchor);
            }
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            mark_tray_visible();
        }
        return Ok(());
    }
    open_tray_window_internal(app)?;
    if let Some(window) = app.get_webview_window("tray") {
        if let Some(anchor) = anchor {
            let _ = position_tray_popover(&window, anchor);
        }
    }
    mark_tray_visible();
    Ok(())
}

// ── Window creation ───────────────────────────────────────────────────────────

pub(crate) fn open_settings_window_internal(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = apply_app_icons_for_theme(app, resolve_system_theme(app));
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window =
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
            .title("BigEcho Settings")
            .inner_size(720.0, 620.0)
            .resizable(true)
            .build()
            .map_err(|e| e.to_string())?;
    let _ = apply_app_icons_for_theme(app, resolve_system_theme(app));
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn open_tray_window_internal(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray") {
        let _ = apply_app_icons_for_theme(app, resolve_system_theme(app));
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        mark_tray_visible();
        return Ok(());
    }

    let mut builder =
        WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("index.html".into()))
            .title("BigEcho Recorder")
            .inner_size(430.0, 200.0)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(false)
            .shadow(false)
            .transparent(true)
            .visible_on_all_workspaces(true);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    register_tray_window_events(&window);
    let _ = apply_app_icons_for_theme(app, resolve_system_theme(app));
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    mark_tray_visible();
    Ok(())
}

pub(crate) fn prewarm_tray_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("tray").is_some() {
        return Ok(());
    }

    let mut builder =
        WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("index.html".into()))
            .title("BigEcho Recorder")
            .inner_size(430.0, 200.0)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(false)
            .shadow(false)
            .transparent(true)
            .visible_on_all_workspaces(true);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    register_tray_window_events(&window);
    let _ = apply_app_icons_for_theme(app, resolve_system_theme(app));
    // Start the idle countdown immediately after prewarm. If the user never
    // opens the tray, its WebView gets released after TRAY_IDLE_CLOSE_AFTER.
    mark_tray_hidden_now();
    Ok(())
}

// ── Start-hidden policy ──────────────────────────────────────────────────────

pub(crate) fn should_start_hidden_on_launch(value: Option<&str>, default_hidden: bool) -> bool {
    match value {
        None => default_hidden,
        Some(raw) => {
            let normalized = raw.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "no" | "off")
        }
    }
}

pub(crate) fn should_start_hidden_on_launch_from_env() -> bool {
    let env_value = std::env::var("BIGECHO_START_HIDDEN").ok();
    let default_hidden = !cfg!(debug_assertions);
    should_start_hidden_on_launch(env_value.as_deref(), default_hidden)
}

// ── App-reopen policy ────────────────────────────────────────────────────────

pub(crate) fn should_reveal_main_window_on_app_reopen(
    has_visible_windows: bool,
    main_window_visible: bool,
) -> bool {
    !has_visible_windows && !main_window_visible
}

// ── Live-levels worker ───────────────────────────────────────────────────────

fn should_probe_idle_levels(recording_active: bool, tray_visible: bool) -> bool {
    !recording_active && tray_visible
}

pub(crate) fn spawn_live_levels_worker(app: AppHandle, dirs: AppDirs) {
    tauri::async_runtime::spawn(async move {
        loop {
            let recording_active = {
                let state = app.state::<AppState>();
                crate::tray_manager::is_recording_active(state.inner())
            };
            let tray_visible = app
                .get_webview_window("tray")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);

            if should_probe_idle_levels(recording_active, tray_visible) {
                let settings = load_settings(&dirs.app_data_dir).ok();
                let (mic_name, system_name) = if let Some(settings) = settings {
                    let mic = settings.mic_device_name.trim().to_string();
                    let system = settings.system_device_name.trim().to_string();
                    (
                        if mic.is_empty() { None } else { Some(mic) },
                        if system.is_empty() {
                            None
                        } else {
                            Some(system)
                        },
                    )
                } else {
                    (None, None)
                };
                let probe_result = tauri::async_runtime::spawn_blocking(move || {
                    crate::audio::capture::probe_levels(
                        mic_name.as_deref(),
                        system_name.as_deref(),
                    )
                })
                .await
                .ok()
                .and_then(Result::ok);

                let state = app.state::<AppState>();
                if let Some(levels) = probe_result {
                    state.live_levels.set_mic(levels.mic);
                    state.live_levels.set_system(levels.system);
                } else {
                    state.live_levels.reset();
                }
            } else if !recording_active {
                let state = app.state::<AppState>();
                state.live_levels.reset();
            }
            tokio::time::sleep(std::time::Duration::from_millis(LIVE_LEVELS_IDLE_POLL_MS)).await;
        }
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_to_tray_intercepts_only_main_window() {
        assert!(should_intercept_close_to_tray("main"));
        assert!(!should_intercept_close_to_tray("settings"));
    }

    #[test]
    fn start_hidden_env_policy_respects_debug_default() {
        assert!(!should_start_hidden_on_launch(None, false));
        assert!(should_start_hidden_on_launch(None, true));
        assert!(should_start_hidden_on_launch(Some("1"), false));
        assert!(should_start_hidden_on_launch(Some("true"), false));
        assert!(!should_start_hidden_on_launch(Some("0"), true));
        assert!(!should_start_hidden_on_launch(Some("false"), true));
    }

    #[test]
    fn app_reopen_reveals_main_only_when_no_window_is_visible() {
        assert!(should_reveal_main_window_on_app_reopen(false, false));
        assert!(!should_reveal_main_window_on_app_reopen(true, false));
        assert!(!should_reveal_main_window_on_app_reopen(false, true));
    }

    #[test]
    fn idle_levels_probe_requires_visible_tray_window() {
        assert!(should_probe_idle_levels(false, true));
        assert!(!should_probe_idle_levels(false, false));
        assert!(!should_probe_idle_levels(true, true));
    }
}
