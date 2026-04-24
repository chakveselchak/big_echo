use crate::app_state::{AppDirs, AppState};
use crate::services::yandex_disk::client::{HttpYandexDiskClient, YandexDiskApi};
use crate::services::yandex_disk::state::{LastRunSummary, YandexSyncStatus};
use crate::services::yandex_disk::sync_runner::{run, SyncParams, SyncProgress};
use crate::settings::public_settings::load_settings;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Runtime, State, WebviewWindow};

const TOKEN_KEY: &str = "YANDEX_DISK_OAUTH_TOKEN";
const PROGRESS_EVENT: &str = "yandex-sync-progress";
const FINISHED_EVENT: &str = "yandex-sync-finished";

fn resolved_local_root(app_data_dir: &std::path::Path, recording_root: &str) -> PathBuf {
    let p = PathBuf::from(recording_root);
    if p.is_absolute() {
        p
    } else {
        app_data_dir.join(p)
    }
}

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

    let result = do_run(&window, &dirs.app_data_dir).await;

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

async fn do_run<R: Runtime, E: Emitter<R> + Clone + Send + Sync>(
    emitter: &E,
    app_data_dir: &std::path::Path,
) -> Result<LastRunSummary, String> {
    let settings = load_settings(app_data_dir)?;
    let token = get_secret(app_data_dir, TOKEN_KEY)
        .map_err(|_| "Yandex.Disk token is not set".to_string())?;
    if token.trim().is_empty() {
        return Err("Yandex.Disk token is not set".to_string());
    }
    let params = SyncParams {
        local_root: resolved_local_root(app_data_dir, &settings.recording_root),
        remote_folder: settings.yandex_sync_remote_folder.clone(),
    };

    let api: Arc<dyn YandexDiskApi> = Arc::new(HttpYandexDiskClient::new(token));

    let app_for_progress = emitter.clone();
    let emit = move |p: SyncProgress| match p {
        SyncProgress::Item {
            current,
            total,
            rel_path,
        } => {
            let payload = serde_json::json!({
                "current": current, "total": total, "rel_path": rel_path
            });
            let _ = app_for_progress.emit(PROGRESS_EVENT, payload);
        }
        SyncProgress::Finished(summary) => {
            let _ = app_for_progress.emit(FINISHED_EVENT, &summary);
        }
        SyncProgress::Started { .. } => {}
    };

    let summary = run(&params, api, &emit).await;
    Ok(summary)
}
