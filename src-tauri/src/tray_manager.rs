use crate::app_state::AppState;
use tauri::{AppHandle, Manager, PhysicalPosition, Position, Theme};

// ── Icon assets ──────────────────────────────────────────────────────────────

pub(crate) const TRAY_ICON_ID: &str = "bigecho-tray";

const APP_ICON_LIGHT_BYTES: &[u8] = include_bytes!("../icons/app-icon-light.png");
const APP_ICON_DARK_BYTES: &[u8] = include_bytes!("../icons/app-icon-dark.png");
const TRAY_IDLE_LIGHT_BYTES: &[u8] = include_bytes!("../icons/tray-idle-light.png");
const TRAY_IDLE_DARK_BYTES: &[u8] = include_bytes!("../icons/tray-idle-dark.png");
const TRAY_REC_DARK_BYTES: &[u8] = include_bytes!("../icons/tray-rec-dark.png");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrayIconVariant {
    IdleLight,
    IdleDark,
    RecDark,
}

pub(crate) fn tray_icon_bytes(variant: TrayIconVariant) -> &'static [u8] {
    match variant {
        TrayIconVariant::IdleLight => TRAY_IDLE_LIGHT_BYTES,
        TrayIconVariant::IdleDark => TRAY_IDLE_DARK_BYTES,
        TrayIconVariant::RecDark => TRAY_REC_DARK_BYTES,
    }
}

pub(crate) fn app_icon_bytes(theme: Theme) -> &'static [u8] {
    match theme {
        Theme::Dark => APP_ICON_DARK_BYTES,
        _ => APP_ICON_LIGHT_BYTES,
    }
}

pub(crate) fn load_png_icon(
    bytes: &'static [u8],
) -> Result<tauri::image::Image<'static>, String> {
    tauri::image::Image::from_bytes(bytes)
        .map(|image| image.to_owned())
        .map_err(|e| format!("failed to decode icon: {e}"))
}

pub(crate) fn choose_tray_icon_variant(theme: Theme, is_recording: bool) -> TrayIconVariant {
    if is_recording {
        return TrayIconVariant::RecDark;
    }
    match theme {
        Theme::Dark => TrayIconVariant::IdleDark,
        _ => TrayIconVariant::IdleLight,
    }
}

// ── Theme / icon helpers ─────────────────────────────────────────────────────

pub(crate) fn resolve_system_theme(app: &AppHandle) -> Theme {
    for label in ["main", "tray", "settings"] {
        if let Some(window) = app.get_webview_window(label) {
            if let Ok(theme) = window.theme() {
                return theme;
            }
        }
    }
    Theme::Light
}

