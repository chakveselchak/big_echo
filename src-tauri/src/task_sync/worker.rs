use crate::task_sync::model::{ActionItem, TaskSyncError};
use crate::task_sync::{queue, todoist};
use serde::Serialize;
use std::future::Future;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSyncResult {
    pub synced: usize,
    pub failed: usize,
    pub session_ids: Vec<String>,
}

pub async fn sync_queued(
    app_data_dir: &Path,
    session_id: Option<&str>,
    token: &str,
) -> Result<TaskSyncResult, String> {
    sync_queued_with(app_data_dir, session_id, |item| async move {
        todoist::create_task(token, &item).await
    })
    .await
}

pub async fn sync_queued_with<F, Fut>(
    app_data_dir: &Path,
    session_id: Option<&str>,
    create: F,
) -> Result<TaskSyncResult, String>
where
    F: Fn(ActionItem) -> Fut,
    Fut: Future<Output = Result<String, TaskSyncError>>,
{
    let batch = queue::claim_pending_batch(app_data_dir, session_id, 50)?;
    let mut result = TaskSyncResult {
        synced: 0,
        failed: 0,
        session_ids: Vec::new(),
    };

    for item in batch {
        if !result.session_ids.contains(&item.source_session_id) {
            result.session_ids.push(item.source_session_id.clone());
        }
        match create(item.clone()).await {
            Ok(external_id) => {
                queue::mark_synced(app_data_dir, &item.id, &external_id)?;
                result.synced += 1;
            }
            Err(err) => {
                queue::mark_failed_with_kind(
                    app_data_dir,
                    &item.id,
                    &err.message,
                    err.kind.as_str(),
                    err.retryable,
                )?;
                result.failed += 1;
            }
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ActionItem, TaskSyncError, TaskSyncErrorKind, TaskSyncStatus};
    use crate::task_sync::queue;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tempfile::tempdir;

    fn item(id: &str) -> ActionItem {
        item_with_session(id, "session-1")
    }

    fn item_with_session(id: &str, session_id: &str) -> ActionItem {
        ActionItem {
            id: id.to_string(),
            provider: "todoist".to_string(),
            title: "Task".to_string(),
            description: None,
            due: None,
            priority: Some(1),
            assignee: None,
            context: None,
            source_session_id: session_id.to_string(),
            source_file_path: "/tmp/session/summary.md".to_string(),
            status: TaskSyncStatus::New,
            external_task_id: None,
            error: None,
            error_kind: None,
            retryable: None,
        }
    }

    #[tokio::test]
    async fn worker_marks_successful_tasks_synced() {
        let tmp = tempdir().expect("tempdir");
        queue::upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        queue::enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()])
            .expect("enqueue");

        let result = sync_queued_with(tmp.path(), Some("session-1"), |_item| async {
            Ok("todoist-1".to_string())
        })
        .await
        .expect("sync");

        assert_eq!(result.synced, 1);
        assert_eq!(result.session_ids, vec!["session-1"]);
        let rows = queue::list_by_session(tmp.path(), "session-1", "todoist").expect("rows");
        assert_eq!(rows[0].status, TaskSyncStatus::Synced);
        assert_eq!(rows[0].external_task_id.as_deref(), Some("todoist-1"));
    }

    #[tokio::test]
    async fn worker_marks_failed_tasks_failed() {
        let tmp = tempdir().expect("tempdir");
        queue::upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        queue::enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()])
            .expect("enqueue");

        let result = sync_queued_with(tmp.path(), Some("session-1"), |_item| async {
            Err(TaskSyncError::new(
                TaskSyncErrorKind::RateLimit,
                "rate limited",
                true,
            ))
        })
        .await
        .expect("sync");

        assert_eq!(result.failed, 1);
        assert_eq!(result.session_ids, vec!["session-1"]);
        let rows = queue::list_by_session(tmp.path(), "session-1", "todoist").expect("rows");
        assert_eq!(rows[0].status, TaskSyncStatus::Failed);
        assert_eq!(rows[0].error.as_deref(), Some("rate limited"));
        assert_eq!(rows[0].error_kind.as_deref(), Some("rate_limit"));
        assert_eq!(rows[0].retryable, Some(true));
    }

    #[tokio::test]
    async fn worker_reports_unique_session_ids_for_processed_batch() {
        let tmp = tempdir().expect("tempdir");
        queue::upsert_new_tasks(
            tmp.path(),
            &[
                item_with_session("id-1", "session-1"),
                item_with_session("id-2", "session-1"),
                item_with_session("id-3", "session-2"),
            ],
        )
        .expect("insert");
        queue::enqueue_tasks(
            tmp.path(),
            "session-1",
            "todoist",
            &["id-1".to_string(), "id-2".to_string()],
        )
        .expect("enqueue session 1");
        queue::enqueue_tasks(tmp.path(), "session-2", "todoist", &["id-3".to_string()])
            .expect("enqueue session 2");

        let result = sync_queued_with(tmp.path(), None, |item| async move {
            Ok(format!("todoist-{}", item.id))
        })
        .await
        .expect("sync");

        assert_eq!(result.synced, 3);
        assert_eq!(result.session_ids, vec!["session-1", "session-2"]);
    }

    #[tokio::test]
    async fn worker_skips_rows_already_claimed_by_another_sync() {
        let tmp = tempdir().expect("tempdir");
        queue::upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        queue::enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()])
            .expect("enqueue");
        queue::claim_pending_batch(tmp.path(), Some("session-1"), 50).expect("claim");

        let calls = Arc::new(AtomicUsize::new(0));
        let result = sync_queued_with(tmp.path(), Some("session-1"), {
            let calls = Arc::clone(&calls);
            move |_item| {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok("todoist-1".to_string())
                }
            }
        })
        .await
        .expect("sync");

        assert_eq!(result.synced, 0);
        assert_eq!(result.failed, 0);
        assert!(result.session_ids.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let rows = queue::list_by_session(tmp.path(), "session-1", "todoist").expect("rows");
        assert_eq!(rows[0].status, TaskSyncStatus::Syncing);
    }
}
