use crate::task_sync::model::{ActionItem, ExtractedActionItem, TaskProvider, TaskSyncStatus};
use chrono::{Datelike, Duration, Local, NaiveDate, Weekday};
use sha2::{Digest, Sha256};
use std::path::Path;

fn collapse_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_iso_date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

fn is_unspecified_due(value: &str) -> bool {
    let normalized = collapse_ws(&value.to_lowercase());
    matches!(
        normalized.as_str(),
        "" | "-" | "—" | "не указан" | "не указано" | "нет" | "n/a"
    )
}

fn format_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn friday_of_week(date: NaiveDate) -> NaiveDate {
    let current = date.weekday().num_days_from_monday() as i64;
    let friday = Weekday::Fri.num_days_from_monday() as i64;
    date + Duration::days(friday - current)
}

fn quarter_end(year: i32, quarter: u32) -> NaiveDate {
    let month = quarter * 3;
    let day = match month {
        3 => 31,
        6 => 30,
        9 => 30,
        12 => 31,
        _ => unreachable!("quarter end month"),
    };
    NaiveDate::from_ymd_opt(year, month, day).expect("valid quarter end")
}

fn quarter_due_date(today: NaiveDate, offset: u32) -> NaiveDate {
    let current_quarter = ((today.month() - 1) / 3) + 1;
    let quarter_index = current_quarter + offset;
    let year = today.year() + ((quarter_index - 1) / 4) as i32;
    let quarter = ((quarter_index - 1) % 4) + 1;
    quarter_end(year, quarter) - Duration::days(10)
}

fn normalize_due_date(value: &str, today: NaiveDate) -> Option<String> {
    let trimmed = value.trim();
    if is_unspecified_due(trimmed) {
        return None;
    }
    if is_iso_date(trimmed) {
        return Some(trimmed.to_string());
    }

    let normalized = collapse_ws(&trimmed.to_lowercase());
    if normalized == "сегодня" {
        return Some(format_date(today));
    }
    if normalized == "завтра" {
        return Some(format_date(today + Duration::days(1)));
    }
    if normalized.contains("следующ") && normalized.contains("недел") {
        return Some(format_date(friday_of_week(today) + Duration::days(7)));
    }
    if normalized.contains("эт") && normalized.contains("недел") {
        return Some(format_date(friday_of_week(today)));
    }
    if normalized.contains("следующ") && normalized.contains("кварт") {
        return Some(format_date(quarter_due_date(today, 1)));
    }
    if (normalized.contains("эт") || normalized.contains("текущ")) && normalized.contains("кварт")
    {
        return Some(format_date(quarter_due_date(today, 0)));
    }

    None
}

fn normalized_priority(value: Option<i64>) -> i64 {
    value.unwrap_or(1).clamp(1, 4)
}

fn normalize_labels(labels: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for label in labels {
        let normalized = collapse_ws(label);
        if !normalized.is_empty() && !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
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
    session_tags: &[String],
    raw: ExtractedActionItem,
) -> Option<ActionItem> {
    let title = collapse_ws(&raw.title);
    if title.is_empty() {
        return None;
    }

    let today = Local::now().date_naive();
    let raw_due = raw.due.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let due = raw_due.and_then(|value| normalize_due_date(value, today));
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
        description_parts.push(context.to_string());
    }
    if let Some(assignee) = raw
        .assignee
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        description_parts.push(format!("**Исполнитель:** {assignee}"));
    }
    if raw_due.is_some() && due.is_none() && !is_unspecified_due(raw_due.unwrap()) {
        description_parts.push(format!("Due: {}", raw_due.unwrap()));
    }
    description_parts.push(format!("*Файл:* `{}`", source_file_path.display()));

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
        labels: normalize_labels(session_tags),
        source_session_id: source_session_id.to_string(),
        source_file_path: source_file_path.to_string_lossy().to_string(),
        status: TaskSyncStatus::New,
        external_task_id: None,
        error: None,
        error_kind: None,
        retryable: None,
    })
}