pub(crate) fn apply_app_icons_for_theme(app: &AppHandle, theme: Theme) -> Result<(), String> {
    let icon = load_png_icon(app_icon_bytes(theme))?;
    for label in ["main", "tray", "settings"] {
        if let Some(window) = app.get_webview_window(label) {
            window.set_icon(icon.clone()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Tray indicator ───────────────────────────────────────────────────────────

pub(crate) fn is_recording_active(state: &AppState) -> bool {
    state
        .active_session
        .lock()
        .map(|session| session.is_some())
        .unwrap_or(false)
}

pub(crate) fn set_tray_indicator(app: &AppHandle, is_recording: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        let tooltip = if is_recording {
            "BigEcho REC"
        } else {
            "BigEcho IDLE"
        };
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
        let theme = resolve_system_theme(app);
        let icon = load_png_icon(tray_icon_bytes(choose_tray_icon_variant(
            theme,
            is_recording,
        )))?;
        tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        tray.set_icon_as_template(false)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn set_tray_indicator_from_state(state: &AppState, is_recording: bool) {
    let app_handle = state
        .tray_app
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().cloned());
    if let Some(app) = app_handle {
        let _ = set_tray_indicator(&app, is_recording);
    }
}

// ── Tray idle-release ────────────────────────────────────────────────────────
//
// The tray popover is prewarmed at startup so the first click is instant.
// A live WebView on macOS costs ~200–400 MB, which adds up if the user
// never (or rarely) opens the tray. To keep the fast first-click without
// bloating RAM over long sessions we:
//   1. Track the moment the tray was last hidden.
//   2. A background ticker runs every TRAY_IDLE_CHECK_INTERVAL; if the tray
//      has been continuously hidden for TRAY_IDLE_CLOSE_AFTER, we `.close()`
//      the window so the WebView process can release its memory.
//   3. Next click goes through the normal lazy `open_tray_window_internal`
//      path, which rebuilds the window on demand.

static TRAY_HIDDEN_SINCE: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);
const TRAY_IDLE_CLOSE_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const TRAY_IDLE_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

pub(crate) fn mark_tray_hidden_now() {
    if let Ok(mut guard) = TRAY_HIDDEN_SINCE.lock() {
        *guard = Some(std::time::Instant::now());
    }
}

pub(crate) fn mark_tray_visible() {
    if let Ok(mut guard) = TRAY_HIDDEN_SINCE.lock() {
        *guard = None;
    }
}

fn tray_has_been_hidden_longer_than(min_age: std::time::Duration) -> bool {
    let guard = match TRAY_HIDDEN_SINCE.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    match *guard {
        None => false,
        Some(t) => t.elapsed() >= min_age,
    }
}

pub(crate) fn spawn_tray_idle_release_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TRAY_IDLE_CHECK_INTERVAL).await;
            if !tray_has_been_hidden_longer_than(TRAY_IDLE_CLOSE_AFTER) {
                continue;
            }
            let Some(window) = app.get_webview_window("tray") else {
                mark_tray_visible();
                continue;
            };
            let is_visible = window.is_visible().unwrap_or(true);
            if is_visible {
                mark_tray_visible();
                continue;
            }
            if window.close().is_ok() {
                mark_tray_visible();
            }
        }
    });
}

// ── Tray window event registration ──────────────────────────────────────────

pub(crate) fn register_tray_window_events(window: &tauri::WebviewWindow) {
    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(focused) = event {
            if should_hide_tray_popover_on_focus_lost(*focused) {
                if window_for_event.hide().is_ok() {
                    mark_tray_hidden_now();
                }
            }
        }
    });
}

// ── macOS app menu ───────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub(crate) fn build_macos_app_menu(
    app: &tauri::App,
) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let app_submenu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None::<&str>, Some(about_metadata))
                .map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &MenuItem::with_id(
                app,
                "app_settings",
                "Settings",
                true,
                Some("CmdOrCtrl+," as &str),
            )
            .map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::services(app, None::<&str>).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::hide(app, None::<&str>).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::hide_others(app, None::<&str>).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::quit(app, None::<&str>).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;

    let window_menu = Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None::<&str>).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::maximize(app, None::<&str>).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::close_window(app, None::<&str>).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;

    let help_menu =
        Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, "Help", true, &[])
            .map_err(|e| e.to_string())?;

    Menu::with_items(
        app,
        &[
            &app_submenu,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None::<&str>)
                    .map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None::<&str>).map_err(|e| e.to_string())?,
                    &PredefinedMenuItem::redo(app, None::<&str>).map_err(|e| e.to_string())?,
                    &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
                    &PredefinedMenuItem::cut(app, None::<&str>).map_err(|e| e.to_string())?,
                    &PredefinedMenuItem::copy(app, None::<&str>).map_err(|e| e.to_string())?,
                    &PredefinedMenuItem::paste(app, None::<&str>).map_err(|e| e.to_string())?,
                    &PredefinedMenuItem::select_all(app, None::<&str>)
                        .map_err(|e| e.to_string())?,
                ],
            )
            .map_err(|e| e.to_string())?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &PredefinedMenuItem::fullscreen(app, None::<&str>)
                        .map_err(|e| e.to_string())?,
                ],
            )
            .map_err(|e| e.to_string())?,
            &window_menu,
            &help_menu,
        ],
    )
    .map_err(|e| e.to_string())
}

