pub mod extractor;
pub mod model;
pub mod normalizer;
pub mod queue;
pub mod snapshot;
pub mod todoist;
pub mod worker;

use crate::app_state::AppDirs;
use crate::storage::{session_store::load_meta, sqlite_repo::get_session_dir};
use crate::task_sync::model::{ActionItem, TaskProvider, TodoistTaskPreview};
use crate::task_sync::worker::TaskSyncResult;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const TODOIST_PROVIDER: TaskProvider = TaskProvider::Todoist;

fn session_dir_for(app_data_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    get_session_dir(app_data_dir, session_id)?
        .ok_or_else(|| format!("session_not_found: {session_id}"))
}

fn merge_queue_fields(items: &mut [ActionItem], existing: &[ActionItem]) {
    let by_id = existing
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<HashMap<_, _>>();

    for item in items {
        if let Some(existing) = by_id.get(item.id.as_str()) {
            item.status = existing.status.clone();
            item.external_task_id = existing.external_task_id.clone();
            item.error = existing.error.clone();
            item.error_kind = existing.error_kind.clone();
            item.retryable = existing.retryable;
        }
    }
}

fn refresh_snapshot_for_session(
    app_data_dir: &Path,
    session_id: &str,
    items: &[ActionItem],
) -> Result<(), String> {
    let session_dir = session_dir_for(app_data_dir, session_id)?;
    let meta = load_meta(&session_dir.join("meta.json"))?;
    let snapshot_path = session_dir.join(&meta.artifacts.tasks_sync_file);
    snapshot::write_snapshot(&snapshot_path, session_id, TODOIST_PROVIDER.as_str(), items)
}

fn refresh_snapshot_for_session_if_available(
    app_data_dir: &Path,
    session_id: &str,
    items: &[ActionItem],
) -> Result<(), String> {
    let Some(session_dir) = get_session_dir(app_data_dir, session_id)? else {
        // Queue rows can outlive their source session metadata. In that case there
        // is no session snapshot to refresh, so status listing still succeeds.
        return Ok(());
    };
    let Ok(meta) = load_meta(&session_dir.join("meta.json")) else {
        return Ok(());
    };
    let snapshot_path = session_dir.join(&meta.artifacts.tasks_sync_file);
    snapshot::write_snapshot(
        &snapshot_path,
        session_id,
        TODOIST_PROVIDER.as_str(),
        items,
    )
}

fn refresh_snapshot_for_session_if_session_exists(
    app_data_dir: &Path,
    session_id: &str,
    items: &[ActionItem],
) -> Result<(), String> {
    match get_session_dir(app_data_dir, session_id)? {
        Some(_) => refresh_snapshot_for_session(app_data_dir, session_id, items),
        None => Ok(()),
    }
}

fn refresh_snapshots_for_sessions(
    app_data_dir: &Path,
    session_ids: &[String],
) -> Result<(), String> {
    let mut refreshed = Vec::new();
    for session_id in session_ids {
        if refreshed.contains(session_id) {
            continue;
        }
        let items = queue::list_by_session(app_data_dir, session_id, TODOIST_PROVIDER.as_str())?;
        refresh_snapshot_for_session_if_available(app_data_dir, session_id, &items)?;
        refreshed.push(session_id.clone());
    }
    Ok(())
}

