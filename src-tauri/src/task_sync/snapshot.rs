use crate::task_sync::model::ActionItem;
use chrono::Local;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskSyncSnapshot<'a> {
    source_session_id: &'a str,
    provider: &'a str,
    updated_at: String,
    items: &'a [ActionItem],
}

pub fn write_snapshot(
    path: &Path,
    source_session_id: &str,
    provider: &str,
    items: &[ActionItem],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let snapshot = TaskSyncSnapshot {
        source_session_id,
        provider,
        updated_at: Local::now().to_rfc3339(),
        items,
    };
    let raw = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ActionItem, TaskSyncStatus};
    use tempfile::tempdir;

    #[test]
    fn writes_tasks_sync_snapshot() {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("tasks_sync.json");
        let item = ActionItem {
            id: "id-1".to_string(),
            provider: "todoist".to_string(),
            title: "Task".to_string(),
            description: None,
            due: Some("2026-06-05".to_string()),
            priority: Some(3),
            assignee: Some("Андрей".to_string()),
            context: None,
            labels: vec!["project/acme".to_string()],
            source_session_id: "session-1".to_string(),
            source_file_path: "/tmp/session/summary.md".to_string(),
            status: TaskSyncStatus::Queued,
            external_task_id: None,
            error: None,
            error_kind: None,
            retryable: None,
        };

        write_snapshot(&path, "session-1", "todoist", &[item]).expect("write snapshot");

        let raw = std::fs::read_to_string(path).expect("snapshot");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(json["sourceSessionId"], "session-1");
        assert_eq!(json["provider"], "todoist");
        assert_eq!(json["items"][0]["title"], "Task");
    }
}
