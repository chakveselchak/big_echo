use crate::services::yandex_disk::client::YandexDiskApi;
use crate::services::yandex_disk::state::{FileError, LastRunSummary};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MAX_ERRORS_REPORTED: usize = 20;

/// Filenames we never sync. macOS sprinkles `.DS_Store` inside every directory
/// the Finder has touched; uploading them clutters the Yandex.Disk view and
/// produces noise on every sync run.
const IGNORED_FILENAMES: &[&str] = &[".DS_Store"];

pub struct SyncParams {
    pub local_root: PathBuf,
    pub remote_folder: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncProgress {
    /// Emitted once after the pre-flight scan finishes and the upload loop is
    /// about to start. `total_objects` is the count of local files considered
    /// (after `.DS_Store` filtering); `not_synced` is the subset that needs
    /// upload (missing remotely or remote size differs).
    Started { total_objects: u32, not_synced: u32 },
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
            if IGNORED_FILENAMES
                .iter()
                .any(|ignored| entry.file_name() == *ignored)
            {
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
                total_objects: 0,
                not_synced: 0,
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
    let total_objects = files.len() as u32;

    if let Err(err) = api
        .ensure_dir(&remote_dir_for(&params.remote_folder, ""))
        .await
    {
        let finished = Utc::now();
        let summary = LastRunSummary {
            started_at_iso: started_iso,
            finished_at_iso: finished.to_rfc3339(),
            duration_ms: (finished - started_at).num_milliseconds().max(0) as u64,
            total_objects,
            not_synced: total_objects,
            uploaded: 0,
            skipped: 0,
            failed: total_objects.max(1),
            errors: vec![FileError {
                path: params.remote_folder.clone(),
                message: format!("ensure root dir: {err}"),
            }],
        };
        progress(SyncProgress::Finished(summary.clone()));
        return summary;
    }

    // Pre-flight: list every remote directory we touch once, then classify
    // each local file as "already in sync" (size matches) or "needs upload".
    // Doing this upfront lets us report `total_objects` and `not_synced`
    // before we start hitting the network for uploads, and lets us skip the
    // upload loop entirely when nothing changed.
    let mut listing_cache: HashMap<String, HashMap<String, u64>> = HashMap::new();
    let mut already_synced = 0u32;
    let mut needs_upload: Vec<&LocalFile> = Vec::with_capacity(files.len());

    for lf in &files {
        let rel_dir = parent_rel_dir(&lf.rel_path);
        let remote_dir = remote_dir_for(&params.remote_folder, rel_dir);

        if !listing_cache.contains_key(&remote_dir) {
            // List failures are not fatal: we treat the directory as empty
            // (so every file in it counts as "needs upload"). The actual
            // upload call will surface any persistent error.
            let listing = api.list_dir(&remote_dir).await.unwrap_or_default();
            listing_cache.insert(remote_dir.clone(), listing);
        }
        let remote_map = listing_cache
            .get(&remote_dir)
            .expect("just inserted");

        let name = lf.rel_path.rsplit('/').next().unwrap_or(&lf.rel_path);
        if remote_map.get(name).copied() == Some(lf.size) {
            already_synced += 1;
        } else {
            needs_upload.push(lf);
        }
    }

    let not_synced = needs_upload.len() as u32;
    progress(SyncProgress::Started {
        total_objects,
        not_synced,
    });

    let mut created_dirs: HashSet<String> = HashSet::new();
    // Root dir was already ensured above; skip it in the per-file loop.
    created_dirs.insert(remote_dir_for(&params.remote_folder, ""));

    for (idx, lf) in needs_upload.iter().enumerate() {
        let rel_dir = parent_rel_dir(&lf.rel_path);
        let remote_dir = remote_dir_for(&params.remote_folder, rel_dir);
        let current = (idx + 1) as u32;
        progress(SyncProgress::Item {
            current,
            total: not_synced,
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

        let name = lf.rel_path.rsplit('/').next().unwrap_or(&lf.rel_path);
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
        total_objects,
        not_synced,
        uploaded,
        skipped: already_synced,
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
        assert_eq!(summary.total_objects, 0);
        assert_eq!(summary.not_synced, 0);
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.failed, 0);
        let events = events.lock().unwrap();
        assert!(matches!(
            events[0],
            SyncProgress::Started {
                total_objects: 0,
                not_synced: 0
            }
        ));
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
        assert_eq!(summary.total_objects, 1);
        assert_eq!(summary.not_synced, 0);
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.skipped, 1);
        assert_eq!(api.upload_call_count(), 0);
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
        assert!(matches!(
            evs[0],
            SyncProgress::Started {
                total_objects: 2,
                not_synced: 2
            }
        ));
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

    #[tokio::test]
    async fn ds_store_files_are_ignored() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "10.04.2026/audio.opus", b"hello");
        write_file(tmp.path(), "10.04.2026/.DS_Store", b"junk");
        write_file(tmp.path(), ".DS_Store", b"junk-root");
        let api = Arc::new(FakeApi::new());
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;

        assert_eq!(summary.total_objects, 1);
        assert_eq!(summary.not_synced, 1);
        assert_eq!(summary.uploaded, 1);
        assert_eq!(api.upload_call_count(), 1);
        let uploaded_paths: Vec<String> =
            api.inner.lock().unwrap().files.keys().cloned().collect();
        assert!(
            !uploaded_paths.iter().any(|p| p.ends_with("/.DS_Store")),
            ".DS_Store should not be uploaded; got {uploaded_paths:?}"
        );
        // Only the audio file should appear as an Item; no Item for .DS_Store.
        let item_paths: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|p| match p {
                SyncProgress::Item { rel_path, .. } => Some(rel_path.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(item_paths, vec!["10.04.2026/audio.opus".to_string()]);
    }

    #[tokio::test]
    async fn preflight_classifies_total_and_not_synced() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "a.opus", b"aa");
        write_file(tmp.path(), "b.opus", b"bbbb");
        write_file(tmp.path(), "c.opus", b"cccccc");
        let api = Arc::new(FakeApi::new());
        // a is already in sync (size 2 matches), b has wrong remote size, c is missing
        api.preload_file("disk:/BigEcho/a.opus", 2);
        api.preload_file("disk:/BigEcho/b.opus", 999);
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;

        assert_eq!(summary.total_objects, 3);
        assert_eq!(summary.not_synced, 2);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.uploaded, 2);
        assert_eq!(api.upload_call_count(), 2);
        // Started event reflects the snapshot taken before uploads start.
        assert!(matches!(
            events.lock().unwrap()[0],
            SyncProgress::Started {
                total_objects: 3,
                not_synced: 2
            }
        ));
    }

    #[tokio::test]
    async fn upload_loop_iterates_only_needs_upload() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "a.opus", b"aa");
        write_file(tmp.path(), "b.opus", b"bb");
        let api = Arc::new(FakeApi::new());
        // Both already in sync — upload loop should not run.
        api.preload_file("disk:/BigEcho/a.opus", 2);
        api.preload_file("disk:/BigEcho/b.opus", 2);
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;

        assert_eq!(summary.total_objects, 2);
        assert_eq!(summary.not_synced, 0);
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.skipped, 2);
        assert_eq!(api.upload_call_count(), 0);
        // No Item events emitted because nothing was uploaded.
        let has_item = events
            .lock()
            .unwrap()
            .iter()
            .any(|p| matches!(p, SyncProgress::Item { .. }));
        assert!(!has_item);
    }
}