pub fn preview_todoist_tasks_for_session(
    app_data_dir: &Path,
    session_id: &str,
) -> Result<TodoistTaskPreview, String> {
    let session_dir = session_dir_for(app_data_dir, session_id)?;
    let meta = load_meta(&session_dir.join("meta.json"))?;
    let summary_path = session_dir.join(&meta.artifacts.summary_file);
    let extraction = extractor::extract_action_items(&summary_path)?;
    let mut items = normalizer::normalize_many(
        TODOIST_PROVIDER,
        session_id,
        &summary_path,
        extraction.items,
    );

    let current_ids = items.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
    queue::prune_unsynced_absent(
        app_data_dir,
        session_id,
        TODOIST_PROVIDER.as_str(),
        &current_ids,
    )?;
    queue::upsert_new_tasks(app_data_dir, &items)?;
    let existing = queue::list_by_session(app_data_dir, session_id, TODOIST_PROVIDER.as_str())?;
    merge_queue_fields(&mut items, &existing);
    refresh_snapshot_for_session(app_data_dir, session_id, &items)?;

    Ok(TodoistTaskPreview {
        session_id: session_id.to_string(),
        summary_path: summary_path.to_string_lossy().to_string(),
        warnings: extraction.warnings,
        items,
    })
}

pub fn enqueue_todoist_tasks_for_session(
    app_data_dir: &Path,
    session_id: &str,
    task_ids: Vec<String>,
) -> Result<Vec<ActionItem>, String> {
    queue::enqueue_tasks(
        app_data_dir,
        session_id,
        TODOIST_PROVIDER.as_str(),
        &task_ids,
    )?;
    let items = queue::list_by_session(app_data_dir, session_id, TODOIST_PROVIDER.as_str())?;
    refresh_snapshot_for_session_if_session_exists(app_data_dir, session_id, &items)?;
    Ok(items)
}

pub fn status_for_session(
    app_data_dir: &Path,
    session_id: &str,
) -> Result<Vec<ActionItem>, String> {
    queue::list_by_session(app_data_dir, session_id, TODOIST_PROVIDER.as_str())
}

