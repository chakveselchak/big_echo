use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskProvider {
    Todoist,
}

impl TaskProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskProvider::Todoist => "todoist",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskSyncStatus {
    New,
    Queued,
    Synced,
    Failed,
    Skipped,
}

impl TaskSyncStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskSyncStatus::New => "new",
            TaskSyncStatus::Queued => "queued",
            TaskSyncStatus::Synced => "synced",
            TaskSyncStatus::Failed => "failed",
            TaskSyncStatus::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedActionItem {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub id: String,
    pub provider: String,
    pub title: String,
    pub description: Option<String>,
    pub due: Option<String>,
    pub priority: Option<i64>,
    pub assignee: Option<String>,
    pub context: Option<String>,
    pub source_session_id: String,
    pub source_file_path: String,
    pub status: TaskSyncStatus,
    pub external_task_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskSyncErrorKind {
    MissingToken,
    InvalidToken,
    RateLimit,
    Server,
    BadRequest,
    Network,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSyncError {
    pub kind: TaskSyncErrorKind,
    pub message: String,
    pub retryable: bool,
}

impl TaskSyncError {
    pub fn new(kind: TaskSyncErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable,
        }
    }
}
