use super::lease::{
    archive_lease_key, default_lease_ttl_secs, session_lease_key, try_acquire_brain_upload_lease,
    BrainUploadLeaseGuard,
};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Debug, Default)]
pub struct BrainUploadRuntimeState {
    archive_running: bool,
    session_uploads: BTreeSet<String>,
}

pub type SharedBrainUploadState = Arc<Mutex<BrainUploadRuntimeState>>;

pub fn new_shared_state() -> SharedBrainUploadState {
    Arc::new(Mutex::new(BrainUploadRuntimeState::default()))
}

fn lock_runtime_state(
    state: &SharedBrainUploadState,
) -> Result<MutexGuard<'_, BrainUploadRuntimeState>, String> {
    state.lock().or_else(|poisoned| {
        eprintln!("warning: brain upload runtime state lock was poisoned, recovering");
        Ok(poisoned.into_inner())
    })
}

pub struct BrainArchiveGuard {
    runtime: SharedBrainUploadState,
    _cross_process: BrainUploadLeaseGuard,
    active: bool,
}

impl Drop for BrainArchiveGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut guard) = lock_runtime_state(&self.runtime) {
            guard.archive_running = false;
        }
    }
}

pub struct BrainSessionUploadGuard {
    runtime: SharedBrainUploadState,
    _cross_process: BrainUploadLeaseGuard,
    session_id: String,
    active: bool,
}

impl Drop for BrainSessionUploadGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut guard) = lock_runtime_state(&self.runtime) {
            guard.session_uploads.remove(&self.session_id);
        }
    }
}

pub fn try_begin_archive_upload(
    app_data_dir: &Path,
    state: &SharedBrainUploadState,
) -> Result<BrainArchiveGuard, String> {
    let mut guard = lock_runtime_state(state)?;
    if guard.archive_running {
        return Err("BRAIN_ALREADY_RUNNING: Загрузка архива Brain уже выполняется".to_string());
    }
    let cross_process = try_acquire_brain_upload_lease(
        app_data_dir,
        archive_lease_key(),
        default_lease_ttl_secs(),
    )?;
    guard.archive_running = true;
    Ok(BrainArchiveGuard {
        runtime: state.clone(),
        _cross_process: cross_process,
        active: true,
    })
}

pub fn try_begin_session_upload(
    app_data_dir: &Path,
    state: &SharedBrainUploadState,
    session_id: &str,
) -> Result<BrainSessionUploadGuard, String> {
    let mut guard = lock_runtime_state(state)?;
    if guard.session_uploads.contains(session_id) {
        return Err(
            "BRAIN_ALREADY_RUNNING: Загрузка Brain для этой записи уже выполняется".to_string(),
        );
    }
    let cross_process = try_acquire_brain_upload_lease(
        app_data_dir,
        &session_lease_key(session_id),
        default_lease_ttl_secs(),
    )?;
    guard.session_uploads.insert(session_id.to_string());
    Ok(BrainSessionUploadGuard {
        runtime: state.clone(),
        _cross_process: cross_process,
        session_id: session_id.to_string(),
        active: true,
    })
}

pub fn is_already_running_error(message: &str) -> bool {
    message.starts_with("BRAIN_ALREADY_RUNNING:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn archive_guard_rejects_parallel_runs_until_dropped() {
        let dir = tempdir().expect("tempdir");
        let state = new_shared_state();
        let first = try_begin_archive_upload(dir.path(), &state).expect("first archive starts");
        assert!(try_begin_archive_upload(dir.path(), &state).is_err());
        drop(first);
        assert!(try_begin_archive_upload(dir.path(), &state).is_ok());
    }

    #[test]
    fn session_guard_rejects_parallel_upload_for_same_session_only() {
        let dir = tempdir().expect("tempdir");
        let state = new_shared_state();
        let first =
            try_begin_session_upload(dir.path(), &state, "s1").expect("first session starts");
        assert!(try_begin_session_upload(dir.path(), &state, "s1").is_err());
        assert!(try_begin_session_upload(dir.path(), &state, "s2").is_ok());
        drop(first);
        assert!(try_begin_session_upload(dir.path(), &state, "s1").is_ok());
    }

    #[test]
    fn poisoned_runtime_lock_recovers_on_next_attempt() {
        let dir = tempdir().expect("tempdir");
        let state = new_shared_state();
        {
            let mutex = Arc::clone(&state);
            let _ = std::thread::spawn(move || {
                let _guard = mutex.lock().expect("lock");
                panic!("simulate poison");
            })
            .join();
        }
        assert!(state.is_poisoned());
        assert!(try_begin_session_upload(dir.path(), &state, "s-poison").is_ok());
    }
}