// ── Policy predicates (pure, easily unit-testable) ───────────────────────────

pub(crate) fn should_show_context_menu_on_left_click(platform: &str) -> bool {
    platform == "windows"
}

pub(crate) fn should_toggle_tray_popover_on_left_click(platform: &str) -> bool {
    platform == "macos"
}

pub(crate) fn should_hide_tray_popover_on_focus_lost(focused: bool) -> bool {
    !focused
}

pub(crate) fn should_hide_tray_popover_on_toggle_request(visible: bool, focused: bool) -> bool {
    visible && focused
}

pub(crate) fn should_hide_tray_when_main_window_focuses(focused: bool) -> bool {
    focused
}

// ── Tray popover positioning ─────────────────────────────────────────────────

pub(crate) fn position_tray_popover(
    window: &tauri::WebviewWindow,
    anchor: PhysicalPosition<f64>,
) -> Result<(), String> {
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let x = (anchor.x.round() as i32) - (size.width as i32 / 2);
    // 5px gap between the menu bar and the top of the tray popover
    let y = (anchor.y.round() as i32) + 5;
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Event payload parsing ────────────────────────────────────────────────────

pub(crate) fn parse_recording_flag(payload: &str) -> bool {
    fn from_value(value: &serde_json::Value) -> Option<bool> {
        value.get("recording").and_then(|f| f.as_bool())
    }

    let parsed = serde_json::from_str::<serde_json::Value>(payload).ok();
    match parsed {
        Some(serde_json::Value::Object(_)) => {
            parsed.as_ref().and_then(from_value).unwrap_or(false)
        }
        Some(serde_json::Value::String(inner)) => {
            serde_json::from_str::<serde_json::Value>(&inner)
                .ok()
                .as_ref()
                .and_then(from_value)
                .unwrap_or(false)
        }
        _ => false,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_variant_depends_on_theme_and_recording_status() {
        assert_eq!(
            choose_tray_icon_variant(Theme::Light, false),
            TrayIconVariant::IdleLight
        );
        assert_eq!(
            choose_tray_icon_variant(Theme::Dark, false),
            TrayIconVariant::IdleDark
        );
        assert_eq!(
            choose_tray_icon_variant(Theme::Light, true),
            TrayIconVariant::RecDark
        );
        assert_eq!(
            choose_tray_icon_variant(Theme::Dark, true),
            TrayIconVariant::RecDark
        );
    }

    #[test]
    fn tray_popover_autoclose_policy_hides_on_focus_loss_for_all_platforms() {
        assert!(should_hide_tray_popover_on_focus_lost(false));
        assert!(!should_hide_tray_popover_on_focus_lost(true));
    }

    #[test]
    fn tray_left_click_policy_is_platform_specific() {
        assert!(should_show_context_menu_on_left_click("windows"));
        assert!(!should_show_context_menu_on_left_click("macos"));
        assert!(should_toggle_tray_popover_on_left_click("macos"));
        assert!(!should_toggle_tray_popover_on_left_click("windows"));
        assert!(!should_toggle_tray_popover_on_left_click("linux"));
    }

    #[test]
    fn tray_toggle_hides_only_when_popover_is_visible_and_focused() {
        assert!(should_hide_tray_popover_on_toggle_request(true, true));
        assert!(!should_hide_tray_popover_on_toggle_request(true, false));
        assert!(!should_hide_tray_popover_on_toggle_request(false, false));
    }

    #[test]
    fn main_window_focus_hides_tray() {
        assert!(should_hide_tray_when_main_window_focuses(true));
        assert!(!should_hide_tray_when_main_window_focuses(false));
    }

    #[test]
    fn parse_recording_flag_supports_object_and_nested_json_string() {
        assert!(parse_recording_flag(r#"{"recording":true}"#));
        assert!(parse_recording_flag(r#""{\"recording\":true}""#));
        assert!(!parse_recording_flag(r#"{"recording":false}"#));
    }
}
