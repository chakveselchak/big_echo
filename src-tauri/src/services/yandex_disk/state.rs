use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LastRunSummary {
    pub started_at_iso: String,
    pub finished_at_iso: String,
    pub duration_ms: u64,
    pub uploaded: u32,
    pub skipped: u32,
    pub failed: u32,
    pub errors: Vec<FileError>,
}

#[derive(Debug, Default)]
pub struct YandexSyncRuntimeState {
    pub is_running: bool,
    pub last_run: Option<LastRunSummary>,
}

/// Uses `std::sync::Mutex` intentionally: callers must keep critical sections
/// synchronous (acquire, mutate or clone, release before any `.await`).
pub type SharedYandexSyncState = Arc<Mutex<YandexSyncRuntimeState>>;

pub fn new_shared_state() -> SharedYandexSyncState {
    Arc::new(Mutex::new(YandexSyncRuntimeState::default()))
}

#[derive(Debug, Clone, Serialize)]
pub struct YandexSyncStatus {
    pub is_running: bool,
    pub last_run: Option<LastRunSummary>,
}

impl YandexSyncStatus {
    pub fn snapshot(state: &SharedYandexSyncState) -> Self {
        let guard = state.lock().expect("yandex_sync state lock");
        Self {
            is_running: guard.is_running,
            last_run: guard.last_run.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_runtime_state_is_idle_with_no_last_run() {
        let s = YandexSyncRuntimeState::default();
        assert!(!s.is_running);
        assert!(s.last_run.is_none());
    }

    #[test]
    fn snapshot_reflects_current_state() {
        let shared = new_shared_state();
        {
            let mut g = shared.lock().expect("yandex_sync state lock");
            g.is_running = true;
            g.last_run = Some(LastRunSummary {
                started_at_iso: "2026-04-24T10:00:00+00:00".into(),
                finished_at_iso: "2026-04-24T10:00:10+00:00".into(),
                duration_ms: 10_000,
                uploaded: 2,
                skipped: 3,
                failed: 0,
                errors: vec![],
            });
        }
        let snap = YandexSyncStatus::snapshot(&shared);
        assert!(snap.is_running);
        assert_eq!(snap.last_run.unwrap().uploaded, 2);
    }
}
