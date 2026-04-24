use crate::services::yandex_disk::client::YandexDiskApi;
use crate::services::yandex_disk::state::{FileError, LastRunSummary};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MAX_ERRORS_REPORTED: usize = 20;

pub struct SyncParams {
    pub local_root: PathBuf,
    pub remote_folder: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncProgress {
    Started { total: u32 },
    Item { current: u32, total: u32, rel_path: String },
    Finished(LastRunSummary),
}

struct LocalFile {
    rel_path: String, // POSIX, forward-slash separated
    abs_path: PathBuf,
    size: u64,
}

fn collect_local_files(root: &Path) -> std::io::Result<Vec<LocalFile>> {
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let p = entry.path();
            if kind.is_dir() {
                stack.push(p);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let size = entry.metadata()?.len();
            let rel = p.strip_prefix(root).unwrap_or(&p).to_path_buf();
            // FIXME(portability): non-UTF-8 path components are silently replaced with
            // U+FFFD. On macOS/Windows this is unreachable; on Linux such files would
            // upload under a mangled name. Reject them before upload once we target Linux.
            let rel_posix = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            out.push(LocalFile {
                rel_path: rel_posix,
                abs_path: p,
                size,
            });
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

fn parent_rel_dir(rel_path: &str) -> &str {
    match rel_path.rfind('/') {
        Some(i) => &rel_path[..i],
        None => "",
    }
}

fn remote_dir_for(remote_folder: &str, rel_dir: &str) -> String {
    if rel_dir.is_empty() {
        format!("disk:/{}", remote_folder.trim_matches('/'))
    } else {
        format!("disk:/{}/{}", remote_folder.trim_matches('/'), rel_dir)
    }
}

fn push_error(errors: &mut Vec<FileError>, path: &str, message: String) {
    if errors.len() < MAX_ERRORS_REPORTED {
        errors.push(FileError {
            path: path.to_string(),
            message,
        });
    }
}

pub async fn run(
    params: &SyncParams,
    api: Arc<dyn YandexDiskApi>,
    progress: &(dyn Fn(SyncProgress) + Send + Sync),
) -> LastRunSummary {
    let started_at = Utc::now();
    let started_iso = started_at.to_rfc3339();
    let mut uploaded = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;
    let mut errors: Vec<FileError> = Vec::new();

    // FIXME(perf): collect_local_files uses std::fs which blocks the Tokio worker
    // thread. Wrap in tokio::task::spawn_blocking if recording roots can hold
    // thousands of files.
    let files = match collect_local_files(&params.local_root) {
        Ok(v) => v,
        Err(err) => {
            let finished = Utc::now();
            let summary = LastRunSummary {
                started_at_iso: started_iso,
                finished_at_iso: finished.to_rfc3339(),
                duration_ms: (finished - started_at).num_milliseconds().max(0) as u64,
                uploaded: 0,
                skipped: 0,
                failed: 1,
                errors: vec![FileError {
                    path: params.local_root.to_string_lossy().to_string(),
                    message: format!("cannot read local root: {err}"),
                }],
            };
            progress(SyncProgress::Finished(summary.clone()));
            return summary;
        }
    };
    let total = files.len() as u32;
    progress(SyncProgress::Started { total });

    if let Err(err) = api
        .ensure_dir(&remote_dir_for(&params.remote_folder, ""))
        .await
    {
        let finished = Utc::now();
        let summary = LastRunSummary {
            started_at_iso: started_iso,
            finished_at_iso: finished.to_rfc3339(),
            duration_ms: (finished - started_at).num_milliseconds().max(0) as u64,
            uploaded: 0,
            skipped: 0,
            failed: total.max(1),
            errors: vec![FileError {
                path: params.remote_folder.clone(),
                message: format!("ensure root dir: {err}"),
            }],
        };
        progress(SyncProgress::Finished(summary.clone()));
        return summary;
    }

    let mut listing_cache: HashMap<String, HashMap<String, u64>> = HashMap::new();
    let mut created_dirs: HashSet<String> = HashSet::new();
    // Root dir was already ensured above; skip it in the per-file loop.
    created_dirs.insert(remote_dir_for(&params.remote_folder, ""));

    for (idx, lf) in files.iter().enumerate() {
        let rel_dir = parent_rel_dir(&lf.rel_path);
        let remote_dir = remote_dir_for(&params.remote_folder, rel_dir);
        let current = (idx + 1) as u32;
        progress(SyncProgress::Item {
            current,
            total,
            rel_path: lf.rel_path.clone(),
        });

        if !created_dirs.contains(&remote_dir) {
            if let Err(err) = api.ensure_dir(&remote_dir).await {
                failed += 1;
                push_error(&mut errors, &lf.rel_path, format!("ensure_dir: {err}"));
                continue;
            }
            created_dirs.insert(remote_dir.clone());
        }

        let remote_map = if listing_cache.contains_key(&remote_dir) {
            listing_cache.get(&remote_dir).expect("just checked")
        } else {
            match api.list_dir(&remote_dir).await {
                Ok(m) => listing_cache.entry(remote_dir.clone()).or_insert(m),
                Err(err) => {
                    failed += 1;
                    push_error(&mut errors, &lf.rel_path, format!("list_dir: {err}"));
                    continue;
                }
            }
        };

        let name = lf.rel_path.rsplit('/').next().unwrap_or(&lf.rel_path);
        if remote_map.get(name).copied() == Some(lf.size) {
            skipped += 1;
            continue;
        }

        let remote_path = format!("{}/{}", remote_dir, name);
        match api.upload_file(&remote_path, &lf.abs_path).await {
            Ok(()) => uploaded += 1,
            Err(err) => {
                failed += 1;
                push_error(&mut errors, &lf.rel_path, err.to_string());
            }
        }
    }

    let finished = Utc::now();
    let summary = LastRunSummary {
        started_at_iso: started_iso,
        finished_at_iso: finished.to_rfc3339(),
        duration_ms: (finished - started_at).num_milliseconds().max(0) as u64,
        uploaded,
        skipped,
        failed,
        errors,
    };
    progress(SyncProgress::Finished(summary.clone()));
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::yandex_disk::client::YandexError;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tempfile::tempdir;

    #[derive(Default)]
    struct FakeApiState {
        dirs: HashSet<String>,
        files: HashMap<String, u64>,
        upload_failures: HashSet<String>,
        upload_calls: usize,
    }

    struct FakeApi {
        inner: Mutex<FakeApiState>,
    }

    impl FakeApi {
        fn new() -> Self {
            Self {
                inner: Mutex::new(FakeApiState::default()),
            }
        }
        fn preload_file(&self, remote_path: &str, size: u64) {
            self.inner
                .lock()
                .unwrap()
                .files
                .insert(remote_path.to_string(), size);
        }
        fn fail_upload_for(&self, remote_path: &str) {
            self.inner
                .lock()
                .unwrap()
                .upload_failures
                .insert(remote_path.to_string());
        }
        fn upload_call_count(&self) -> usize {
            self.inner.lock().unwrap().upload_calls
        }
    }

    #[async_trait]
    impl YandexDiskApi for FakeApi {
        async fn ensure_dir(&self, remote_path: &str) -> Result<(), YandexError> {
            self.inner
                .lock()
                .unwrap()
                .dirs
                .insert(remote_path.to_string());
            Ok(())
        }
        async fn list_dir(&self, remote_path: &str) -> Result<HashMap<String, u64>, YandexError> {
            let g = self.inner.lock().unwrap();
            let prefix = format!("{}/", remote_path);
            let mut out = HashMap::new();
            for (k, v) in &g.files {
                if let Some(stripped) = k.strip_prefix(&prefix) {
                    if !stripped.contains('/') {
                        out.insert(stripped.to_string(), *v);
                    }
                }
            }
            Ok(out)
        }
        async fn upload_file(
            &self,
            remote_path: &str,
            local_path: &Path,
        ) -> Result<(), YandexError> {
            let mut g = self.inner.lock().unwrap();
            if g.upload_failures.contains(remote_path) {
                return Err(YandexError::Network("simulated".into()));
            }
            g.upload_calls += 1;
            let size = std::fs::metadata(local_path).unwrap().len();
            g.files.insert(remote_path.to_string(), size);
            Ok(())
        }
    }

    fn write_file(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, bytes).unwrap();
    }

    fn record_progress() -> (Arc<Mutex<Vec<SyncProgress>>>, impl Fn(SyncProgress) + Send + Sync) {
        let events = Arc::new(Mutex::new(Vec::<SyncProgress>::new()));
        let recorder = events.clone();
        let emit = move |p: SyncProgress| recorder.lock().unwrap().push(p);
        (events, emit)
    }

    fn params(root: &Path) -> SyncParams {
        SyncParams {
            local_root: root.to_path_buf(),
            remote_folder: "BigEcho".into(),
        }
    }

    #[tokio::test]
    async fn empty_local_root_produces_zero_counters() {
        let tmp = tempdir().unwrap();
        let api: Arc<dyn YandexDiskApi> = Arc::new(FakeApi::new());
        let (events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api, &emit).await;
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.failed, 0);
        let events = events.lock().unwrap();
        assert!(matches!(events[0], SyncProgress::Started { total: 0 }));
        assert!(matches!(events.last(), Some(SyncProgress::Finished(_))));
    }

    #[tokio::test]
    async fn uploads_file_when_absent_on_remote() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "10.04.2026/meeting_15-06-07/audio.opus", b"hello");
        let api = Arc::new(FakeApi::new());
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.uploaded, 1);
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.failed, 0);
        assert_eq!(api.upload_call_count(), 1);
    }

    #[tokio::test]
    async fn skips_file_when_remote_size_matches() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "10.04.2026/meeting_15-06-07/audio.opus", b"hello");
        let api = Arc::new(FakeApi::new());
        api.preload_file(
            "disk:/BigEcho/10.04.2026/meeting_15-06-07/audio.opus",
            5,
        );
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.skipped, 1);
    }

    #[tokio::test]
    async fn uploads_file_when_remote_size_differs() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "10.04.2026/audio.opus", b"hello");
        let api = Arc::new(FakeApi::new());
        api.preload_file("disk:/BigEcho/10.04.2026/audio.opus", 999);
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.uploaded, 1);
        assert_eq!(summary.skipped, 0);
    }

    #[tokio::test]
    async fn creates_missing_remote_directories_in_order() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "A/B/C/file.opus", b"x");
        let api = Arc::new(FakeApi::new());
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_e, emit) = record_progress();
        let _ = run(&params(tmp.path()), api_dyn, &emit).await;
        let dirs = api.inner.lock().unwrap().dirs.clone();
        assert!(dirs.contains("disk:/BigEcho"));
        assert!(dirs.contains("disk:/BigEcho/A/B/C"));
    }

    #[tokio::test]
    async fn continues_after_single_file_failure() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "a.opus", b"ok");
        write_file(tmp.path(), "b.opus", b"boom");
        let api = Arc::new(FakeApi::new());
        api.fail_upload_for("disk:/BigEcho/b.opus");
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_e, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.uploaded, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.errors.len(), 1);
        assert_eq!(summary.errors[0].path, "b.opus");
    }

    #[tokio::test]
    async fn caps_error_list_at_twenty_entries() {
        let tmp = tempdir().unwrap();
        let api = Arc::new(FakeApi::new());
        for i in 0..25 {
            let name = format!("f{i}.opus");
            write_file(tmp.path(), &name, b"x");
            api.fail_upload_for(&format!("disk:/BigEcho/{name}"));
        }
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_e, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.failed, 25);
        assert_eq!(summary.errors.len(), MAX_ERRORS_REPORTED);
    }

    #[tokio::test]
    async fn emits_progress_events_in_order() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "a.opus", b"aa");
        write_file(tmp.path(), "b.opus", b"bb");
        let api: Arc<dyn YandexDiskApi> = Arc::new(FakeApi::new());
        let (events, emit) = record_progress();
        let _ = run(&params(tmp.path()), api, &emit).await;
        let evs = events.lock().unwrap();
        assert!(matches!(evs[0], SyncProgress::Started { total: 2 }));
        match &evs[1] {
            SyncProgress::Item { current, total, rel_path } => {
                assert_eq!(*current, 1);
                assert_eq!(*total, 2);
                assert_eq!(rel_path, "a.opus");
            }
            other => panic!("expected Item, got {:?}", other),
        }
        match &evs[2] {
            SyncProgress::Item { current, total, rel_path } => {
                assert_eq!(*current, 2);
                assert_eq!(*total, 2);
                assert_eq!(rel_path, "b.opus");
            }
            other => panic!("expected Item, got {:?}", other),
        }
        assert!(matches!(evs.last(), Some(SyncProgress::Finished(_))));
    }
}
