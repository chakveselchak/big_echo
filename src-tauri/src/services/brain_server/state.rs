use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

#[derive(Debug, Default)]
pub struct BrainUploadRuntimeState {
    archive_running: bool,
    session_uploads: BTreeSet<String>,
}

pub type SharedBrainUploadState = Arc<Mutex<BrainUploadRuntimeState>>;

pub fn new_shared_state() -> SharedBrainUploadState {
    Arc::new(Mutex::new(BrainUploadRuntimeState::default()))
}

pub struct BrainArchiveGuard {
    state: SharedBrainUploadState,
    active: bool,
}

impl Drop for BrainArchiveGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut guard) = self.state.lock() {
            guard.archive_running = false;
        }
    }
}

pub struct BrainSessionUploadGuard {
    state: SharedBrainUploadState,
    session_id: String,
    active: bool,
}

impl Drop for BrainSessionUploadGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut guard) = self.state.lock() {
            guard.session_uploads.remove(&self.session_id);
        }
    }
}

pub fn try_begin_archive_upload(
    state: &SharedBrainUploadState,
) -> Result<BrainArchiveGuard, String> {
    let mut guard = state
        .lock()
        .map_err(|_| "Brain upload state lock is poisoned".to_string())?;
    if guard.archive_running {
        return Err("Brain archive upload is already running".to_string());
    }
    guard.archive_running = true;
    Ok(BrainArchiveGuard {
        state: state.clone(),
        active: true,
    })
}

pub fn try_begin_session_upload(
    state: &SharedBrainUploadState,
    session_id: &str,
) -> Result<BrainSessionUploadGuard, String> {
    let mut guard = state
        .lock()
        .map_err(|_| "Brain upload state lock is poisoned".to_string())?;
    if guard.session_uploads.contains(session_id) {
        return Err("Brain upload is already running for this session".to_string());
    }
    guard.session_uploads.insert(session_id.to_string());
    Ok(BrainSessionUploadGuard {
        state: state.clone(),
        session_id: session_id.to_string(),
        active: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_guard_rejects_parallel_runs_until_dropped() {
        let state = new_shared_state();
        let first = try_begin_archive_upload(&state).expect("first archive starts");
        assert!(try_begin_archive_upload(&state).is_err());
        drop(first);
        assert!(try_begin_archive_upload(&state).is_ok());
    }

    #[test]
    fn session_guard_rejects_parallel_upload_for_same_session_only() {
        let state = new_shared_state();
        let first = try_begin_session_upload(&state, "s1").expect("first session starts");
        assert!(try_begin_session_upload(&state, "s1").is_err());
        assert!(try_begin_session_upload(&state, "s2").is_ok());
        drop(first);
        assert!(try_begin_session_upload(&state, "s1").is_ok());
    }
}
