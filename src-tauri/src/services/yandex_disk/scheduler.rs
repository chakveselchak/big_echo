use crate::app_state::{AppDirs, AppState};
use crate::services::yandex_disk::state::SharedYandexSyncState;
use crate::settings::public_settings::load_settings;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Manager};

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
    // Fast-exit when disabled; execute_sync will re-check token and load settings.
    if !settings.yandex_sync_enabled {
        return;
    }
    // Confirm token is set before paying the cost of locking + calling execute_sync.
    let token_ok = crate::settings::secret_store::get_secret(
        app_data_dir,
        crate::services::yandex_disk::runner::TOKEN_KEY,
    )
    .map(|t| !t.trim().is_empty())
    .unwrap_or(false);
    if decide_action(settings.yandex_sync_enabled, token_ok, shared) != SchedulerAction::Trigger {
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

    let result = crate::services::yandex_disk::runner::execute_sync(app, app_data_dir).await;

    let mut g = shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    g.is_running = false;
    if let Ok(summary) = result {
        g.last_run = Some(summary);
    }
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
