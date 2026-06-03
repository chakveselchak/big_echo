use crate::task_sync::model::{ActionItem, ExtractedActionItem, TaskProvider, TaskSyncStatus};
use sha2::{Digest, Sha256};
use std::path::Path;

fn collapse_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn normalized_priority(value: Option<i64>) -> i64 {
    value.unwrap_or(1).clamp(1, 4)
}

fn deterministic_id(
    provider: TaskProvider,
    session_id: &str,
    title: &str,
    due: Option<&str>,
) -> String {
    let input = format!(
        "{}\n{}\n{}\n{}",
        provider.as_str(),
        session_id,
        title,
        due.unwrap_or("")
    );
    let digest = Sha256::digest(input.as_bytes());
    format!("{digest:x}")
}

pub fn normalize_one(
    provider: TaskProvider,
    source_session_id: &str,
    source_file_path: &Path,
    raw: ExtractedActionItem,
) -> Option<ActionItem> {
    let title = collapse_ws(&raw.title);
    if title.is_empty() {
        return None;
    }

    let raw_due = raw.due.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let due = raw_due.filter(|v| is_iso_date(v)).map(str::to_string);
    let mut description_parts = Vec::new();
    if let Some(description) = raw
        .description
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        description_parts.push(description.to_string());
    }
    if let Some(context) = raw
        .context
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        description_parts.push(format!("Контекст:\n{context}"));
    }
    if let Some(assignee) = raw
        .assignee
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        description_parts.push(format!("Исполнитель: {assignee}"));
    }
    if raw_due.is_some() && due.is_none() {
        description_parts.push(format!("Due: {}", raw_due.unwrap()));
    }
    description_parts.push(format!(
        "Источник: BigEcho\nВстреча: {source_session_id}\nФайл: {}",
        source_file_path.display()
    ));

    Some(ActionItem {
        id: deterministic_id(provider, source_session_id, &title, due.as_deref()),
        provider: provider.as_str().to_string(),
        title,
        description: Some(description_parts.join("\n\n")),
        due,
        priority: Some(normalized_priority(raw.priority)),
        assignee: raw
            .assignee
            .map(|value| collapse_ws(&value))
            .filter(|value| !value.is_empty()),
        context: raw
            .context
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        source_session_id: source_session_id.to_string(),
        source_file_path: source_file_path.to_string_lossy().to_string(),
        status: TaskSyncStatus::New,
        external_task_id: None,
        error: None,
    })
}

pub fn normalize_many(
    provider: TaskProvider,
    source_session_id: &str,
    source_file_path: &Path,
    items: Vec<ExtractedActionItem>,
) -> Vec<ActionItem> {
    items
        .into_iter()
        .filter_map(|item| normalize_one(provider, source_session_id, source_file_path, item))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ExtractedActionItem, TaskProvider};
    use std::path::Path;

    fn raw(title: &str) -> ExtractedActionItem {
        ExtractedActionItem {
            title: title.to_string(),
            description: None,
            due: None,
            priority: None,
            assignee: None,
            source: None,
            context: None,
        }
    }

    #[test]
    fn normalizer_collapses_title_whitespace_and_defaults_priority() {
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            raw("  Согласовать   SAP_ID \n с безопасниками  "),
        )
        .expect("normalized");

        assert_eq!(item.title, "Согласовать SAP_ID с безопасниками");
        assert_eq!(item.priority, Some(1));
    }

    #[test]
    fn normalizer_accepts_only_iso_due_dates() {
        let mut accepted = raw("Task");
        accepted.due = Some("2026-06-05".to_string());
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            accepted,
        )
        .expect("accepted");
        assert_eq!(item.due.as_deref(), Some("2026-06-05"));

        let mut rejected = raw("Task");
        rejected.due = Some("завтра".to_string());
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            rejected,
        )
        .expect("rejected due preserved");
        assert_eq!(item.due, None);
        assert!(item.description.unwrap().contains("Due: завтра"));
    }

    #[test]
    fn normalizer_uses_stable_deterministic_id() {
        let mut raw = raw("Task");
        raw.due = Some("2026-06-05".to_string());

        let first = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            raw.clone(),
        )
        .expect("first");
        let second = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            raw,
        )
        .expect("second");

        assert_eq!(first.id, second.id);
    }

    #[test]
    fn normalizer_drops_empty_titles() {
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            raw("   "),
        );

        assert!(item.is_none());
    }
}