pub async fn sync_todoist_tasks_for_session(
    dirs: &AppDirs,
    session_id: Option<&str>,
    token: &str,
) -> Result<TaskSyncResult, String> {
    let result = worker::sync_queued(&dirs.app_data_dir, session_id, token).await?;
    refresh_snapshots_for_sessions(&dirs.app_data_dir, &result.session_ids)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::{SessionMeta, SessionStatus};
    use crate::storage::{session_store::save_meta, sqlite_repo::upsert_session};
    use crate::task_sync::model::TaskSyncStatus;
    use tempfile::tempdir;

    #[test]
    fn preview_todoist_tasks_for_session_extracts_items_and_writes_snapshot() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("sessions").join("session-1");
        std::fs::create_dir_all(&app_data_dir).expect("app data dir");
        std::fs::create_dir_all(&session_dir).expect("session dir");

        let mut meta = SessionMeta::new(
            "session-1".to_string(),
            "zoom".to_string(),
            vec![],
            "Task sync preview".to_string(),
            String::new(),
        );
        meta.status = SessionStatus::Done;
        meta.artifacts.summary_file = "summary.md".to_string();
        meta.artifacts.tasks_sync_file = "tasks_sync.json".to_string();

        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        std::fs::write(
            session_dir.join("summary.md"),
            "## Action Items\n- [ ] Send follow-up\n",
        )
        .expect("write summary");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert session");

        let preview =
            preview_todoist_tasks_for_session(&app_data_dir, "session-1").expect("preview");

        assert_eq!(preview.session_id, "session-1");
        assert_eq!(
            preview.summary_path,
            session_dir.join("summary.md").to_string_lossy()
        );
        assert!(preview.warnings.is_empty());
        assert_eq!(preview.items.len(), 1);
        assert_eq!(preview.items[0].title, "Send follow-up");
        assert!(session_dir.join("tasks_sync.json").exists());
    }

    #[test]
    fn enqueue_todoist_tasks_for_session_surfaces_snapshot_write_failure() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("sessions").join("session-1");
        std::fs::create_dir_all(&app_data_dir).expect("app data dir");
        std::fs::create_dir_all(&session_dir).expect("session dir");

        let mut meta = SessionMeta::new(
            "session-1".to_string(),
            "zoom".to_string(),
            vec![],
            "Task sync enqueue".to_string(),
            String::new(),
        );
        meta.status = SessionStatus::Done;
        meta.artifacts.summary_file = "summary.md".to_string();
        meta.artifacts.tasks_sync_file = "snapshot-parent/tasks_sync.json".to_string();

        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        std::fs::write(session_dir.join("snapshot-parent"), "not a directory")
            .expect("write blocking file");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert session");
        queue::upsert_new_tasks(
            &app_data_dir,
            &[ActionItem {
                id: "task-1".to_string(),
                provider: TODOIST_PROVIDER.as_str().to_string(),
                title: "Send follow-up".to_string(),
                description: None,
                due: None,
                priority: None,
                assignee: None,
                context: None,
                source_session_id: "session-1".to_string(),
                source_file_path: session_dir.join("summary.md").to_string_lossy().to_string(),
                status: TaskSyncStatus::New,
                external_task_id: None,
                error: None,
                error_kind: None,
                retryable: None,
            }],
        )
        .expect("upsert task");

        let err = enqueue_todoist_tasks_for_session(
            &app_data_dir,
            "session-1",
            vec!["task-1".to_string()],
        )
        .expect_err("snapshot write failure should be returned");

        assert!(!err.is_empty());
        let rows = queue::list_by_session(&app_data_dir, "session-1", TODOIST_PROVIDER.as_str())
            .expect("list rows");
        assert_eq!(rows[0].status, TaskSyncStatus::Queued);
    }

    #[test]
    fn refresh_snapshots_for_sessions_writes_current_queue_state() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("sessions").join("session-1");
        std::fs::create_dir_all(&app_data_dir).expect("app data dir");
        std::fs::create_dir_all(&session_dir).expect("session dir");

        let mut meta = SessionMeta::new(
            "session-1".to_string(),
            "zoom".to_string(),
            vec![],
            "Task sync refresh".to_string(),
            String::new(),
        );
        meta.status = SessionStatus::Done;
        meta.artifacts.summary_file = "summary.md".to_string();
        meta.artifacts.tasks_sync_file = "tasks_sync.json".to_string();

        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        std::fs::write(
            session_dir.join("summary.md"),
            "## Action Items\n- [ ] Send follow-up\n",
        )
        .expect("write summary");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert session");
        let preview =
            preview_todoist_tasks_for_session(&app_data_dir, "session-1").expect("preview");
        enqueue_todoist_tasks_for_session(
            &app_data_dir,
            "session-1",
            vec![preview.items[0].id.clone()],
        )
        .expect("enqueue");
        queue::mark_synced(&app_data_dir, &preview.items[0].id, "todoist-task-1")
            .expect("mark synced");

        refresh_snapshots_for_sessions(&app_data_dir, &["session-1".to_string()])
            .expect("refresh snapshots");

        let raw = std::fs::read_to_string(session_dir.join("tasks_sync.json")).expect("snapshot");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(json["items"][0]["status"], "synced");
        assert_eq!(json["items"][0]["externalTaskId"], "todoist-task-1");
    }

    #[test]
    fn refresh_snapshots_for_sessions_tolerates_missing_session_metadata() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        std::fs::create_dir_all(&app_data_dir).expect("app data dir");

        queue::upsert_new_tasks(
            &app_data_dir,
            &[ActionItem {
                id: "task-1".to_string(),
                provider: TODOIST_PROVIDER.as_str().to_string(),
                title: "Already synced".to_string(),
                description: None,
                due: None,
                priority: None,
                assignee: None,
                context: None,
                source_session_id: "missing-session".to_string(),
                source_file_path: "/tmp/missing/summary.md".to_string(),
                status: TaskSyncStatus::New,
                external_task_id: None,
                error: None,
                error_kind: None,
                retryable: None,
            }],
        )
        .expect("upsert task");
        queue::mark_synced(&app_data_dir, "task-1", "todoist-task-1").expect("mark synced");

        refresh_snapshots_for_sessions(&app_data_dir, &["missing-session".to_string()])
            .expect("missing session metadata should not fail refresh");
    }

    #[test]
    fn refresh_snapshots_for_sessions_tolerates_missing_meta_file() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("sessions").join("session-1");
        std::fs::create_dir_all(&app_data_dir).expect("app data dir");
        std::fs::create_dir_all(&session_dir).expect("session dir");

        let mut meta = SessionMeta::new(
            "session-1".to_string(),
            "zoom".to_string(),
            vec![],
            "Task sync missing meta".to_string(),
            String::new(),
        );
        meta.status = SessionStatus::Done;
        meta.artifacts.summary_file = "summary.md".to_string();
        meta.artifacts.tasks_sync_file = "tasks_sync.json".to_string();

        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert session");
        std::fs::remove_file(&meta_path).expect("remove meta");

        queue::upsert_new_tasks(
            &app_data_dir,
            &[ActionItem {
                id: "task-1".to_string(),
                provider: TODOIST_PROVIDER.as_str().to_string(),
                title: "Already synced".to_string(),
                description: None,
                due: None,
                priority: None,
                assignee: None,
                context: None,
                source_session_id: "session-1".to_string(),
                source_file_path: session_dir.join("summary.md").to_string_lossy().to_string(),
                status: TaskSyncStatus::New,
                external_task_id: None,
                error: None,
                error_kind: None,
                retryable: None,
            }],
        )
        .expect("upsert task");
        queue::mark_synced(&app_data_dir, "task-1", "todoist-task-1").expect("mark synced");

        refresh_snapshots_for_sessions(&app_data_dir, &["session-1".to_string()])
            .expect("missing meta file should not fail refresh");
    }

    #[test]
    fn preview_prunes_stale_unsynced_rows_but_keeps_synced_history() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("sessions").join("session-1");
        std::fs::create_dir_all(&app_data_dir).expect("app data dir");
        std::fs::create_dir_all(&session_dir).expect("session dir");

        let mut meta = SessionMeta::new(
            "session-1".to_string(),
            "zoom".to_string(),
            vec![],
            "Task sync preview prune".to_string(),
            String::new(),
        );
        meta.status = SessionStatus::Done;
        meta.artifacts.summary_file = "summary.md".to_string();
        meta.artifacts.tasks_sync_file = "tasks_sync.json".to_string();

        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert session");

        std::fs::write(
            session_dir.join("summary.md"),
            "## Action Items\n- [ ] Keep task\n- [ ] Remove queued\n- [ ] Keep synced\n",
        )
        .expect("write summary");
        let first_preview =
            preview_todoist_tasks_for_session(&app_data_dir, "session-1").expect("first preview");

        let remove_queued = first_preview
            .items
            .iter()
            .find(|item| item.title == "Remove queued")
            .expect("remove queued")
            .id
            .clone();
        let keep_synced = first_preview
            .items
            .iter()
            .find(|item| item.title == "Keep synced")
            .expect("keep synced")
            .id
            .clone();

        enqueue_todoist_tasks_for_session(&app_data_dir, "session-1", vec![remove_queued.clone()])
            .expect("enqueue stale row");
        queue::mark_synced(&app_data_dir, &keep_synced, "todoist-keep-synced")
            .expect("mark synced");

        std::fs::write(
            session_dir.join("summary.md"),
            "## Action Items\n- [ ] Keep task\n",
        )
        .expect("rewrite summary");

        let second_preview =
            preview_todoist_tasks_for_session(&app_data_dir, "session-1").expect("second preview");
        let rows = status_for_session(&app_data_dir, "session-1").expect("status");

        assert_eq!(second_preview.items.len(), 1);
        assert_eq!(second_preview.items[0].title, "Keep task");
        assert!(rows.iter().any(|item| item.title == "Keep task"));
        assert!(rows
            .iter()
            .any(|item| { item.title == "Keep synced" && item.status == TaskSyncStatus::Synced }));
        assert!(!rows.iter().any(|item| item.id == remove_queued));
    }
}
