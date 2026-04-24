use crate::services::yandex_disk::state::SharedYandexSyncState;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum SchedulerAction {
    Trigger,
    Skip,
}

pub fn decide_action(
    enabled: bool,
    has_token: bool,
    state: &SharedYandexSyncState,
) -> SchedulerAction {
    if !enabled || !has_token {
        return SchedulerAction::Skip;
    }
    let guard = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_running {
        SchedulerAction::Skip
    } else {
        SchedulerAction::Trigger
    }
}

pub fn interval_to_duration(s: &str) -> Duration {
    match s {
        "1h" => Duration::from_secs(3600),
        "6h" => Duration::from_secs(6 * 3600),
        "48h" => Duration::from_secs(48 * 3600),
        _ => Duration::from_secs(24 * 3600),
    }
}

use crate::app_state::{AppDirs, AppState};
use crate::services::yandex_disk::client::{HttpYandexDiskClient, YandexDiskApi};
use crate::services::yandex_disk::sync_runner::{run, SyncParams, SyncProgress};
use crate::settings::public_settings::load_settings;
use crate::settings::secret_store::get_secret;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const TOKEN_KEY: &str = "YANDEX_DISK_OAUTH_TOKEN";
const PROGRESS_EVENT: &str = "yandex-sync-progress";
const FINISHED_EVENT: &str = "yandex-sync-finished";

fn resolved_local_root(app_data_dir: &Path, recording_root: &str) -> PathBuf {
    let p = PathBuf::from(recording_root);
    if p.is_absolute() {
        p
    } else {
        app_data_dir.join(p)
    }
}

pub async fn run_loop(app: AppHandle) {
    let dirs = app.state::<AppDirs>().inner().clone();
    let shared = app.state::<AppState>().yandex_sync.clone();

    // Startup tick.
    tick_once(&app, &dirs.app_data_dir, &shared).await;

    loop {
        let sleep_for = {
            let settings = load_settings(&dirs.app_data_dir).unwrap_or_default();
            interval_to_duration(&settings.yandex_sync_interval)
        };
        tokio::time::sleep(sleep_for).await;
        tick_once(&app, &dirs.app_data_dir, &shared).await;
    }
}

async fn tick_once(app: &AppHandle, app_data_dir: &Path, shared: &SharedYandexSyncState) {
    let settings = match load_settings(app_data_dir) {
        Ok(s) => s,
        Err(_) => return,
    };
    let token = match get_secret(app_data_dir, TOKEN_KEY) {
        Ok(t) if !t.trim().is_empty() => t,
        _ => return,
    };
    if decide_action(settings.yandex_sync_enabled, true, shared) != SchedulerAction::Trigger {
        return;
    }

    {
        let mut g = match shared.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.is_running {
            return;
        }
        g.is_running = true;
    }

    let params = SyncParams {
        local_root: resolved_local_root(app_data_dir, &settings.recording_root),
        remote_folder: settings.yandex_sync_remote_folder.clone(),
    };
    let api: Arc<dyn YandexDiskApi> = Arc::new(HttpYandexDiskClient::new(token));

    let app_for_progress = app.clone();
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

    let mut g = shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    g.is_running = false;
    g.last_run = Some(summary);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::yandex_disk::state::new_shared_state;

    #[test]
    fn triggers_when_enabled_and_token_and_not_running() {
        let s = new_shared_state();
        assert_eq!(decide_action(true, true, &s), SchedulerAction::Trigger);
    }

    #[test]
    fn skips_when_disabled() {
        let s = new_shared_state();
        assert_eq!(decide_action(false, true, &s), SchedulerAction::Skip);
    }

    #[test]
    fn skips_when_no_token() {
        let s = new_shared_state();
        assert_eq!(decide_action(true, false, &s), SchedulerAction::Skip);
    }

    #[test]
    fn skips_when_already_running() {
        let s = new_shared_state();
        s.lock().unwrap().is_running = true;
        assert_eq!(decide_action(true, true, &s), SchedulerAction::Skip);
    }

    #[test]
    fn interval_parses_known_values() {
        assert_eq!(interval_to_duration("1h"), Duration::from_secs(3600));
        assert_eq!(interval_to_duration("6h"), Duration::from_secs(21600));
        assert_eq!(interval_to_duration("24h"), Duration::from_secs(86400));
        assert_eq!(interval_to_duration("48h"), Duration::from_secs(172800));
    }

    #[test]
    fn interval_unknown_falls_back_to_24h() {
        assert_eq!(interval_to_duration("garbage"), Duration::from_secs(86400));
    }
}
