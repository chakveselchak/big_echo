use crate::app_state::AppDirs;
use crate::settings::public_settings::{save_settings, PublicSettings};
use crate::{get_settings_from_dirs, open_settings_window_internal, open_tray_window_internal};
use std::process::Command;

#[tauri::command]
pub fn get_settings(dirs: tauri::State<AppDirs>) -> Result<PublicSettings, String> {
    get_settings_from_dirs(dirs.inner())
}

#[tauri::command]
pub fn save_public_settings(dirs: tauri::State<AppDirs>, payload: PublicSettings) -> Result<(), String> {
    save_settings(&dirs.app_data_dir, &payload)
}

#[tauri::command]
pub fn list_audio_input_devices() -> Result<Vec<String>, String> {
    crate::audio::capture::list_input_devices()
}

#[tauri::command]
pub fn detect_system_source_device() -> Result<Option<String>, String> {
    crate::audio::capture::detect_system_source_device()
}

fn command_exists(program: &str) -> bool {
    let lookup_cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
    Command::new(lookup_cmd)
        .arg(program)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn detect_text_editor_apps() -> Vec<String> {
    let candidates: &[(&str, &[&str])] = if cfg!(target_os = "windows") {
        &[
            ("Notepad", &["notepad.exe"]),
            ("Notepad++", &["notepad++.exe"]),
            ("Visual Studio Code", &["code.cmd", "code.exe"]),
            ("Sublime Text", &["subl.exe"]),
            ("Vim", &["vim.exe"]),
        ]
    } else if cfg!(target_os = "macos") {
        &[
            ("Visual Studio Code", &["code"]),
            ("Sublime Text", &["subl"]),
            ("Vim", &["vim"]),
            ("Neovim", &["nvim"]),
            ("Nano", &["nano"]),
        ]
    } else {
        &[
            ("Visual Studio Code", &["code"]),
            ("Sublime Text", &["subl"]),
            ("Vim", &["vim"]),
            ("Neovim", &["nvim"]),
            ("Nano", &["nano"]),
            ("Gedit", &["gedit"]),
            ("Kate", &["kate"]),
        ]
    };

    let mut result = Vec::new();
    for (name, binaries) in candidates {
        if binaries.iter().any(|bin| command_exists(bin)) {
            result.push((*name).to_string());
        }
    }
    result
}

#[tauri::command]
pub fn list_text_editor_apps() -> Result<Vec<String>, String> {
    Ok(detect_text_editor_apps())
}

#[tauri::command]
pub fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    open_settings_window_internal(&app)
}

#[tauri::command]
pub fn open_tray_window(app: tauri::AppHandle) -> Result<(), String> {
    open_tray_window_internal(&app)
}
