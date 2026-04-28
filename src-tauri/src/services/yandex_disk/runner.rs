use crate::services::yandex_disk::client::{HttpYandexDiskClient, YandexDiskApi};
use crate::services::yandex_disk::state::LastRunSummary;
use crate::services::yandex_disk::sync_runner::{run, SyncParams, SyncProgress};
use crate::settings::public_settings::load_settings;
use crate::settings::secret_store::get_secret;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(crate) const TOKEN_KEY: &str = "YANDEX_DISK_OAUTH_TOKEN";
pub(crate) const PROGRESS_EVENT: &str = "yandex-sync-progress";
pub(crate) const PREFLIGHT_EVENT: &str = "yandex-sync-preflight";
pub(crate) const FINISHED_EVENT: &str = "yandex-sync-finished";

pub(crate) fn resolved_local_root(app_data_dir: &Path, recording_root: &str) -> PathBuf {
    let p = PathBuf::from(recording_root);
    if p.is_absolute() {
        p
    } else {
        app_data_dir.join(p)
    }
}

/// Runs one full Yandex.Disk sync pass. Loads settings, fetches the token,
/// builds the HTTP client, and forwards progress events to the Tauri frontend.
/// Returns `Err` only if settings are unreadable or the token is missing;
/// per-file upload failures are folded into `LastRunSummary::errors`.
pub(crate) async fn execute_sync<R: tauri::Runtime>(
    app: &AppHandle<R>,
    app_data_dir: &Path,
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

    let app_for_progress = app.clone();
    let emit = move |p: SyncProgress| match p {
        SyncProgress::Started {
            total_objects,
            not_synced,
        } => {
            let payload = serde_json::json!({
                "total_objects": total_objects, "not_synced": not_synced,
            });
            let _ = app_for_progress.emit(PREFLIGHT_EVENT, payload);
        }
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
    };

    Ok(run(&params, api, &emit).await)
}
