use crate::app_state::{AppDirs, AppState};
use crate::services::yandex_disk::runner::{execute_sync, TOKEN_KEY};
use crate::services::yandex_disk::state::{LastRunSummary, YandexSyncStatus};
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use tauri::{Manager, Runtime, State, WebviewWindow};

#[tauri::command]
pub async fn yandex_sync_set_token(
    dirs: State<'_, AppDirs>,
    token: String,
) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token must not be empty".to_string());
    }
    set_secret(&dirs.app_data_dir, TOKEN_KEY, trimmed)
}

#[tauri::command]
pub async fn yandex_sync_clear_token(dirs: State<'_, AppDirs>) -> Result<(), String> {
    clear_secret(&dirs.app_data_dir, TOKEN_KEY)
}

#[tauri::command]
pub async fn yandex_sync_has_token(dirs: State<'_, AppDirs>) -> Result<bool, String> {
    match get_secret(&dirs.app_data_dir, TOKEN_KEY) {
        Ok(v) => Ok(!v.is_empty()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn yandex_sync_status(state: State<'_, AppState>) -> Result<YandexSyncStatus, String> {
    Ok(YandexSyncStatus::snapshot(&state.yandex_sync))
}

#[tauri::command]
pub async fn yandex_sync_now<R: Runtime>(
    window: WebviewWindow<R>,
    dirs: State<'_, AppDirs>,
    state: State<'_, AppState>,
) -> Result<LastRunSummary, String> {
    {
        let mut g = state
            .yandex_sync
            .lock()
            .map_err(|_| "yandex_sync state poisoned".to_string())?;
        if g.is_running {
            return Err("Yandex sync already running".to_string());
        }
        g.is_running = true;
    }

    let app = window.app_handle().clone();
    let result = execute_sync(&app, &dirs.app_data_dir).await;

    let mut g = state
        .yandex_sync
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    g.is_running = false;
    match result {
        Ok(summary) => {
            g.last_run = Some(summary.clone());
            Ok(summary)
        }
        Err(err) => Err(err),
    }
}
