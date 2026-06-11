use crate::app_state::{AppDirs, AppState};
use crate::root_recordings_dir;
use crate::services::yandex_disk::client::{HttpYandexDiskClient, ResourceMeta, YandexDiskApi, YandexError};
use crate::services::yandex_disk::runner::{execute_sync, TOKEN_KEY};
use crate::services::yandex_disk::share::remote_audio_path;
use crate::services::yandex_disk::state::{LastRunSummary, YandexSyncStatus};
use crate::settings::public_settings::load_settings;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use crate::settings::token_validation::validate_secret_token;
use crate::storage::session_store::load_meta;
use crate::storage::sqlite_repo::{get_meta_path, get_session_dir, list_sessions, SessionListItem};
use std::path::Path;
use std::sync::Arc;
use tauri::{Manager, Runtime, State, WebviewWindow};
use tokio::task::JoinSet;

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

/// Effective audio filename for a session: the stored `audio_file`, or a
/// `audio.{format}` fallback. Empty when neither is usable (mirrors the
/// frontend `resolveSessionAudioPath`).
fn audio_file_for(item: &SessionListItem) -> String {
    let stored = item.audio_file.trim();
    if !stored.is_empty() {
        return stored.to_string();
    }
    let fmt = item.audio_format.trim();
    if fmt.is_empty() || fmt == "unknown" {
        return String::new();
    }
    format!("audio.{fmt}")
}

/// Probes each `(session_id, remote_path)` with bounded concurrency and returns
/// the ids whose audio exists on the Disk. Per-file network/parse errors are
/// treated as "not synced"; a 401/403 on any probe aborts with an error.
async fn check_synced(
    api: Arc<dyn YandexDiskApi>,
    candidates: Vec<(String, String)>,
) -> Result<Vec<String>, String> {
    const LIMIT: usize = 8;
    let mut iter = candidates.into_iter();
    let mut set: JoinSet<(String, Result<Option<ResourceMeta>, YandexError>)> = JoinSet::new();

    for _ in 0..LIMIT {
        match iter.next() {
            Some((id, path)) => {
                let api = api.clone();
                set.spawn(async move {
                    let r = api.resource_meta(&path).await;
                    (id, r)
                });
            }
            None => break,
        }
    }

    let mut synced = Vec::new();
    let mut unauthorized = false;
    while let Some(joined) = set.join_next().await {
        if let Ok((id, result)) = joined {
            match result {
                Ok(Some(_)) => synced.push(id),
                Ok(None) => {}
                Err(YandexError::Unauthorized) => unauthorized = true,
                Err(_) => {}
            }
        }
        if let Some((id, path)) = iter.next() {
            let api = api.clone();
            set.spawn(async move {
                let r = api.resource_meta(&path).await;
                (id, r)
            });
        }
    }

    if unauthorized {
        return Err("Yandex.Disk authorization failed".to_string());
    }
    Ok(synced)
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

#[tauri::command]
pub async fn yandex_list_synced_sessions(
    dirs: State<'_, AppDirs>,
) -> Result<Vec<String>, String> {
    let token = match get_secret(&dirs.app_data_dir, TOKEN_KEY) {
        Ok(t) if !t.trim().is_empty() => t,
        _ => return Ok(Vec::new()),
    };
    let settings = load_settings(&dirs.app_data_dir)?;
    let recording_root = root_recordings_dir(&dirs.app_data_dir, &settings)?;
    let sessions = list_sessions(&dirs.app_data_dir)?;

    let mut candidates: Vec<(String, String)> = Vec::new();
    for s in sessions {
        let audio_file = audio_file_for(&s);
        if let Some(path) = remote_audio_path(
            &settings.yandex_sync_remote_folder,
            &recording_root,
            Path::new(&s.session_dir),
            &audio_file,
        ) {
            candidates.push((s.session_id, path));
        }
    }

    let api: Arc<dyn YandexDiskApi> = Arc::new(HttpYandexDiskClient::new(token));
    check_synced(api, candidates).await
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

    #[test]
    fn audio_file_for_uses_stored_name() {
        let item = SessionListItem {
            session_id: "s".into(),
            status: "done".into(),
            primary_tag: "slack".into(),
            topic: "t".into(),
            display_date_ru: "10.04.2026".into(),
            started_at_iso: "2026-04-10T10:00:00+03:00".into(),
            session_dir: "/r/s".into(),
            audio_file: "audio.opus".into(),
            audio_format: "opus".into(),
            audio_duration_hms: "00:00:01".into(),
            has_transcript_text: false,
            has_summary_text: false,
            brain_upload_status: crate::storage::sqlite_repo::BrainUploadStatus::NotUploaded,
            brain_server_ingested_once: false,
            brain_upload_last_error: None,
            brain_upload_updated_at_iso: None,
            meta: None,
        };
        assert_eq!(audio_file_for(&item), "audio.opus");
    }

    #[tokio::test]
    async fn check_synced_returns_only_present_ids() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(
            MapFake::new()
                .with(
                    "disk:/BigEcho/a.opus",
                    Some(ResourceMeta { size: 1, public_url: None }),
                )
                .with("disk:/BigEcho/b.opus", None),
        );
        let got = check_synced(
            api,
            vec![
                ("a".to_string(), "disk:/BigEcho/a.opus".to_string()),
                ("b".to_string(), "disk:/BigEcho/b.opus".to_string()),
            ],
        )
        .await
        .expect("ok");
        assert_eq!(got, vec!["a".to_string()]);
    }

    #[tokio::test]
    async fn check_synced_errors_on_unauthorized() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(MapFake {
            metas: std::sync::Mutex::new(std::collections::HashMap::new()),
            unauthorized: true,
        });
        let err = check_synced(api, vec![("a".into(), "disk:/BigEcho/a.opus".into())])
            .await
            .expect_err("must fail");
        assert!(err.contains("authorization"));
    }
}
