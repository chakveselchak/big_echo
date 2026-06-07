use crate::domain::session::{SessionMeta, SessionStatus};
use crate::storage::session_store::load_meta;
use chrono::DateTime;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration as StdDuration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrainUploadStatus {
    NotUploaded,
    Uploading,
    Uploaded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainUploadState {
    pub status: BrainUploadStatus,
    pub server_ingested_once: bool,
    pub last_error: Option<String>,
    pub updated_at_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionListMeta {
    pub session_id: String,
    pub source: String,
    pub notes: String,
    pub custom_summary_prompt: String,
    pub custom_summary_prompt_name: String,
    pub topic: String,
    pub tags: Vec<String>,
    #[serde(default)]
    pub num_speakers: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionListItem {
    pub session_id: String,
    pub status: String,
    pub primary_tag: String,
    pub topic: String,
    pub display_date_ru: String,
    pub started_at_iso: String,
    pub session_dir: String,
    pub audio_file: String,
    pub audio_format: String,
    pub audio_duration_hms: String,
    pub has_transcript_text: bool,
    pub has_summary_text: bool,
    pub brain_upload_status: BrainUploadStatus,
    #[serde(default)]
    pub brain_server_ingested_once: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brain_upload_last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brain_upload_updated_at_iso: Option<String>,
    pub meta: Option<SessionListMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryJob {
    pub session_id: String,
    pub attempts: i64,
    pub next_run_epoch: i64,
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub id: i64,
    pub session_id: String,
    pub at_iso: String,
    pub event_type: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SummaryPromptView {
    pub name: String,
    pub prompt: String,
    pub created_at_iso: String,
    pub updated_at_iso: String,
}

pub const BRAIN_UPLOAD_FRESH_MINUTES: i64 = 30;

pub fn brain_upload_is_fresh(
    updated_at_iso: Option<&str>,
    now: chrono::DateTime<chrono::Local>,
) -> bool {
    let Some(at_iso) = updated_at_iso else {
        return false;
    };
    chrono::DateTime::parse_from_rfc3339(at_iso)
        .map(|started| {
            let age = now.signed_duration_since(started.with_timezone(&now.timezone()));
            age >= chrono::Duration::zero()
                && age < chrono::Duration::minutes(BRAIN_UPLOAD_FRESH_MINUTES)
        })
        .unwrap_or(false)
}

pub fn derive_brain_upload_state(events: &[SessionEvent]) -> BrainUploadState {
    let mut state = BrainUploadState {
        status: BrainUploadStatus::NotUploaded,
        server_ingested_once: false,
        last_error: None,
        updated_at_iso: None,
    };
    for event in events {
        match event.event_type.as_str() {
            "brain_upload_started" => {
                state.status = BrainUploadStatus::Uploading;
                state.last_error = None;
                state.updated_at_iso = Some(event.at_iso.clone());
            }
            "brain_upload_succeeded" => {
                state.server_ingested_once = true;
                state.status = BrainUploadStatus::Uploaded;
                state.last_error = None;
                state.updated_at_iso = Some(event.at_iso.clone());
            }
            "brain_upload_failed" | "brain_upload_interrupted" => {
                state.status = BrainUploadStatus::Failed;
                state.last_error = Some(event.detail.clone());
                state.updated_at_iso = Some(event.at_iso.clone());
            }
            "brain_upload_skipped" => {}
            _ => {}
        }
    }
    state
}

pub fn reconcile_stale_brain_uploads(app_data_dir: &Path) -> Result<(), String> {
    let now = chrono::Local::now();
    let conn = open(app_data_dir)?;
    let states = list_brain_upload_states(&conn)?;
    for (session_id, state) in states {
        if state.status != BrainUploadStatus::Uploading {
            continue;
        }
        if brain_upload_is_fresh(state.updated_at_iso.as_deref(), now) {
            continue;
        }
        add_event(
            app_data_dir,
            &session_id,
            "brain_upload_interrupted",
            "Предыдущая загрузка Brain не завершилась. Можно повторить.",
        )?;
    }
    Ok(())
}

fn db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bigecho.sqlite3")
}

fn file_has_non_empty_text(path: &Path) -> bool {
    let content = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return false,
    };
    !content.trim().is_empty()
}

fn audio_format_from_file_name(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn format_hms(total_seconds: i64) -> String {
    let safe = total_seconds.max(0);
    let hours = safe / 3600;
    let minutes = (safe % 3600) / 60;
    let seconds = safe % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

pub(crate) fn audio_duration_hms(meta: &SessionMeta) -> String {
    let started = match DateTime::parse_from_rfc3339(&meta.started_at_iso) {
        Ok(value) => value,
        Err(_) => return "00:00:00".to_string(),
    };
    let ended = match meta
        .ended_at_iso
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    {
        Some(value) => value,
        None => return "00:00:00".to_string(),
    };
    format_hms(ended.signed_duration_since(started).num_seconds())
}

fn open(app_data_dir: &Path) -> Result<Connection, String> {
    open_connection(app_data_dir)
}

pub fn open_connection(app_data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let path = db_path(app_data_dir);
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(StdDuration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            primary_tag TEXT NOT NULL,
            topic TEXT NOT NULL,
            display_date_ru TEXT NOT NULL,
            started_at_iso TEXT NOT NULL,
            session_dir TEXT NOT NULL,
            meta_path TEXT NOT NULL,
            updated_at_iso TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            at_iso TEXT NOT NULL,
            event_type TEXT NOT NULL,
            detail TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pipeline_retry_jobs (
            session_id TEXT PRIMARY KEY,
            attempts INTEGER NOT NULL,
            next_run_epoch INTEGER NOT NULL,
            last_error TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS summary_prompts (
            name TEXT PRIMARY KEY,
            prompt TEXT NOT NULL,
            created_at_iso TEXT NOT NULL,
            updated_at_iso TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| e.to_string())?;
    crate::task_sync::queue::ensure_schema(&conn)?;
    Ok(conn)
}

fn row_to_summary_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<SummaryPromptView> {
    Ok(SummaryPromptView {
        name: row.get(0)?,
        prompt: row.get(1)?,
        created_at_iso: row.get(2)?,
        updated_at_iso: row.get(3)?,
    })
}

pub fn list_summary_prompts(app_data_dir: &Path) -> Result<Vec<SummaryPromptView>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn
        .prepare(
            "SELECT name, prompt, created_at_iso, updated_at_iso
             FROM summary_prompts
             ORDER BY name COLLATE NOCASE ASC, name ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_summary_prompt)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn get_summary_prompt(app_data_dir: &Path, name: &str) -> Result<SummaryPromptView, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Prompt name is required".to_string());
    }
    let conn = open(app_data_dir)?;
    conn.query_row(
        "SELECT name, prompt, created_at_iso, updated_at_iso
         FROM summary_prompts
         WHERE name=?1",
        params![name],
        row_to_summary_prompt,
    )
    .map_err(|err| {
        if matches!(err, rusqlite::Error::QueryReturnedNoRows) {
            format!("Summary prompt not found: {name}")
        } else {
            err.to_string()
        }
    })
}

pub fn upsert_summary_prompt(
    app_data_dir: &Path,
    name: &str,
    prompt: &str,
) -> Result<SummaryPromptView, String> {
    let name = name.trim();
    let prompt = prompt.trim();
    if name.is_empty() {
        return Err("Prompt name is required".to_string());
    }
    if prompt.is_empty() {
        return Err("Prompt text is required".to_string());
    }

    let conn = open(app_data_dir)?;
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "
        INSERT INTO summary_prompts (name, prompt, created_at_iso, updated_at_iso)
        VALUES (?1, ?2, ?3, ?3)
        ON CONFLICT(name) DO UPDATE SET
            prompt=excluded.prompt,
            updated_at_iso=excluded.updated_at_iso
        ",
        params![name, prompt, now],
    )
    .map_err(|e| e.to_string())?;
    get_summary_prompt(app_data_dir, name)
}

fn count_sessions_using_summary_prompt(app_data_dir: &Path, name: &str) -> Result<usize, String> {
    let sessions = list_sessions(app_data_dir)?;
    let mut count = 0usize;
    for item in sessions {
        let Some(meta_path) = get_meta_path(app_data_dir, &item.session_id)? else {
            continue;
        };
        let meta = match load_meta(&meta_path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.custom_summary_prompt_name.trim() == name {
            count += 1;
        }
    }
    Ok(count)
}

pub fn delete_summary_prompt(app_data_dir: &Path, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Prompt name is required".to_string());
    }
    let used_count = count_sessions_using_summary_prompt(app_data_dir, name)?;
    if used_count > 0 {
        return Err(format!(
            "Summary prompt is used by {used_count} session(s): {name}"
        ));
    }
    let conn = open(app_data_dir)?;
    let deleted = conn
        .execute("DELETE FROM summary_prompts WHERE name=?1", params![name])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("Summary prompt not found: {name}"));
    }
    Ok(())
}

pub fn upsert_session(
    app_data_dir: &Path,
    meta: &SessionMeta,
    session_dir: &Path,
    meta_path: &Path,
) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "
        INSERT INTO sessions (
            session_id, status, primary_tag, topic, display_date_ru,
            started_at_iso, session_dir, meta_path, updated_at_iso
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(session_id) DO UPDATE SET
            status=excluded.status,
            primary_tag=excluded.primary_tag,
            topic=excluded.topic,
            display_date_ru=excluded.display_date_ru,
            started_at_iso=excluded.started_at_iso,
            session_dir=excluded.session_dir,
            meta_path=excluded.meta_path,
            updated_at_iso=excluded.updated_at_iso
        ",
        params![
            meta.session_id,
            format!("{:?}", meta.status).to_lowercase(),
            meta.primary_tag,
            meta.topic,
            meta.display_date_ru,
            meta.started_at_iso,
            session_dir.to_string_lossy().to_string(),
            meta_path.to_string_lossy().to_string(),
            chrono::Local::now().to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn add_event(
    app_data_dir: &Path,
    session_id: &str,
    event_type: &str,
    detail: &str,
) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "INSERT INTO session_events(session_id, at_iso, event_type, detail) VALUES (?1, ?2, ?3, ?4)",
        params![session_id, chrono::Local::now().to_rfc3339(), event_type, detail],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_session_events(
    app_data_dir: &Path,
    session_id: &str,
) -> Result<Vec<SessionEvent>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT id, session_id, at_iso, event_type, detail
            FROM session_events
            WHERE session_id = ?1
            ORDER BY id ASC
            ",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(SessionEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                at_iso: row.get(2)?,
                event_type: row.get(3)?,
                detail: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn list_brain_upload_states(
    conn: &Connection,
) -> Result<HashMap<String, BrainUploadState>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT id, session_id, at_iso, event_type, detail
            FROM session_events
            WHERE event_type IN (
                'brain_upload_started',
                'brain_upload_succeeded',
                'brain_upload_failed',
                'brain_upload_interrupted',
                'brain_upload_skipped'
            )
            ORDER BY session_id ASC, id ASC
            ",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SessionEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                at_iso: row.get(2)?,
                event_type: row.get(3)?,
                detail: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut grouped: HashMap<String, Vec<SessionEvent>> = HashMap::new();
    for row in rows {
        let event = row.map_err(|e| e.to_string())?;
        grouped
            .entry(event.session_id.clone())
            .or_default()
            .push(event);
    }
    Ok(grouped
        .into_iter()
        .map(|(session_id, events)| (session_id, derive_brain_upload_state(&events)))
        .collect())
}

pub fn list_sessions(app_data_dir: &Path) -> Result<Vec<SessionListItem>, String> {
    reconcile_stale_brain_uploads(app_data_dir)?;
    let conn = open(app_data_dir)?;
    let brain_upload_states = list_brain_upload_states(&conn)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT session_id, status, primary_tag, topic, display_date_ru, started_at_iso, session_dir
            FROM sessions
            ORDER BY started_at_iso DESC
            ",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SessionListItem {
                session_id: row.get(0)?,
                status: row.get(1)?,
                primary_tag: row.get(2)?,
                topic: row.get(3)?,
                display_date_ru: row.get(4)?,
                started_at_iso: row.get(5)?,
                session_dir: row.get(6)?,
                audio_file: String::new(),
                audio_format: "unknown".to_string(),
                audio_duration_hms: "00:00:00".to_string(),
                has_transcript_text: false,
                has_summary_text: false,
                brain_upload_status: BrainUploadStatus::NotUploaded,
                brain_server_ingested_once: false,
                brain_upload_last_error: None,
                brain_upload_updated_at_iso: None,
                meta: None,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let mut item = row.map_err(|e| e.to_string())?;
        if let Some(brain_upload_state) = brain_upload_states.get(&item.session_id) {
            item.brain_upload_status = brain_upload_state.status.clone();
            item.brain_server_ingested_once = brain_upload_state.server_ingested_once;
            item.brain_upload_last_error = brain_upload_state.last_error.clone();
            item.brain_upload_updated_at_iso = brain_upload_state.updated_at_iso.clone();
        }
        if let Some(meta_path) = get_meta_path(app_data_dir, &item.session_id)? {
            match load_meta(&meta_path) {
                Err(err) => {
                    eprintln!(
                        "list_sessions: failed to load meta for session {} at {}: {}",
                        item.session_id,
                        meta_path.display(),
                        err
                    );
                    out.push(item);
                    continue;
                }
                Ok(meta) => {
                    let session_dir = PathBuf::from(&item.session_dir);
                    let transcript_ok =
                        file_has_non_empty_text(&session_dir.join(&meta.artifacts.transcript_file));
                    let summary_ok =
                        file_has_non_empty_text(&session_dir.join(&meta.artifacts.summary_file));
                    item.audio_file = meta.artifacts.audio_file.clone();
                    item.audio_format = audio_format_from_file_name(&meta.artifacts.audio_file);
                    item.audio_duration_hms = audio_duration_hms(&meta);
                    item.has_transcript_text = transcript_ok
                        && !matches!(
                            meta.status,
                            SessionStatus::Recording | SessionStatus::Recorded
                        );
                    item.has_summary_text = summary_ok
                        && matches!(meta.status, SessionStatus::Summarized | SessionStatus::Done);
                    item.meta = Some(SessionListMeta {
                        session_id: meta.session_id.clone(),
                        source: meta.source.clone(),
                        notes: meta.notes.clone(),
                        custom_summary_prompt: meta.custom_summary_prompt.clone(),
                        custom_summary_prompt_name: meta.custom_summary_prompt_name.clone(),
                        topic: meta.topic.clone(),
                        tags: meta.tags.clone(),
                        num_speakers: meta.num_speakers,
                    });
                }
            }
        }
        out.push(item);
    }
    Ok(out)
}

pub fn get_meta_path(app_data_dir: &Path, session_id: &str) -> Result<Option<PathBuf>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn
        .prepare("SELECT meta_path FROM sessions WHERE session_id=?1")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt.query(params![session_id]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let p: String = row.get(0).map_err(|e| e.to_string())?;
        return Ok(Some(PathBuf::from(p)));
    }
    Ok(None)
}

pub fn get_session_dir(app_data_dir: &Path, session_id: &str) -> Result<Option<PathBuf>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn
        .prepare("SELECT session_dir FROM sessions WHERE session_id=?1")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt.query(params![session_id]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let p: String = row.get(0).map_err(|e| e.to_string())?;
        return Ok(Some(PathBuf::from(p)));
    }
    Ok(None)
}

