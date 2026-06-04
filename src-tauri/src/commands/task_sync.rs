use crate::app_state::AppDirs;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use crate::task_sync::model::{ActionItem, TodoistTaskPreview};
use crate::task_sync::worker::TaskSyncResult;
use tauri::State;

pub const TODOIST_TOKEN_KEY: &str = "TODOIST_API_TOKEN";

fn todoist_token_for_key(app_data_dir: &std::path::Path, key: &str) -> Result<String, String> {
    get_secret(app_data_dir, key)
        .map(|token| token.trim().to_string())
        .map_err(|err| format!("missing_token: {err}"))
        .and_then(|token| {
            if token.is_empty() {
                Err("missing_token: Todoist token is empty".to_string())
            } else {
                Ok(token)
            }
        })
}

fn todoist_token(app_data_dir: &std::path::Path) -> Result<String, String> {
    todoist_token_for_key(app_data_dir, TODOIST_TOKEN_KEY)
}

#[tauri::command]
pub async fn todoist_sync_set_token(
    dirs: State<'_, AppDirs>,
    token: String,
) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token must not be empty".to_string());
    }
    set_secret(&dirs.app_data_dir, TODOIST_TOKEN_KEY, trimmed)
}

#[tauri::command]
pub async fn todoist_sync_clear_token(dirs: State<'_, AppDirs>) -> Result<(), String> {
    clear_secret(&dirs.app_data_dir, TODOIST_TOKEN_KEY)
}

#[tauri::command]
pub async fn todoist_sync_has_token(dirs: State<'_, AppDirs>) -> Result<bool, String> {
    match get_secret(&dirs.app_data_dir, TODOIST_TOKEN_KEY) {
        Ok(token) => Ok(!token.trim().is_empty()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn preview_todoist_tasks(
    dirs: State<'_, AppDirs>,
    session_id: String,
) -> Result<TodoistTaskPreview, String> {
    crate::task_sync::preview_todoist_tasks_for_session(&dirs.app_data_dir, &session_id)
}

#[tauri::command]
pub async fn enqueue_todoist_tasks(
    dirs: State<'_, AppDirs>,
    session_id: String,
    task_ids: Vec<String>,
) -> Result<Vec<ActionItem>, String> {
    let _token = todoist_token(&dirs.app_data_dir)?;
    crate::task_sync::enqueue_todoist_tasks_for_session(
        &dirs.app_data_dir,
        &session_id,
        task_ids,
    )
}

#[tauri::command]
pub async fn sync_todoist_tasks(
    dirs: State<'_, AppDirs>,
    session_id: Option<String>,
) -> Result<TaskSyncResult, String> {
    let token = todoist_token(&dirs.app_data_dir)?;
    crate::task_sync::sync_todoist_tasks_for_session(&dirs, session_id.as_deref(), &token).await
}

#[tauri::command]
pub async fn get_todoist_sync_status(
    dirs: State<'_, AppDirs>,
    session_id: String,
) -> Result<Vec<ActionItem>, String> {
    crate::task_sync::status_for_session(&dirs.app_data_dir, &session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::secret_store::get_secret;
    use tempfile::tempdir;

    #[test]
    fn todoist_token_reports_missing_token() {
        let tmp = tempdir().expect("tempdir");
        let key = format!("TODOIST_API_TOKEN_TEST_{}", uuid::Uuid::new_v4());

        let err = todoist_token_for_key(tmp.path(), &key).expect_err("missing token");

        assert!(err.starts_with("missing_token:"));
    }

    #[test]
    fn todoist_token_trims_stored_token() {
        let tmp = tempdir().expect("tempdir");
        let key = format!("TODOIST_API_TOKEN_TEST_{}", uuid::Uuid::new_v4());
        set_secret(tmp.path(), &key, "  abc  ").expect("set");

        assert_eq!(todoist_token_for_key(tmp.path(), &key).expect("token"), "abc");
        assert_eq!(get_secret(tmp.path(), &key).expect("stored"), "  abc  ");
    }
}
