use crate::task_sync::model::{ActionItem, TaskSyncStatus};
use chrono::Local;
use rusqlite::{params, Connection, TransactionBehavior};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

fn db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bigecho.sqlite3")
}

pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS task_sync_queue (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          due TEXT,
          priority INTEGER,
          assignee TEXT,
          context TEXT,
          source_session_id TEXT NOT NULL,
          source_file_path TEXT NOT NULL,
          external_task_id TEXT,
          status TEXT NOT NULL,
          error TEXT,
          error_kind TEXT,
          retryable INTEGER,
          created_at TEXT NOT NULL,
          queued_at TEXT,
          claimed_at TEXT,
          synced_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_task_sync_queue_session_provider
        ON task_sync_queue(source_session_id, provider);
        ",
    )
    .map_err(|e| e.to_string())?;

    add_column_if_missing(conn, "error_kind", "TEXT")?;
    add_column_if_missing(conn, "retryable", "INTEGER")?;
    add_column_if_missing(conn, "claimed_at", "TEXT")?;
    Ok(())
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;

    for row in rows {
        if row.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn add_column_if_missing(conn: &Connection, column: &str, definition: &str) -> Result<(), String> {
    if !table_has_column(conn, "task_sync_queue", column)? {
        conn.execute(
            &format!("ALTER TABLE task_sync_queue ADD COLUMN {column} {definition}"),
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn open(app_data_dir: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app_data_dir)).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn status_from_str(value: &str) -> TaskSyncStatus {
    match value {
        "queued" => TaskSyncStatus::Queued,
        "syncing" => TaskSyncStatus::Syncing,
        "synced" => TaskSyncStatus::Synced,
        "failed" => TaskSyncStatus::Failed,
        "skipped" => TaskSyncStatus::Skipped,
        _ => TaskSyncStatus::New,
    }
}

fn row_to_action_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActionItem> {
    let status: String = row.get(10)?;
    let retryable: Option<i64> = row.get(14)?;
    Ok(ActionItem {
        id: row.get(0)?,
        provider: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        due: row.get(4)?,
        priority: row.get(5)?,
        assignee: row.get(6)?,
        context: row.get(7)?,
        source_session_id: row.get(8)?,
        source_file_path: row.get(9)?,
        status: status_from_str(&status),
        external_task_id: row.get(11)?,
        error: row.get(12)?,
        error_kind: row.get(13)?,
        retryable: retryable.map(|value| value != 0),
    })
}

pub fn upsert_new_tasks(app_data_dir: &Path, items: &[ActionItem]) -> Result<(), String> {
    let mut conn = open(app_data_dir)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for item in items {
        tx.execute(
            "
            INSERT OR IGNORE INTO task_sync_queue (
                id, provider, title, description, due, priority, assignee, context,
                source_session_id, source_file_path, external_task_id, status, error,
                error_kind, retryable, created_at, queued_at, synced_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, 'new', NULL, NULL, NULL,
                ?11, NULL, NULL
            )
            ",
            params![
                item.id,
                item.provider,
                item.title,
                item.description,
                item.due,
                item.priority,
                item.assignee,
                item.context,
                item.source_session_id,
                item.source_file_path,
                Local::now().to_rfc3339(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn list_by_session(
    app_data_dir: &Path,
    session_id: &str,
    provider: &str,
) -> Result<Vec<ActionItem>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT
                id, provider, title, description, due, priority, assignee, context,
                source_session_id, source_file_path, status, external_task_id, error,
                error_kind, retryable
            FROM task_sync_queue
            WHERE source_session_id = ?1 AND provider = ?2
            ORDER BY created_at ASC, id ASC
            ",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id, provider], row_to_action_item)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn enqueue_tasks(
    app_data_dir: &Path,
    session_id: &str,
    provider: &str,
    ids: &[String],
) -> Result<(), String> {
    let mut conn = open(app_data_dir)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let queued_at = Local::now().to_rfc3339();
    for id in ids {
        tx.execute(
            "
            UPDATE task_sync_queue
            SET status = 'queued',
                error = NULL,
                error_kind = NULL,
                retryable = NULL,
                queued_at = ?1,
                claimed_at = NULL
            WHERE id = ?2
              AND source_session_id = ?3
              AND provider = ?4
              AND status IN ('new', 'failed', 'skipped')
            ",
            params![queued_at, id, session_id, provider],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn next_pending_batch(
    app_data_dir: &Path,
    session_id: Option<&str>,
    limit: i64,
) -> Result<Vec<ActionItem>, String> {
    let conn = open(app_data_dir)?;
    let sql = match session_id {
        Some(_) => {
            "
            SELECT
                id, provider, title, description, due, priority, assignee, context,
                source_session_id, source_file_path, status, external_task_id, error,
                error_kind, retryable
            FROM task_sync_queue
            WHERE status = 'queued' AND source_session_id = ?1
            ORDER BY queued_at ASC, created_at ASC, id ASC
            LIMIT ?2
            "
        }
        None => {
            "
            SELECT
                id, provider, title, description, due, priority, assignee, context,
                source_session_id, source_file_path, status, external_task_id, error,
                error_kind, retryable
            FROM task_sync_queue
            WHERE status = 'queued'
            ORDER BY queued_at ASC, created_at ASC, id ASC
            LIMIT ?1
            "
        }
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = match session_id {
        Some(session_id) => stmt
            .query_map(params![session_id, limit], row_to_action_item)
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(params![limit], row_to_action_item)
            .map_err(|e| e.to_string())?,
    };

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn claim_pending_batch(
    app_data_dir: &Path,
    session_id: Option<&str>,
    limit: i64,
) -> Result<Vec<ActionItem>, String> {
    let mut conn = open(app_data_dir)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let sql = match session_id {
        Some(_) => {
            "
            SELECT
                id, provider, title, description, due, priority, assignee, context,
                source_session_id, source_file_path, status, external_task_id, error,
                error_kind, retryable
            FROM task_sync_queue
            WHERE status = 'queued' AND source_session_id = ?1
            ORDER BY queued_at ASC, created_at ASC, id ASC
            LIMIT ?2
            "
        }
        None => {
            "
            SELECT
                id, provider, title, description, due, priority, assignee, context,
                source_session_id, source_file_path, status, external_task_id, error,
                error_kind, retryable
            FROM task_sync_queue
            WHERE status = 'queued'
            ORDER BY queued_at ASC, created_at ASC, id ASC
            LIMIT ?1
            "
        }
    };
    let mut stmt = tx.prepare(sql).map_err(|e| e.to_string())?;
    let rows = match session_id {
        Some(session_id) => stmt
            .query_map(params![session_id, limit], row_to_action_item)
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(params![limit], row_to_action_item)
            .map_err(|e| e.to_string())?,
    };

    let mut selected = Vec::new();
    for row in rows {
        selected.push(row.map_err(|e| e.to_string())?);
    }
    drop(stmt);

    let mut claimed = Vec::new();
    for mut item in selected {
        let updated = tx
            .execute(
                "
                UPDATE task_sync_queue
                SET status = 'syncing',
                    claimed_at = ?2
                WHERE id = ?1 AND status = 'queued'
                ",
                params![item.id, Local::now().to_rfc3339()],
            )
            .map_err(|e| e.to_string())?;
        if updated == 1 {
            item.status = TaskSyncStatus::Syncing;
            claimed.push(item);
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(claimed)
}

pub fn mark_synced(app_data_dir: &Path, id: &str, external_task_id: &str) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "
        UPDATE task_sync_queue
        SET status = 'synced',
            external_task_id = ?1,
            error = NULL,
            error_kind = NULL,
            retryable = NULL,
            claimed_at = NULL,
            synced_at = ?2
        WHERE id = ?3
        ",
        params![external_task_id, Local::now().to_rfc3339(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_failed(
    app_data_dir: &Path,
    id: &str,
    error: &str,
    retryable: bool,
) -> Result<(), String> {
    mark_failed_inner(app_data_dir, id, error, None, retryable)
}

pub fn mark_failed_with_kind(
    app_data_dir: &Path,
    id: &str,
    error: &str,
    kind: &str,
    retryable: bool,
) -> Result<(), String> {
    mark_failed_inner(app_data_dir, id, error, Some(kind), retryable)
}

fn mark_failed_inner(
    app_data_dir: &Path,
    id: &str,
    error: &str,
    kind: Option<&str>,
    retryable: bool,
) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "
        UPDATE task_sync_queue
        SET status = 'failed',
            error = ?1,
            error_kind = ?2,
            retryable = ?3,
            claimed_at = NULL
        WHERE id = ?4
        ",
        params![error, kind, if retryable { 1 } else { 0 }, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn prune_unsynced_absent(
    app_data_dir: &Path,
    session_id: &str,
    provider: &str,
    current_ids: &[String],
) -> Result<(), String> {
    let current_ids = current_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut conn = open(app_data_dir)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare(
            "
            SELECT id
            FROM task_sync_queue
            WHERE source_session_id = ?1
              AND provider = ?2
              AND status IN ('new', 'queued', 'failed', 'skipped')
            ",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id, provider], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    let mut stale_ids = Vec::new();
    for row in rows {
        let id = row.map_err(|e| e.to_string())?;
        if !current_ids.contains(id.as_str()) {
            stale_ids.push(id);
        }
    }
    drop(stmt);

    for id in stale_ids {
        tx.execute(
            "
            DELETE FROM task_sync_queue
            WHERE id = ?1
              AND source_session_id = ?2
              AND provider = ?3
              AND status IN ('new', 'queued', 'failed', 'skipped')
            ",
            params![id, session_id, provider],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

pub fn fail_stale_syncing(
    app_data_dir: &Path,
    session_id: Option<&str>,
    older_than_seconds: i64,
) -> Result<usize, String> {
    let cutoff = (Local::now() - chrono::Duration::seconds(older_than_seconds)).to_rfc3339();
    let conn = open(app_data_dir)?;
    let sql = match session_id {
        Some(_) => {
            "
            UPDATE task_sync_queue
            SET status = 'failed',
                error = 'Sync was interrupted before Todoist returned a result',
                error_kind = 'sync_interrupted',
                retryable = 1,
                claimed_at = NULL
            WHERE status = 'syncing'
              AND source_session_id = ?1
              AND (claimed_at IS NULL OR claimed_at <= ?2)
            "
        }
        None => {
            "
            UPDATE task_sync_queue
            SET status = 'failed',
                error = 'Sync was interrupted before Todoist returned a result',
                error_kind = 'sync_interrupted',
                retryable = 1,
                claimed_at = NULL
            WHERE status = 'syncing'
              AND (claimed_at IS NULL OR claimed_at <= ?1)
            "
        }
    };
    let updated = match session_id {
        Some(session_id) => conn.execute(sql, params![session_id, cutoff]),
        None => conn.execute(sql, params![cutoff]),
    }
    .map_err(|e| e.to_string())?;
    Ok(updated)
}

pub fn requeue_failed(app_data_dir: &Path, session_id: &str, provider: &str) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "
        UPDATE task_sync_queue
        SET status = 'queued',
            error = NULL,
            error_kind = NULL,
            retryable = NULL,
            queued_at = ?1,
            claimed_at = NULL
        WHERE source_session_id = ?2 AND provider = ?3 AND status = 'failed'
        ",
        params![Local::now().to_rfc3339(), session_id, provider],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ActionItem, TaskSyncStatus};
    use tempfile::tempdir;

    fn item(id: &str) -> ActionItem {
        ActionItem {
            id: id.to_string(),
            provider: "todoist".to_string(),
            title: "Task".to_string(),
            description: Some("Desc".to_string()),
            due: Some("2026-06-05".to_string()),
            priority: Some(3),
            assignee: None,
            context: None,
            source_session_id: "session-1".to_string(),
            source_file_path: "/tmp/session/summary.md".to_string(),
            status: TaskSyncStatus::New,
            external_task_id: None,
            error: None,
            error_kind: None,
            retryable: None,
        }
    }

    #[test]
    fn upsert_new_tasks_does_not_duplicate_ids() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("first");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("second");

        let rows = list_by_session(tmp.path(), "session-1", "todoist").expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, TaskSyncStatus::New);
    }

    #[test]
    fn mark_synced_is_not_reset_by_upsert() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()]).expect("enqueue");
        mark_synced(tmp.path(), "id-1", "todoist-task-1").expect("synced");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("upsert");

        let rows = list_by_session(tmp.path(), "session-1", "todoist").expect("list");
        assert_eq!(rows[0].status, TaskSyncStatus::Synced);
        assert_eq!(rows[0].external_task_id.as_deref(), Some("todoist-task-1"));
    }

    #[test]
    fn failed_rows_can_be_requeued() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        mark_failed(tmp.path(), "id-1", "network", true).expect("failed");
        requeue_failed(tmp.path(), "session-1", "todoist").expect("requeue");

        let batch = next_pending_batch(tmp.path(), Some("session-1"), 10).expect("batch");
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].status, TaskSyncStatus::Queued);
        assert_eq!(batch[0].error, None);
        assert_eq!(batch[0].error_kind, None);
        assert_eq!(batch[0].retryable, None);
    }

    #[test]
    fn failed_rows_persist_structured_error_metadata() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        mark_failed_with_kind(tmp.path(), "id-1", "rate limited", "rate_limit", true)
            .expect("failed");

        let rows = list_by_session(tmp.path(), "session-1", "todoist").expect("list");
        assert_eq!(rows[0].status, TaskSyncStatus::Failed);
        assert_eq!(rows[0].error.as_deref(), Some("rate limited"));
        assert_eq!(rows[0].error_kind.as_deref(), Some("rate_limit"));
        assert_eq!(rows[0].retryable, Some(true));
    }

    #[test]
    fn claim_pending_batch_does_not_return_the_same_row_twice() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1"), item("id-2")]).expect("insert");
        enqueue_tasks(
            tmp.path(),
            "session-1",
            "todoist",
            &["id-1".to_string(), "id-2".to_string()],
        )
        .expect("enqueue");

        let first = claim_pending_batch(tmp.path(), Some("session-1"), 1).expect("first claim");
        let second = claim_pending_batch(tmp.path(), Some("session-1"), 1).expect("second claim");
        let third = claim_pending_batch(tmp.path(), Some("session-1"), 1).expect("third claim");

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert!(third.is_empty());
        assert_ne!(first[0].id, second[0].id);
        assert_eq!(first[0].status, TaskSyncStatus::Syncing);
        assert_eq!(second[0].status, TaskSyncStatus::Syncing);
    }

    #[test]
    fn stale_syncing_rows_become_retryable_failures() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()])
            .expect("enqueue");
        claim_pending_batch(tmp.path(), Some("session-1"), 1).expect("claim");

        let old_claim = (Local::now() - chrono::Duration::seconds(60 * 60)).to_rfc3339();
        let conn = open(tmp.path()).expect("open db");
        conn.execute(
            "UPDATE task_sync_queue SET claimed_at = ?1 WHERE id = 'id-1'",
            params![old_claim],
        )
        .expect("age claim");

        let updated =
            fail_stale_syncing(tmp.path(), Some("session-1"), 15 * 60).expect("fail stale");

        assert_eq!(updated, 1);
        let rows = list_by_session(tmp.path(), "session-1", "todoist").expect("rows");
        assert_eq!(rows[0].status, TaskSyncStatus::Failed);
        assert_eq!(rows[0].error_kind.as_deref(), Some("sync_interrupted"));
        assert_eq!(rows[0].retryable, Some(true));
    }

    #[test]
    fn fresh_syncing_rows_are_not_failed() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()])
            .expect("enqueue");
        claim_pending_batch(tmp.path(), Some("session-1"), 1).expect("claim");

        let updated =
            fail_stale_syncing(tmp.path(), Some("session-1"), 15 * 60).expect("fail stale");

        assert_eq!(updated, 0);
        let rows = list_by_session(tmp.path(), "session-1", "todoist").expect("rows");
        assert_eq!(rows[0].status, TaskSyncStatus::Syncing);
    }
}
