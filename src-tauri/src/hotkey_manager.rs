use crate::app_state::{AppDirs, AppState};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, ShortcutState};

pub(crate) const REC_HOTKEY: &str = "CmdOrCtrl+Shift+R";
pub(crate) const STOP_HOTKEY: &str = "CmdOrCtrl+Shift+S";

// ── Global shortcut plugin ────────────────────────────────────────────────────

pub(crate) fn build_global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    GlobalShortcutBuilder::new()
        .with_shortcuts([REC_HOTKEY, STOP_HOTKEY])
        .expect("failed to register global shortcuts")
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let shortcut_text = shortcut.to_string();
            if shortcut_text == REC_HOTKEY {
                let _ = app.emit("tray:start", ());
            } else if shortcut_text == STOP_HOTKEY {
                let _ = app.emit("tray:stop", ());
                let state = app.state::<AppState>();
                let dirs = app.state::<AppDirs>();
                let _ = crate::stop_active_recording_internal(
                    dirs.inner(),
                    state.inner(),
                    None,
                    Some(app),
                );
            }
        })
        .build()
}
