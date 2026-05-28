use crate::app_state::AppDirs;
use crate::domain::session::SessionMeta;
use crate::services::brain_server::client::{BrainServerClient, BrainUploadResponse};
use crate::services::brain_server::upload::{
    sanitize_error, upload_session_after_record_even_when_disabled,
    upload_session_after_record_with_client, validate_upload_url, UploadAudioClient,
};
use crate::settings::public_settings::load_settings;
use crate::settings::public_settings::PublicSettings;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use crate::storage::session_store::load_meta;
use crate::storage::sqlite_repo::{
    add_event, get_meta_path, get_session_dir, list_session_events, list_sessions, SessionEvent,
};
use chrono::{DateTime, Duration, Local};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

pub(crate) const TOKEN_KEY: &str = "BRAIN_SERVER_API_TOKEN";
const ARCHIVE_PROGRESS_EVENT: &str = "brain-archive-upload-progress";
const ARCHIVE_EVENT_SESSION_ID: &str = "__brain_archive__";
const MAX_ARCHIVE_ERRORS: usize = 20;

#[derive(Debug, Clone, Serialize)]
pub struct BrainArchiveUploadProgress {
    pub total: usize,
    pub processed: usize,
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub current_session_id: Option<String>,
    pub current_title: Option<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrainArchiveUploadSummary {
    pub total: usize,
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrainUploadStatus {
    NotUploaded,
    Uploaded,
    Failed,
    Uploading { at_iso: String },
}

struct ArchiveCandidate {
    session_dir: PathBuf,
    meta: SessionMeta,
    audio_path: PathBuf,
    sort_at_iso: String,
}

pub(crate) fn derive_brain_upload_status(events: &[SessionEvent]) -> BrainUploadStatus {
    let mut status = BrainUploadStatus::NotUploaded;
    for event in events {
        match event.event_type.as_str() {
            "brain_upload_succeeded" => status = BrainUploadStatus::Uploaded,
            "brain_upload_failed" => status = BrainUploadStatus::Failed,
            "brain_upload_started" => {
                status = BrainUploadStatus::Uploading {
                    at_iso: event.at_iso.clone(),
                }
            }
            _ => {}
        }
    }
    status
}

fn fresh_uploading(status: &BrainUploadStatus, now: DateTime<Local>) -> bool {
    let BrainUploadStatus::Uploading { at_iso } = status else {
        return false;
    };
    DateTime::parse_from_rfc3339(at_iso)
        .map(|started| {
            now.signed_duration_since(started.with_timezone(&Local)) < Duration::minutes(30)
        })
        .unwrap_or(false)
}

fn archive_error(errors: &mut Vec<String>, message: String) {
    if errors.len() < MAX_ARCHIVE_ERRORS {
        errors.push(message);
    }
}

fn progress_from_summary(
    total: usize,
    processed: usize,
    summary: &BrainArchiveUploadSummary,
    current_session_id: Option<String>,
    current_title: Option<String>,
) -> BrainArchiveUploadProgress {
    BrainArchiveUploadProgress {
        total,
        processed,
        uploaded: summary.uploaded,
        skipped: summary.skipped,
        failed: summary.failed,
        current_session_id,
        current_title,
        errors: summary.errors.clone(),
    }
}

fn archive_candidates(
    app_data_dir: &std::path::Path,
    settings: &PublicSettings,
    now: DateTime<Local>,
) -> Result<Vec<ArchiveCandidate>, String> {
    let mut candidates = Vec::new();
    let Some(recording_root) = canonical_recording_root(app_data_dir, settings)? else {
        return Ok(candidates);
    };
    for item in list_sessions(app_data_dir)? {
        let Some(meta_path) = get_meta_path(app_data_dir, &item.session_id)? else {
            continue;
        };
        let meta = load_meta(&meta_path)?;
        let Some(session_dir) = local_session_dir(&recording_root, &item.session_dir) else {
            continue;
        };
        let Some(audio_path) = local_audio_file_path(&session_dir, &meta.artifacts.audio_file)
        else {
            continue;
        };

        let events = list_session_events(app_data_dir, &item.session_id)?;
        let status = derive_brain_upload_status(&events);
        if status == BrainUploadStatus::Uploaded || fresh_uploading(&status, now) {
            continue;
        }

        let sort_at_iso = if meta.started_at_iso.trim().is_empty() {
            meta.created_at_iso.clone()
        } else {
            meta.started_at_iso.clone()
        };
        candidates.push(ArchiveCandidate {
            session_dir,
            meta,
            audio_path,
            sort_at_iso,
        });
    }
    candidates.sort_by(|left, right| left.sort_at_iso.cmp(&right.sort_at_iso));
    Ok(candidates)
}

fn canonical_recording_root(
    app_data_dir: &std::path::Path,
    settings: &PublicSettings,
) -> Result<Option<PathBuf>, String> {
    let root = crate::root_recordings_dir(app_data_dir, settings)?;
    match std::fs::canonicalize(root) {
        Ok(path) => Ok(Some(path)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn local_session_dir(recording_root: &Path, raw_session_dir: &str) -> Option<PathBuf> {
    let session_dir = std::fs::canonicalize(raw_session_dir).ok()?;
    if session_dir.starts_with(recording_root) {
        Some(session_dir)
    } else {
        None
    }
}

fn local_audio_file_path(session_dir: &Path, audio_file: &str) -> Option<PathBuf> {
    let trimmed = audio_file.trim();
    if trimmed.is_empty() {
        return None;
    }

    let relative_path = Path::new(trimmed);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }

    let audio_path = session_dir.join(relative_path);
    let file_type = std::fs::symlink_metadata(&audio_path).ok()?.file_type();
    if file_type.is_symlink() || !file_type.is_file() {
        None
    } else {
        let canonical_audio_path = std::fs::canonicalize(&audio_path).ok()?;
        if canonical_audio_path.starts_with(session_dir) {
            Some(canonical_audio_path)
        } else {
            None
        }
    }
}

#[tauri::command]
pub fn brain_sync_set_token(dirs: State<'_, AppDirs>, token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token must not be empty".to_string());
    }
    set_secret(&dirs.app_data_dir, TOKEN_KEY, trimmed)
}

#[tauri::command]
pub fn brain_sync_clear_token(dirs: State<'_, AppDirs>) -> Result<(), String> {
    clear_secret(&dirs.app_data_dir, TOKEN_KEY)
}

#[tauri::command]
pub fn brain_sync_has_token(dirs: State<'_, AppDirs>) -> Result<bool, String> {
    match get_secret(&dirs.app_data_dir, TOKEN_KEY) {
        Ok(v) => Ok(!v.is_empty()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn brain_sync_upload_session(
    dirs: State<'_, AppDirs>,
    session_id: String,
) -> Result<BrainUploadResponse, String> {
    let settings = load_settings(&dirs.app_data_dir)?;
    let session_dir = get_session_dir(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta_path = get_meta_path(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta = load_meta(&meta_path)?;
    let audio_path = session_dir.join(&meta.artifacts.audio_file);
    if !audio_path.exists() {
        return Err("Audio file is missing for this session".to_string());
    }

    upload_session_after_record_even_when_disabled(
        dirs.app_data_dir.clone(),
        session_dir,
        meta,
        audio_path,
        settings,
    )
    .await
}

pub(crate) async fn upload_archive_with_client<C, E>(
    app_data_dir: PathBuf,
    settings: PublicSettings,
    client: &C,
    emit_progress: E,
) -> Result<BrainArchiveUploadSummary, String>
where
    C: UploadAudioClient + Sync,
    E: Fn(BrainArchiveUploadProgress) -> Result<(), String>,
{
    validate_upload_url(&settings.brain_sync_url)?;
    let token = get_secret(&app_data_dir, TOKEN_KEY)
        .map_err(|_| "Brain sync token is not configured".to_string())?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Brain sync token is not configured".to_string());
    }

    let candidates = archive_candidates(&app_data_dir, &settings, Local::now())?;
    let total = candidates.len();
    let _ = add_event(
        &app_data_dir,
        ARCHIVE_EVENT_SESSION_ID,
        "brain_archive_upload_started",
        &format!("Uploading {total} archived Brain sessions"),
    );

    let mut summary = BrainArchiveUploadSummary {
        total,
        uploaded: 0,
        skipped: 0,
        failed: 0,
        errors: Vec::new(),
    };

    emit_progress(progress_from_summary(total, 0, &summary, None, None))?;

    for candidate in candidates {
        let processed = summary.uploaded + summary.skipped + summary.failed + 1;
        let session_id = candidate.meta.session_id.clone();
        let title = if candidate.meta.topic.trim().is_empty() {
            session_id.clone()
        } else {
            candidate.meta.topic.clone()
        };

        match upload_session_after_record_with_client(
            app_data_dir.clone(),
            candidate.session_dir,
            candidate.meta,
            candidate.audio_path,
            settings.clone(),
            client,
            false,
        )
        .await
        {
            Ok(response) if response.duplicate.unwrap_or(false) => {
                summary.skipped += 1;
                archive_error(&mut summary.errors, format!("{session_id}: already_uploaded"));
            }
            Ok(_) => {
                summary.uploaded += 1;
            }
            Err(err) => {
                summary.failed += 1;
                archive_error(&mut summary.errors, sanitize_error(err, &token));
            }
        }

        emit_progress(progress_from_summary(
            total,
            processed,
            &summary,
            Some(session_id),
            Some(title),
        ))?;
    }

    let _ = add_event(
        &app_data_dir,
        ARCHIVE_EVENT_SESSION_ID,
        "brain_archive_upload_finished",
        &format!(
            "uploaded={}, skipped={}, failed={}",
            summary.uploaded, summary.skipped, summary.failed
        ),
    );
    Ok(summary)
}

#[tauri::command]
pub async fn brain_sync_upload_archive(
    app: AppHandle,
    dirs: State<'_, AppDirs>,
) -> Result<BrainArchiveUploadSummary, String> {
    let settings = load_settings(&dirs.app_data_dir)?;
    let client = BrainServerClient::new();
    upload_archive_with_client(
        dirs.app_data_dir.clone(),
        settings,
        &client,
        |progress| app.emit(ARCHIVE_PROGRESS_EVENT, progress).map_err(|e| e.to_string()),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::{SessionMeta, SessionStatus};
    use crate::services::brain_server::client::{
        BrainUploadError, BrainUploadMetadata, BrainUploadResponse,
    };
    use crate::services::brain_server::upload::UploadAudioClient;
    use crate::settings::public_settings::{save_settings, PublicSettings};
    use crate::settings::secret_store::set_secret;
    use crate::storage::session_store::save_meta;
    use crate::storage::sqlite_repo::{add_event, upsert_session};
    use async_trait::async_trait;
    use rusqlite::{params, Connection};
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    #[test]
    fn token_key_matches_brain_server_secret_name() {
        assert_eq!(TOKEN_KEY, "BRAIN_SERVER_API_TOKEN");
    }

    #[derive(Clone)]
    enum UploadOutcome {
        Success,
        Duplicate,
        Failure(String),
    }

    struct ArchiveUploadClient {
        calls: Arc<Mutex<Vec<String>>>,
        outcomes: Arc<Mutex<Vec<UploadOutcome>>>,
    }

    #[async_trait]
    impl UploadAudioClient for ArchiveUploadClient {
        async fn upload_audio(
            &self,
            _url: &str,
            _token: &str,
            _audio_path: &Path,
            metadata: &BrainUploadMetadata,
        ) -> Result<BrainUploadResponse, BrainUploadError> {
            self.calls
                .lock()
                .expect("calls lock")
                .push(metadata.session_id.clone());
            let outcome = self
                .outcomes
                .lock()
                .expect("outcomes lock")
                .remove(0);
            match outcome {
                UploadOutcome::Success => Ok(BrainUploadResponse {
                    ok: true,
                    job_id: Some(1),
                    status: Some("queued".to_string()),
                    principal_id: None,
                    workspace_id: None,
                    workspace_slug: None,
                    inbox_path: None,
                    meta_path: None,
                    duplicate: None,
                    error: None,
                }),
                UploadOutcome::Duplicate => Ok(BrainUploadResponse {
                    ok: true,
                    job_id: None,
                    status: Some("already_uploaded".to_string()),
                    principal_id: None,
                    workspace_id: None,
                    workspace_slug: None,
                    inbox_path: None,
                    meta_path: None,
                    duplicate: Some(true),
                    error: None,
                }),
                UploadOutcome::Failure(message) => Err(BrainUploadError::Api(message)),
            }
        }
    }

    fn archive_settings() -> PublicSettings {
        PublicSettings {
            brain_sync_enabled: false,
            brain_sync_url: "https://brain.example/upload".to_string(),
            ..Default::default()
        }
    }

    fn seed_archive_session(
        app_data_dir: &Path,
        session_id: &str,
        started_at_iso: &str,
        write_audio: bool,
    ) {
        seed_archive_session_with_audio_file(
            app_data_dir,
            session_id,
            started_at_iso,
            "audio.opus".to_string(),
            write_audio,
        );
    }

    fn seed_archive_session_with_audio_file(
        app_data_dir: &Path,
        session_id: &str,
        started_at_iso: &str,
        audio_file: String,
        write_audio: bool,
    ) {
        let session_dir = app_data_dir.join("recordings").join(session_id);
        seed_archive_session_at_dir(
            app_data_dir,
            &session_dir,
            session_id,
            started_at_iso,
            audio_file,
            write_audio,
        );
    }

    fn seed_archive_session_at_dir(
        app_data_dir: &Path,
        session_dir: &Path,
        session_id: &str,
        started_at_iso: &str,
        audio_file: String,
        write_audio: bool,
    ) {
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let meta_path = session_dir.join("meta.json");
        let mut meta = SessionMeta::new(
            session_id.to_string(),
            "zoom".to_string(),
            vec!["team".to_string()],
            format!("Topic {session_id}"),
            "notes".to_string(),
        );
        meta.status = SessionStatus::Done;
        meta.started_at_iso = started_at_iso.to_string();
        meta.created_at_iso = started_at_iso.to_string();
        meta.artifacts.audio_file = audio_file;
        save_meta(&meta_path, &meta).expect("save meta");
        if write_audio {
            std::fs::write(session_dir.join(&meta.artifacts.audio_file), b"OggS")
                .expect("write audio");
        }
        upsert_session(app_data_dir, &meta, session_dir, &meta_path).expect("upsert session");
    }

    fn mark_last_event_at(app_data_dir: &Path, session_id: &str, at_iso: &str) {
        let conn = Connection::open(app_data_dir.join("bigecho.sqlite3")).expect("open sqlite");
        conn.execute(
            "
            UPDATE session_events
            SET at_iso = ?1
            WHERE id = (
                SELECT id FROM session_events WHERE session_id = ?2 ORDER BY id DESC LIMIT 1
            )
            ",
            params![at_iso, session_id],
        )
        .expect("update event time");
    }

    fn archive_client(
        outcomes: Vec<UploadOutcome>,
    ) -> (ArchiveUploadClient, Arc<Mutex<Vec<String>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        (
            ArchiveUploadClient {
                calls: Arc::clone(&calls),
                outcomes: Arc::new(Mutex::new(outcomes)),
            },
            calls,
        )
    }

    #[tokio::test]
    async fn archive_upload_ignores_sessions_without_audio() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "without-audio", "2026-05-28T10:00:00+03:00", false);
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert_eq!(summary.uploaded, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_skips_empty_audio_file_name() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session_with_audio_file(
            &app_data_dir,
            "empty-audio",
            "2026-05-28T10:00:00+03:00",
            "   ".to_string(),
            false,
        );
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_skips_directory_audio_path() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session_with_audio_file(
            &app_data_dir,
            "directory-audio",
            "2026-05-28T10:00:00+03:00",
            "audio-dir".to_string(),
            false,
        );
        std::fs::create_dir_all(
            app_data_dir
                .join("recordings")
                .join("directory-audio")
                .join("audio-dir"),
        )
        .expect("create audio dir");
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_skips_absolute_audio_path() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        let outside_audio = tmp.path().join("outside.opus");
        std::fs::write(&outside_audio, b"OggS").expect("write outside audio");
        seed_archive_session_with_audio_file(
            &app_data_dir,
            "absolute-audio",
            "2026-05-28T10:00:00+03:00",
            outside_audio.to_string_lossy().to_string(),
            false,
        );
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_upload_skips_symlink_audio_path() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session_with_audio_file(
            &app_data_dir,
            "symlink-audio",
            "2026-05-28T10:00:00+03:00",
            "audio.opus".to_string(),
            false,
        );
        let outside_audio = tmp.path().join("outside.opus");
        std::fs::write(&outside_audio, b"OggS").expect("write outside audio");
        std::os::unix::fs::symlink(
            &outside_audio,
            app_data_dir
                .join("recordings")
                .join("symlink-audio")
                .join("audio.opus"),
        )
        .expect("create audio symlink");
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_upload_skips_symlinked_parent_audio_path() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session_with_audio_file(
            &app_data_dir,
            "symlink-parent-audio",
            "2026-05-28T10:00:00+03:00",
            "linkdir/audio.opus".to_string(),
            false,
        );
        let outside_dir = tmp.path().join("outside-dir");
        std::fs::create_dir_all(&outside_dir).expect("create outside dir");
        std::fs::write(outside_dir.join("audio.opus"), b"OggS").expect("write outside audio");
        std::os::unix::fs::symlink(
            &outside_dir,
            app_data_dir
                .join("recordings")
                .join("symlink-parent-audio")
                .join("linkdir"),
        )
        .expect("create parent dir symlink");
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_skips_session_dir_outside_recording_root() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let recording_root = app_data_dir.join("recordings");
        let outside_session_dir = tmp.path().join("forged-session");
        let mut settings = archive_settings();
        settings.recording_root = recording_root.to_string_lossy().to_string();
        save_settings(&app_data_dir, &settings).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session_at_dir(
            &app_data_dir,
            &outside_session_dir,
            "forged-session",
            "2026-05-28T10:00:00+03:00",
            "audio.opus".to_string(),
            true,
        );
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            settings,
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_skips_uploaded_sessions() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "uploaded", "2026-05-28T10:00:00+03:00", true);
        add_event(&app_data_dir, "uploaded", "brain_upload_succeeded", "ok").expect("add event");
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert_eq!(summary.skipped, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_includes_failed_and_not_uploaded_sessions_oldest_first() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "new-not-uploaded", "2026-05-28T12:00:00+03:00", true);
        seed_archive_session(&app_data_dir, "old-failed", "2026-05-28T09:00:00+03:00", true);
        add_event(&app_data_dir, "old-failed", "brain_upload_failed", "network")
            .expect("add event");
        let (client, calls) =
            archive_client(vec![UploadOutcome::Success, UploadOutcome::Success]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 2);
        assert_eq!(summary.uploaded, 2);
        assert_eq!(
            calls.lock().expect("calls lock").as_slice(),
            &["old-failed".to_string(), "new-not-uploaded".to_string()]
        );
    }

    #[tokio::test]
    async fn archive_upload_continues_after_one_upload_failure() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "first", "2026-05-28T09:00:00+03:00", true);
        seed_archive_session(&app_data_dir, "second", "2026-05-28T10:00:00+03:00", true);
        let (client, calls) = archive_client(vec![
            UploadOutcome::Failure("server echoed secret-token".to_string()),
            UploadOutcome::Success,
        ]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 2);
        assert_eq!(summary.uploaded, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.errors.len(), 1);
        assert!(!summary.errors[0].contains("secret-token"));
        assert_eq!(calls.lock().expect("calls lock").len(), 2);
    }

    #[tokio::test]
    async fn archive_upload_counts_duplicate_response_as_skipped() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "dupe", "2026-05-28T09:00:00+03:00", true);
        let (client, _calls) = archive_client(vec![UploadOutcome::Duplicate]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 1);
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.errors, vec!["dupe: already_uploaded".to_string()]);
    }

    #[tokio::test]
    async fn archive_upload_skips_fresh_uploading_session() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "fresh-uploading", "2026-05-28T09:00:00+03:00", true);
        add_event(
            &app_data_dir,
            "fresh-uploading",
            "brain_upload_started",
            "Uploading audio to Brain",
        )
        .expect("add event");
        let (client, calls) = archive_client(vec![]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 0);
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_includes_stale_uploading_session() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "stale-uploading", "2026-05-28T09:00:00+03:00", true);
        add_event(
            &app_data_dir,
            "stale-uploading",
            "brain_upload_started",
            "Uploading audio to Brain",
        )
        .expect("add event");
        let stale_at = (Local::now() - Duration::minutes(31)).to_rfc3339();
        mark_last_event_at(&app_data_dir, "stale-uploading", &stale_at);
        let (client, calls) = archive_client(vec![UploadOutcome::Success]);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 1);
        assert_eq!(summary.uploaded, 1);
        assert_eq!(
            calls.lock().expect("calls lock").as_slice(),
            &["stale-uploading".to_string()]
        );
    }

    #[tokio::test]
    async fn archive_upload_missing_token_aborts_before_processing() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        seed_archive_session(&app_data_dir, "needs-token", "2026-05-28T09:00:00+03:00", true);
        let (client, calls) = archive_client(vec![UploadOutcome::Success]);
        let progress_events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&progress_events);

        let err = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            move |progress| {
                captured.lock().expect("progress lock").push(progress);
                Ok(())
            },
        )
        .await
        .expect_err("missing token aborts");

        assert_eq!(err, "Brain sync token is not configured");
        assert!(calls.lock().expect("calls lock").is_empty());
        assert!(progress_events.lock().expect("progress lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_invalid_url_aborts_before_processing() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "bad-url", "2026-05-28T09:00:00+03:00", true);
        let (client, calls) = archive_client(vec![UploadOutcome::Success]);
        let mut settings = archive_settings();
        settings.brain_sync_url = "not-a-url".to_string();
        let progress_events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&progress_events);

        let err = upload_archive_with_client(
            app_data_dir,
            settings,
            &client,
            move |progress| {
                captured.lock().expect("progress lock").push(progress);
                Ok(())
            },
        )
        .await
        .expect_err("invalid url aborts");

        assert_eq!(err, "Invalid Brain sync URL");
        assert!(calls.lock().expect("calls lock").is_empty());
        assert!(progress_events.lock().expect("progress lock").is_empty());
    }

    #[tokio::test]
    async fn archive_upload_caps_errors() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        let mut outcomes = Vec::new();
        for idx in 0..(MAX_ARCHIVE_ERRORS + 5) {
            seed_archive_session(
                &app_data_dir,
                &format!("failed-{idx:02}"),
                &format!("2026-05-28T09:{idx:02}:00+03:00"),
                true,
            );
            outcomes.push(UploadOutcome::Failure(format!("network-{idx}")));
        }
        let (client, calls) = archive_client(outcomes);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            |_| Ok(()),
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, MAX_ARCHIVE_ERRORS + 5);
        assert_eq!(summary.failed, MAX_ARCHIVE_ERRORS + 5);
        assert_eq!(summary.errors.len(), MAX_ARCHIVE_ERRORS);
        assert_eq!(calls.lock().expect("calls lock").len(), MAX_ARCHIVE_ERRORS + 5);
    }

    #[tokio::test]
    async fn archive_upload_progress_includes_counters() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        save_settings(&app_data_dir, &archive_settings()).expect("save settings");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        seed_archive_session(&app_data_dir, "ok", "2026-05-28T09:00:00+03:00", true);
        seed_archive_session(&app_data_dir, "dupe", "2026-05-28T10:00:00+03:00", true);
        seed_archive_session(&app_data_dir, "bad", "2026-05-28T11:00:00+03:00", true);
        let (client, _calls) = archive_client(vec![
            UploadOutcome::Success,
            UploadOutcome::Duplicate,
            UploadOutcome::Failure("network".to_string()),
        ]);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);

        let summary = upload_archive_with_client(
            app_data_dir,
            archive_settings(),
            &client,
            move |progress| {
                captured.lock().expect("events lock").push(progress);
                Ok(())
            },
        )
        .await
        .expect("archive upload succeeds");

        assert_eq!(summary.total, 3);
        let events = events.lock().expect("events lock");
        let final_progress = events.last().expect("final progress");
        assert_eq!(final_progress.total, 3);
        assert_eq!(final_progress.processed, 3);
        assert_eq!(final_progress.uploaded, 1);
        assert_eq!(final_progress.skipped, 1);
        assert_eq!(final_progress.failed, 1);
    }
}