pub fn normalize_many(
    provider: TaskProvider,
    source_session_id: &str,
    source_file_path: &Path,
    session_tags: &[String],
    items: Vec<ExtractedActionItem>,
) -> Vec<ActionItem> {
    items
        .into_iter()
        .filter_map(|item| {
            normalize_one(
                provider,
                source_session_id,
                source_file_path,
                session_tags,
                item,
            )
        })
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
            &[],
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
            &[],
            accepted,
        )
        .expect("accepted");
        assert_eq!(item.due.as_deref(), Some("2026-06-05"));

        let mut rejected = raw("Task");
        rejected.due = Some("примерно 1 месяц".to_string());
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            &[],
            rejected,
        )
        .expect("rejected due preserved");
        assert_eq!(item.due, None);
        assert!(item.description.unwrap().contains("Due: примерно 1 месяц"));
    }

    #[test]
    fn normalizer_resolves_russian_relative_due_dates() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 6, 4).expect("today");

        assert_eq!(
            normalize_due_date("сегодня", today).as_deref(),
            Some("2026-06-04")
        );
        assert_eq!(
            normalize_due_date("завтра", today).as_deref(),
            Some("2026-06-05")
        );
        assert_eq!(
            normalize_due_date("на этой неделе", today).as_deref(),
            Some("2026-06-05")
        );
        assert_eq!(
            normalize_due_date("на следующей неделе", today).as_deref(),
            Some("2026-06-12")
        );
        assert_eq!(
            normalize_due_date("в этом квартале", today).as_deref(),
            Some("2026-06-20")
        );
        assert_eq!(
            normalize_due_date("в следующем квартале", today).as_deref(),
            Some("2026-09-20")
        );
    }

    #[test]
    fn normalizer_ignores_unspecified_due_text() {
        let mut item = raw("Task");
        item.due = Some("не указан".to_string());

        let normalized = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            &[],
            item,
        )
        .expect("normalized");

        assert_eq!(normalized.due, None);
        assert!(!normalized.description.unwrap().contains("Due: не указан"));
    }

    #[test]
    fn normalizer_formats_todoist_description_with_markdown() {
        let mut item = raw("Task");
        item.context = Some("Обсуждали пилот с баннерами".to_string());
        item.assignee = Some("Андрей".to_string());

        let normalized = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            &[],
            item,
        )
        .expect("normalized");

        assert_eq!(
            normalized.description.as_deref(),
            Some("Обсуждали пилот с баннерами\n\n**Исполнитель:** Андрей\n\n*Файл:* `/tmp/session/summary.md`")
        );
    }

    #[test]
    fn normalizer_rejects_invalid_calendar_due_dates() {
        let mut rejected = raw("Task");
        rejected.due = Some("2026-99-99".to_string());

        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            &[],
            rejected,
        )
        .expect("rejected due preserved");

        assert_eq!(item.due, None);
        assert!(item.description.unwrap().contains("Due: 2026-99-99"));
    }

    #[test]
    fn normalizer_uses_stable_deterministic_id() {
        let mut raw = raw("Task");
        raw.due = Some("2026-06-05".to_string());

        let first = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            &[],
            raw.clone(),
        )
        .expect("first");
        let second = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            &[],
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
            &[],
            raw("   "),
        );

        assert!(item.is_none());
    }

    #[test]
    fn normalizer_copies_session_tags_to_todoist_labels() {
        let tags = vec![
            " project/acme ".to_string(),
            "call/sales".to_string(),
            "project/acme".to_string(),
            " ".to_string(),
        ];

        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            &tags,
            raw("Task"),
        )
        .expect("normalized");

        assert_eq!(
            item.labels,
            vec!["project/acme".to_string(), "call/sales".to_string()]
        );
    }
}
