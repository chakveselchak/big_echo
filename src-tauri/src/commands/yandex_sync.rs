use crate::app_state::{AppDirs, AppState};
use crate::root_recordings_dir;
use crate::services::yandex_disk::client::{HttpYandexDiskClient, YandexDiskApi};
use crate::services::yandex_disk::runner::{execute_sync, TOKEN_KEY};
use crate::services::yandex_disk::share::remote_audio_path;
use crate::services::yandex_disk::state::{LastRunSummary, YandexSyncStatus};
use crate::settings::public_settings::load_settings;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use crate::settings::token_validation::validate_secret_token;
use crate::storage::session_store::load_meta;
use crate::storage::sqlite_repo::{get_meta_path, get_session_dir};
use std::path::Path;
use std::sync::Arc;
use tauri::{Manager, Runtime, State, WebviewWindow};

#[tauri::command]
pub async fn yandex_sync_set_token(dirs: State<'_, AppDirs>, token: String) -> Result<(), String> {
    let validated = validate_secret_token(&token)?;
    set_secret(&dirs.app_data_dir, TOKEN_KEY, validated)
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

#[tauri::command]
pub async fn yandex_share_audio(
    dirs: State<'_, AppDirs>,
    session_id: String,
) -> Result<String, String> {
    let settings = load_settings(&dirs.app_data_dir)?;
    let token = get_secret(&dirs.app_data_dir, TOKEN_KEY)
        .map_err(|_| "Yandex.Disk token is not set".to_string())?;
    if token.trim().is_empty() {
        return Err("Yandex.Disk token is not set".to_string());
    }

    let session_dir = get_session_dir(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta_path = get_meta_path(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session metadata not found".to_string())?;
    let meta = load_meta(&meta_path)?;
    let recording_root = root_recordings_dir(&dirs.app_data_dir, &settings)?;

    let remote_path = remote_audio_path(
        &settings.yandex_sync_remote_folder,
        &recording_root,
        &session_dir,
        &meta.artifacts.audio_file,
    )
    .ok_or_else(|| "Нет аудио для этой сессии".to_string())?;

    let api: Arc<dyn YandexDiskApi> = Arc::new(HttpYandexDiskClient::new(token));
    share_audio_link(api, &remote_path).await
}

/// Publishes `remote_path` (if needed) and returns its public share URL.
/// Returns `Err` when the file is not on the Disk (404) or no `public_url`
/// could be obtained.
async fn share_audio_link(
    api: Arc<dyn YandexDiskApi>,
    remote_path: &str,
) -> Result<String, String> {
    let meta = api
        .resource_meta(remote_path)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Файл ещё не синхронизирован на Диск".to_string())?;
    if let Some(url) = meta.public_url {
        return Ok(url);
    }
    api.publish(remote_path).await.map_err(|e| e.to_string())?;
    let published = api
        .resource_meta(remote_path)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Не удалось получить ссылку".to_string())?;
    published
        .public_url
        .ok_or_else(|| "Не удалось получить публичную ссылку".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::yandex_disk::client::{ResourceMeta, YandexError};
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Path → metadata fake. A `None` value (or absent key) models a 404.
    /// `publish` lazily assigns a `public_url` to a stored file that lacks one,
    /// modelling the real "publish then read" flow. `unauthorized` forces 401.
    struct MapFake {
        metas: Mutex<HashMap<String, Option<ResourceMeta>>>,
        unauthorized: bool,
    }

    impl MapFake {
        fn new() -> Self {
            Self {
                metas: Mutex::new(HashMap::new()),
                unauthorized: false,
            }
        }
        fn with(mut self, path: &str, meta: Option<ResourceMeta>) -> Self {
            self.metas.get_mut().unwrap().insert(path.to_string(), meta);
            self
        }
    }

    #[async_trait]
    impl YandexDiskApi for MapFake {
        async fn ensure_dir(&self, _p: &str) -> Result<(), YandexError> {
            Ok(())
        }
        async fn list_dir(&self, _p: &str) -> Result<HashMap<String, u64>, YandexError> {
            Ok(HashMap::new())
        }
        async fn upload_file(&self, _p: &str, _l: &Path) -> Result<(), YandexError> {
            Ok(())
        }
        async fn resource_meta(&self, p: &str) -> Result<Option<ResourceMeta>, YandexError> {
            if self.unauthorized {
                return Err(YandexError::Unauthorized);
            }
            Ok(self.metas.lock().unwrap().get(p).cloned().flatten())
        }
        async fn publish(&self, p: &str) -> Result<(), YandexError> {
            let mut m = self.metas.lock().unwrap();
            if let Some(Some(meta)) = m.get_mut(p) {
                if meta.public_url.is_none() {
                    meta.public_url = Some("https://disk.yandex.ru/d/PUB".to_string());
                }
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn share_returns_existing_public_url_without_publishing() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(MapFake::new().with(
            "disk:/BigEcho/a.opus",
            Some(ResourceMeta {
                size: 1,
                public_url: Some("https://disk.yandex.ru/d/EXISTING".to_string()),
            }),
        ));
        let url = share_audio_link(api, "disk:/BigEcho/a.opus")
            .await
            .expect("ok");
        assert_eq!(url, "https://disk.yandex.ru/d/EXISTING");
    }

    #[tokio::test]
    async fn share_publishes_then_returns_url() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(MapFake::new().with(
            "disk:/BigEcho/a.opus",
            Some(ResourceMeta {
                size: 1,
                public_url: None,
            }),
        ));
        let url = share_audio_link(api, "disk:/BigEcho/a.opus")
            .await
            .expect("ok");
        assert_eq!(url, "https://disk.yandex.ru/d/PUB");
    }

    #[tokio::test]
    async fn share_errors_when_not_synced() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(MapFake::new());
        let err = share_audio_link(api, "disk:/BigEcho/missing.opus")
            .await
            .expect_err("must fail");
        assert!(err.contains("не синхронизирован"));
    }
}
