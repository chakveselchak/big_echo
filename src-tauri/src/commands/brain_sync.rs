use crate::app_state::AppDirs;
use crate::services::brain_server::client::BrainUploadResponse;
use crate::services::brain_server::upload::upload_session_after_record_even_when_disabled;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use crate::settings::public_settings::load_settings;
use crate::storage::session_store::load_meta;
use crate::storage::sqlite_repo::{get_meta_path, get_session_dir};
use tauri::State;

pub(crate) const TOKEN_KEY: &str = "BRAIN_SERVER_API_TOKEN";

#[tauri::command]
pub fn brain_sync_set_token(dirs: State<'_, AppDirs>, token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token must not be empty".to_string());
    }
    set_secret(&dirs.app_data_dir, TOKEN_KEY, trimmed)
}

#[tauri::command]
pub fn brain_sync_clear_token(dirs: State<'_, AppDirs>) -> Result<(), String> {
    clear_secret(&dirs.app_data_dir, TOKEN_KEY)
}

#[tauri::command]
pub fn brain_sync_has_token(dirs: State<'_, AppDirs>) -> Result<bool, String> {
    match get_secret(&dirs.app_data_dir, TOKEN_KEY) {
        Ok(v) => Ok(!v.is_empty()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn brain_sync_upload_session(
    dirs: State<'_, AppDirs>,
    session_id: String,
) -> Result<BrainUploadResponse, String> {
    let settings = load_settings(&dirs.app_data_dir)?;
    let session_dir = get_session_dir(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta_path = get_meta_path(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta = load_meta(&meta_path)?;
    let audio_path = session_dir.join(&meta.artifacts.audio_file);
    if !audio_path.exists() {
        return Err("Audio file is missing for this session".to_string());
    }

    upload_session_after_record_even_when_disabled(
        dirs.app_data_dir.clone(),
        session_dir,
        meta,
        audio_path,
        settings,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_key_matches_brain_server_secret_name() {
        assert_eq!(TOKEN_KEY, "BRAIN_SERVER_API_TOKEN");
    }
}
