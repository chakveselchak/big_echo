use crate::app_state::AppDirs;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_key_matches_brain_server_secret_name() {
        assert_eq!(TOKEN_KEY, "BRAIN_SERVER_API_TOKEN");
    }
}