/// Returns all (session_id, session_dir) pairs from the DB — used by sync to
/// detect sessions whose directories have been removed from the filesystem.
pub fn list_session_id_dirs(app_data_dir: &Path) -> Result<Vec<(String, String)>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn
        .prepare("SELECT session_id, session_dir FROM sessions")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn delete_session(app_data_dir: &Path, session_id: &str) -> Result<bool, String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "DELETE FROM pipeline_retry_jobs WHERE session_id=?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM session_events WHERE session_id=?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM task_sync_queue WHERE source_session_id=?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    let deleted = conn
        .execute(
            "DELETE FROM sessions WHERE session_id=?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(deleted > 0)
}

pub fn schedule_retry_job(
    app_data_dir: &Path,
    session_id: &str,
    last_error: &str,
    max_attempts: i64,
) -> Result<Option<i64>, String> {
    let conn = open(app_data_dir)?;

    let current_attempts: i64 = conn
        .query_row(
            "SELECT attempts FROM pipeline_retry_jobs WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let attempts = current_attempts + 1;
    if attempts > max_attempts {
        conn.execute(
            "DELETE FROM pipeline_retry_jobs WHERE session_id=?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(None);
    }

    let delay_seconds = match attempts {
        1 => 30,
        2 => 120,
        3 => 600,
        _ => 1800,
    };
    let next_run_epoch = chrono::Utc::now().timestamp() + delay_seconds;

    conn.execute(
        "
        INSERT INTO pipeline_retry_jobs(session_id, attempts, next_run_epoch, last_error)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(session_id) DO UPDATE SET
            attempts=excluded.attempts,
            next_run_epoch=excluded.next_run_epoch,
            last_error=excluded.last_error
        ",
        params![session_id, attempts, next_run_epoch, last_error],
    )
    .map_err(|e| e.to_string())?;

    Ok(Some(attempts))
}

pub fn fetch_due_retry_jobs(
    app_data_dir: &Path,
    now_epoch: i64,
    limit: usize,
) -> Result<Vec<RetryJob>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT session_id, attempts, next_run_epoch, last_error
            FROM pipeline_retry_jobs
            WHERE next_run_epoch <= ?1
            ORDER BY next_run_epoch ASC, session_id ASC
            LIMIT ?2
            ",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![now_epoch, limit as i64], |row| {
            Ok(RetryJob {
                session_id: row.get(0)?,
                attempts: row.get(1)?,
                next_run_epoch: row.get(2)?,
                last_error: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn clear_retry_job(app_data_dir: &Path, session_id: &str) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "DELETE FROM pipeline_retry_jobs WHERE session_id=?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::{SessionMeta, SessionStatus};
    use crate::storage::session_store::save_meta;
    use chrono::{Duration, Local};

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn summary_prompts_schema_is_created_by_open_connection() {
        let tmp = temp_dir();
        let conn = open_connection(tmp.path()).expect("open sqlite");

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='summary_prompts'",
                [],
                |row| row.get(0),
            )
            .expect("schema query");

        assert_eq!(exists, 1);
    }

    #[test]
    fn upsert_summary_prompt_creates_and_updates_by_name() {
        let tmp = temp_dir();

        let created = upsert_summary_prompt(tmp.path(), " Decisions ", " First prompt ")
            .expect("create prompt");
        assert_eq!(created.name, "Decisions");
        assert_eq!(created.prompt, "First prompt");
        assert!(!created.created_at_iso.is_empty());
        assert_eq!(created.created_at_iso, created.updated_at_iso);

        let updated = upsert_summary_prompt(tmp.path(), "Decisions", "Updated prompt")
            .expect("update prompt");
        assert_eq!(updated.name, "Decisions");
        assert_eq!(updated.prompt, "Updated prompt");
        assert_eq!(updated.created_at_iso, created.created_at_iso);
        assert!(!updated.updated_at_iso.is_empty());

        let fetched = get_summary_prompt(tmp.path(), "Decisions").expect("get prompt");
        assert_eq!(fetched.prompt, "Updated prompt");
    }

    #[test]
    fn list_summary_prompts_returns_name_order() {
        let tmp = temp_dir();
        upsert_summary_prompt(tmp.path(), "Risks", "Risk prompt").expect("insert risks");
        upsert_summary_prompt(tmp.path(), "Actions", "Action prompt").expect("insert actions");

        let prompts = list_summary_prompts(tmp.path()).expect("list prompts");

        assert_eq!(
            prompts.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["Actions", "Risks"]
        );
    }

    #[test]
    fn delete_summary_prompt_removes_unused_prompt() {
        let tmp = temp_dir();
        upsert_summary_prompt(tmp.path(), "Actions", "Action prompt").expect("insert");

        delete_summary_prompt(tmp.path(), "Actions").expect("delete");

        let prompts = list_summary_prompts(tmp.path()).expect("list prompts");
        assert!(prompts.is_empty());
    }

    #[test]
    fn delete_summary_prompt_rejects_prompt_used_by_session_meta() {
        let tmp = temp_dir();
        upsert_summary_prompt(tmp.path(), "Actions", "Action prompt").expect("insert prompt");

        let session_dir = tmp.path().join("sessions").join("s-actions");
        std::fs::create_dir_all(&session_dir).expect("session dir");
        let meta_path = session_dir.join("meta.json");
        let mut meta = SessionMeta::new(
            "s-actions".to_string(),
            "zoom".to_string(),
            vec![],
            "Prompt use".to_string(),
            "".to_string(),
        );
        meta.custom_summary_prompt_name = "Actions".to_string();
        crate::storage::session_store::save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(tmp.path(), &meta, &session_dir, &meta_path).expect("upsert session");

        let err = delete_summary_prompt(tmp.path(), "Actions").expect_err("prompt in use");

        assert_eq!(err, "Summary prompt is used by 1 session(s): Actions");
    }

    #[test]
    fn summary_prompt_name_and_prompt_are_required() {
        let tmp = temp_dir();

        assert_eq!(
            upsert_summary_prompt(tmp.path(), "   ", "Prompt").expect_err("empty name"),
            "Prompt name is required"
        );
        assert_eq!(
            upsert_summary_prompt(tmp.path(), "Name", "   ").expect_err("empty prompt"),
            "Prompt text is required"
        );
    }

    #[test]
    fn list_sessions_enriches_derived_fields_from_meta_and_files() {
        let dir = temp_dir();
        let session_dir = dir.path().join("sessions").join("s-derived");
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let meta_path = session_dir.join("meta.json");

        let started = Local::now() - Duration::seconds(90);
        let ended = started + Duration::seconds(90);

        let mut meta = SessionMeta::new(
            "s-derived".to_string(),
            "zoom".to_string(),
            vec!["zoom".to_string()],
            "Weekly sync".to_string(),
            "Notes".to_string(),
        );
        meta.started_at_iso = started.to_rfc3339();
        meta.ended_at_iso = Some(ended.to_rfc3339());
        meta.status = SessionStatus::Done;
        meta.artifacts.audio_file = "audio.mp3".to_string();
        meta.artifacts.transcript_file = "transcript.txt".to_string();
        meta.artifacts.summary_file = "summary.md".to_string();

        save_meta(&meta_path, &meta).expect("save meta");
        std::fs::write(session_dir.join("transcript.txt"), "mock transcript")
            .expect("write transcript");
        std::fs::write(session_dir.join("summary.md"), "mock summary").expect("write summary");
        upsert_session(dir.path(), &meta, &session_dir, &meta_path).expect("upsert session");

        let sessions = list_sessions(dir.path()).expect("list sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].audio_format, "mp3");
        assert_eq!(sessions[0].audio_duration_hms, "00:01:30");
        assert!(sessions[0].has_transcript_text);
        assert!(sessions[0].has_summary_text);
    }

    #[test]
    fn list_sessions_derives_brain_upload_status_from_latest_event() {
        let dir = temp_dir();
        for (session_id, started_at) in [
            ("s-not-uploaded", "2026-05-28T10:00:00+03:00"),
            ("s-uploaded", "2026-05-28T11:00:00+03:00"),
            ("s-failed", "2026-05-28T12:00:00+03:00"),
        ] {
            let session_dir = dir.path().join("sessions").join(session_id);
            std::fs::create_dir_all(&session_dir).expect("create session dir");
            let meta_path = session_dir.join("meta.json");
            let mut meta = SessionMeta::new(
                session_id.to_string(),
                "slack".to_string(),
                vec!["slack".to_string()],
                session_id.to_string(),
                "".to_string(),
            );
            meta.started_at_iso = started_at.to_string();
            meta.status = SessionStatus::Done;
            save_meta(&meta_path, &meta).expect("save meta");
            upsert_session(dir.path(), &meta, &session_dir, &meta_path).expect("upsert session");
        }

        add_event(
            dir.path(),
            "s-uploaded",
            "brain_upload_failed",
            "old failure",
        )
        .expect("add old failed event");
        add_event(dir.path(), "s-uploaded", "brain_upload_succeeded", "ok")
            .expect("add success event");
        add_event(
            dir.path(),
            "s-uploaded",
            "brain_upload_failed",
            "retry failed",
        )
        .expect("add retry failure event");
        add_event(dir.path(), "s-failed", "brain_upload_started", "started")
            .expect("add started event");
        add_event(
            dir.path(),
            "s-failed",
            "brain_upload_failed",
            "network down",
        )
        .expect("add failed event");

        let sessions = list_sessions(dir.path()).expect("list sessions");
        let by_id = |id: &str| {
            sessions
                .iter()
                .find(|session| session.session_id == id)
                .expect("session exists")
        };

        assert_eq!(
            by_id("s-not-uploaded").brain_upload_status,
            BrainUploadStatus::NotUploaded
        );
        assert_eq!(
            by_id("s-uploaded").brain_upload_status,
            BrainUploadStatus::Failed
        );
        assert!(by_id("s-uploaded").brain_server_ingested_once);
        assert_eq!(
            by_id("s-uploaded").brain_upload_last_error.as_deref(),
            Some("retry failed")
        );
        assert_eq!(
            by_id("s-failed").brain_upload_status,
            BrainUploadStatus::Failed
        );
        assert_eq!(
            by_id("s-failed").brain_upload_last_error.as_deref(),
            Some("network down")
        );
        assert!(by_id("s-failed").brain_upload_updated_at_iso.is_some());
    }

    #[test]
    fn list_brain_upload_states_shows_failed_retry_after_success() {
        let dir = temp_dir();
        let conn = open(dir.path()).expect("open db");

        add_event(
            dir.path(),
            "s-uploaded",
            "brain_upload_failed",
            "old failure",
        )
        .expect("add old failure");
        add_event(dir.path(), "s-uploaded", "brain_upload_succeeded", "ok").expect("add success");
        add_event(
            dir.path(),
            "s-uploaded",
            "brain_upload_failed",
            "retry failed",
        )
        .expect("add retry failure");
        add_event(dir.path(), "s-failed", "brain_upload_started", "started").expect("add started");
        add_event(
            dir.path(),
            "s-failed",
            "brain_upload_failed",
            "latest failure",
        )
        .expect("add latest failure");
        add_event(
            dir.path(),
            "s-ignored",
            "transcription_succeeded",
            "not a Brain status",
        )
        .expect("add unrelated event");

        let states = list_brain_upload_states(&conn).expect("list brain states");

        assert_eq!(
            states.get("s-uploaded").expect("uploaded state").status,
            BrainUploadStatus::Failed
        );
        assert!(
            states
                .get("s-uploaded")
                .expect("uploaded state")
                .server_ingested_once
        );
        assert_eq!(
            states.get("s-failed").expect("failed state").status,
            BrainUploadStatus::Failed
        );
        assert_eq!(
            states
                .get("s-failed")
                .expect("failed state")
                .last_error
                .as_deref(),
            Some("latest failure")
        );
        assert!(!states.contains_key("s-ignored"));
    }

    fn backdate_last_event(dir: &Path, session_id: &str, minutes_ago: i64) {
        let stale_at = (Local::now() - Duration::minutes(minutes_ago)).to_rfc3339();
        let conn = open(dir).expect("open db");
        conn.execute(
            "
            UPDATE session_events
            SET at_iso = ?1
            WHERE id = (
                SELECT id FROM session_events WHERE session_id = ?2 ORDER BY id DESC LIMIT 1
            )
            ",
            rusqlite::params![stale_at, session_id],
        )
        .expect("backdate event");
    }

    #[test]
    fn reconcile_stale_brain_uploads_persists_interrupted_event() {
        let dir = temp_dir();
        add_event(
            dir.path(),
            "s-stale",
            "brain_upload_started",
            "Uploading audio to Brain",
        )
        .expect("add started");
        backdate_last_event(dir.path(), "s-stale", BRAIN_UPLOAD_FRESH_MINUTES + 1);

        reconcile_stale_brain_uploads(dir.path()).expect("reconcile stale uploads");

        let events = list_session_events(dir.path(), "s-stale").expect("list events");
        assert!(events
            .iter()
            .any(|event| event.event_type == "brain_upload_interrupted"));
        let conn = open(dir.path()).expect("open db");
        let states = super::list_brain_upload_states(&conn).expect("list states");
        assert_eq!(
            states.get("s-stale").expect("stale state").status,
            BrainUploadStatus::Failed
        );
    }

    #[test]
    fn open_configures_wal_journal_mode() {
        let dir = temp_dir();
        let conn = open(dir.path()).expect("open db");
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");

        assert_eq!(mode.to_ascii_lowercase(), "wal");
    }

    #[test]
    fn schedules_retry_with_incremental_attempts_and_delays() {
        let dir = temp_dir();
        let session_id = "s-retry-1";
        let max_attempts = 4;

        let a1 = schedule_retry_job(dir.path(), session_id, "err1", max_attempts)
            .expect("schedule #1")
            .expect("attempt #1");
        let a2 = schedule_retry_job(dir.path(), session_id, "err2", max_attempts)
            .expect("schedule #2")
            .expect("attempt #2");

        assert_eq!(a1, 1);
        assert_eq!(a2, 2);

        let now = chrono::Utc::now().timestamp();
        let due_now = fetch_due_retry_jobs(dir.path(), now, 10).expect("fetch due now");
        assert!(due_now.is_empty());

        let due_future =
            fetch_due_retry_jobs(dir.path(), now + 10_000, 10).expect("fetch due in future");
        assert_eq!(due_future.len(), 1);
        assert_eq!(due_future[0].session_id, session_id);
        assert_eq!(due_future[0].attempts, 2);
        assert_eq!(due_future[0].last_error, "err2");
    }

    #[test]
    fn stops_scheduling_after_max_attempts() {
        let dir = temp_dir();
        let session_id = "s-retry-2";
        let max_attempts = 2;

        let r1 = schedule_retry_job(dir.path(), session_id, "e1", max_attempts).expect("r1");
        let r2 = schedule_retry_job(dir.path(), session_id, "e2", max_attempts).expect("r2");
        let r3 = schedule_retry_job(dir.path(), session_id, "e3", max_attempts).expect("r3");

        assert_eq!(r1, Some(1));
        assert_eq!(r2, Some(2));
        assert_eq!(r3, None);

        let due = fetch_due_retry_jobs(dir.path(), chrono::Utc::now().timestamp() + 100_000, 10)
            .expect("fetch due");
        assert!(due.iter().all(|j| j.session_id != session_id));
    }

    #[test]
    fn clears_retry_job() {
        let dir = temp_dir();
        let session_id = "s-retry-3";

        let _ = schedule_retry_job(dir.path(), session_id, "e1", 4).expect("schedule");
        clear_retry_job(dir.path(), session_id).expect("clear");

        let due = fetch_due_retry_jobs(dir.path(), chrono::Utc::now().timestamp() + 100_000, 10)
            .expect("fetch due");
        assert!(due.iter().all(|j| j.session_id != session_id));
    }
}
