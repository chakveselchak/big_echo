use crate::task_sync::model::{ActionItem, TaskSyncError, TaskSyncErrorKind};
use serde::{Deserialize, Serialize};

const TODOIST_CREATE_TASK_URL: &str = "https://api.todoist.com/api/v1/tasks";

#[derive(Debug, Serialize)]
pub struct TodoistCreateTaskPayload {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TodoistTaskResponse {
    id: String,
}

pub fn build_create_task_payload(item: &ActionItem) -> TodoistCreateTaskPayload {
    TodoistCreateTaskPayload {
        content: item.title.clone(),
        description: item.description.clone(),
        due_date: item.due.clone(),
        priority: item.priority,
    }
}

pub fn map_status_error(status: u16, body: &str) -> TaskSyncError {
    match status {
        401 => TaskSyncError::new(
            TaskSyncErrorKind::InvalidToken,
            "Todoist token is invalid",
            false,
        ),
        429 => TaskSyncError::new(
            TaskSyncErrorKind::RateLimit,
            "Todoist rate limit reached",
            true,
        ),
        500..=599 => TaskSyncError::new(
            TaskSyncErrorKind::Server,
            format!("Todoist server error: {body}"),
            true,
        ),
        400 => TaskSyncError::new(
            TaskSyncErrorKind::BadRequest,
            format!("Todoist rejected task: {body}"),
            false,
        ),
        _ => TaskSyncError::new(
            TaskSyncErrorKind::Network,
            format!("Todoist request failed with status {status}: {body}"),
            true,
        ),
    }
}

pub async fn create_task(token: &str, item: &ActionItem) -> Result<String, TaskSyncError> {
    let client = reqwest::Client::new();
    let response = client
        .post(TODOIST_CREATE_TASK_URL)
        .bearer_auth(token)
        .json(&build_create_task_payload(item))
        .send()
        .await
        .map_err(|e| TaskSyncError::new(TaskSyncErrorKind::Network, e.to_string(), true))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| TaskSyncError::new(TaskSyncErrorKind::Network, e.to_string(), true))?;

    if !status.is_success() {
        return Err(map_status_error(status.as_u16(), &body));
    }

    let parsed: TodoistTaskResponse = serde_json::from_str(&body)
        .map_err(|e| TaskSyncError::new(TaskSyncErrorKind::Network, e.to_string(), true))?;
    Ok(parsed.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ActionItem, TaskSyncErrorKind, TaskSyncStatus};

    fn item() -> ActionItem {
        ActionItem {
            id: "id-1".to_string(),
            provider: "todoist".to_string(),
            title: "Task".to_string(),
            description: Some("Desc".to_string()),
            due: Some("2026-06-05".to_string()),
            priority: Some(3),
            assignee: Some("Андрей".to_string()),
            context: Some("Context".to_string()),
            source_session_id: "session-1".to_string(),
            source_file_path: "/tmp/session/summary.md".to_string(),
            status: TaskSyncStatus::Queued,
            external_task_id: None,
            error: None,
        }
    }

    #[test]
    fn todoist_payload_omits_project_id_for_inbox() {
        let payload = build_create_task_payload(&item());
        let json = serde_json::to_value(payload).expect("payload");

        assert_eq!(json["content"], "Task");
        assert_eq!(json["description"], "Desc");
        assert_eq!(json["due_date"], "2026-06-05");
        assert_eq!(json["priority"], 3);
        assert!(json.get("project_id").is_none());
    }

    #[test]
    fn maps_http_statuses_to_error_kinds() {
        assert_eq!(
            map_status_error(401, "bad").kind,
            TaskSyncErrorKind::InvalidToken
        );
        assert_eq!(
            map_status_error(429, "slow").kind,
            TaskSyncErrorKind::RateLimit
        );
        assert_eq!(
            map_status_error(500, "down").kind,
            TaskSyncErrorKind::Server
        );
        assert_eq!(
            map_status_error(400, "bad data").kind,
            TaskSyncErrorKind::BadRequest
        );
    }
}
