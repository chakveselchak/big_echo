use crate::storage::markdown_artifact::strip_frontmatter;
use crate::task_sync::model::ExtractedActionItem;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ExtractionResult {
    pub items: Vec<ExtractedActionItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineSummary {
    #[serde(default)]
    action_items: Vec<ExtractedActionItem>,
}

pub fn extract_action_items(summary_md_path: &Path) -> Result<ExtractionResult, String> {
    let summary_json_path = summary_md_path.with_file_name("summary.json");
    let mut warnings = Vec::new();

    if summary_json_path.exists() {
        match std::fs::read_to_string(&summary_json_path)
            .map_err(|e| e.to_string())
            .and_then(|raw| serde_json::from_str::<MachineSummary>(&raw).map_err(|e| e.to_string()))
        {
            Ok(summary) => {
                return Ok(ExtractionResult {
                    items: summary.action_items,
                    warnings,
                });
            }
            Err(err) => warnings.push(format!("summary.json invalid: {err}")),
        }
    }

    if !summary_md_path.exists() {
        warnings.push("summary.md not found".to_string());
        return Ok(ExtractionResult {
            items: Vec::new(),
            warnings,
        });
    }

    let raw = std::fs::read_to_string(summary_md_path).map_err(|e| e.to_string())?;
    let body = strip_frontmatter(&raw);
    Ok(ExtractionResult {
        items: extract_from_markdown(body),
        warnings,
    })
}

fn extract_from_markdown(body: &str) -> Vec<ExtractedActionItem> {
    let mut in_action_section = false;
    let mut table_header: Option<Vec<String>> = None;
    let mut items = Vec::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let heading = trimmed.trim_start_matches('#').trim();
            in_action_section = is_action_heading(heading);
            table_header = None;
            continue;
        }
        if !in_action_section {
            continue;
        }
        if let Some(cells) = parse_markdown_table_row(trimmed) {
            if is_markdown_table_separator(&cells) {
                continue;
            }
            if is_action_table_header(&cells) {
                table_header = Some(cells);
                continue;
            }
            if let Some(header) = table_header.as_deref() {
                if let Some(item) = action_item_from_table_row(header, &cells) {
                    items.push(item);
                }
            }
            continue;
        }
        let title = trimmed
            .strip_prefix("- [ ]")
            .or_else(|| trimmed.strip_prefix("* [ ]"))
            .or_else(|| trimmed.strip_prefix("-"))
            .or_else(|| trimmed.strip_prefix("*"))
            .map(str::trim)
            .unwrap_or("");
        if !title.is_empty() {
            items.push(ExtractedActionItem {
                title: title.to_string(),
                description: None,
                due: None,
                priority: None,
                assignee: None,
                source: None,
                context: None,
            });
        }
    }
    items
}

fn parse_markdown_table_row(line: &str) -> Option<Vec<String>> {
    if !line.starts_with('|') {
        return None;
    }

    let trimmed = line.trim_matches('|');
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    let mut in_code = false;

    for ch in trimmed.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '`' {
            in_code = !in_code;
            current.push(ch);
            continue;
        }
        if ch == '|' && !in_code {
            cells.push(current.trim().to_string());
            current.clear();
            continue;
        }
        current.push(ch);
    }
    cells.push(current.trim().to_string());

    if cells.len() < 2 {
        return None;
    }
    Some(cells)
}

fn is_markdown_table_separator(cells: &[String]) -> bool {
    cells.iter().all(|cell| {
        let value = cell.trim();
        !value.is_empty()
            && value
                .chars()
                .all(|ch| ch == '-' || ch == ':' || ch.is_whitespace())
    })
}

fn is_action_table_header(cells: &[String]) -> bool {
    find_column(cells, &["задач", "task"]).is_some()
}

fn find_column(headers: &[String], needles: &[&str]) -> Option<usize> {
    headers.iter().position(|header| {
        let normalized = header.trim().to_lowercase();
        needles.iter().any(|needle| normalized.contains(needle))
    })
}

fn optional_cell(cells: &[String], index: Option<usize>) -> Option<String> {
    index
        .and_then(|idx| cells.get(idx))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn action_item_from_table_row(headers: &[String], cells: &[String]) -> Option<ExtractedActionItem> {
    let title_index = find_column(headers, &["задач", "task"])?;
    let title = optional_cell(cells, Some(title_index))?;
    let assignee = optional_cell(
        cells,
        find_column(headers, &["ответ", "исполн", "assignee", "owner"]),
    );
    let due = optional_cell(cells, find_column(headers, &["срок", "due"]));
    let context = optional_cell(
        cells,
        find_column(headers, &["комментар", "comment", "context"]),
    );

    Some(ExtractedActionItem {
        title,
        description: None,
        due,
        priority: None,
        assignee,
        source: None,
        context,
    })
}

fn is_action_heading(heading: &str) -> bool {
    let normalized = heading.trim().to_lowercase();
    if normalized.contains("задач") || normalized.contains("действ") {
        return true;
    }

    let words = normalized
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();

    words.contains(&"actions") || words.windows(2).any(|window| window == ["action", "items"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn extractor_prefers_summary_json_action_items() {
        let tmp = tempdir().expect("tempdir");
        let summary_md = tmp.path().join("summary.md");
        let summary_json = tmp.path().join("summary.json");
        std::fs::write(&summary_md, "## Action items\n- fallback").expect("summary md");
        std::fs::write(
            &summary_json,
            r#"{"summary":"x","decisions":[],"actionItems":[{"title":"JSON task","due":"2026-06-05","priority":3}]}"#,
        )
        .expect("summary json");

        let result = extract_action_items(&summary_md).expect("extract");

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "JSON task");
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn extractor_falls_back_to_markdown_checkbox_items() {
        let tmp = tempdir().expect("tempdir");
        let summary_md = tmp.path().join("summary.md");
        std::fs::write(
            &summary_md,
            "---\nsource: \"zoom\"\n---\n\n## Action Items\n- [ ] Согласовать SAP_ID\n- [ ] Отправить договор\n",
        )
        .expect("summary md");

        let result = extract_action_items(&summary_md).expect("extract");

        assert_eq!(
            result
                .items
                .iter()
                .map(|i| i.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Согласовать SAP_ID", "Отправить договор",]
        );
    }

    #[test]
    fn extractor_falls_back_to_markdown_action_item_table() {
        let tmp = tempdir().expect("tempdir");
        let summary_md = tmp.path().join("summary.md");
        std::fs::write(
            &summary_md,
            r#"## 6. Задачи и ответственные (Action Items)

| Задача | Ответственный | Срок | Комментарий |
|------|------|------|------|
| Передать благодарность/зафиксировать вклад Сергея Пакова по событию Альфа-Банка и фонда «Линия жизни» | speaker_2 | не указан | Благодарность уже озвучена на встрече |
| Довести добавление `referrer` в логах для нужных проектов | Егор / Саид / Годино | не указан | Для Alpha — нужно; для Sber — пока пауза; для белорусских проектов — актуально |
"#,
        )
        .expect("summary md");

        let result = extract_action_items(&summary_md).expect("extract");

        assert_eq!(result.items.len(), 2);
        assert_eq!(
            result.items[0].title,
            "Передать благодарность/зафиксировать вклад Сергея Пакова по событию Альфа-Банка и фонда «Линия жизни»"
        );
        assert_eq!(result.items[0].assignee.as_deref(), Some("speaker_2"));
        assert_eq!(result.items[0].due.as_deref(), Some("не указан"));
        assert_eq!(
            result.items[0].context.as_deref(),
            Some("Благодарность уже озвучена на встрече")
        );
        assert_eq!(
            result.items[1].title,
            "Довести добавление `referrer` в логах для нужных проектов"
        );
        assert_eq!(
            result.items[1].assignee.as_deref(),
            Some("Егор / Саид / Годино")
        );
        assert_eq!(
            result.items[1].context.as_deref(),
            Some("Для Alpha — нужно; для Sber — пока пауза; для белорусских проектов — актуально")
        );
    }

    #[test]
    fn extractor_ignores_transactions_heading() {
        let tmp = tempdir().expect("tempdir");
        let summary_md = tmp.path().join("summary.md");
        std::fs::write(&summary_md, "## Transactions\n- payment detail\n").expect("summary md");

        let result = extract_action_items(&summary_md).expect("extract");

        assert!(result.items.is_empty());
    }

    #[test]
    fn extractor_falls_back_to_markdown_when_summary_json_invalid() {
        let tmp = tempdir().expect("tempdir");
        let summary_md = tmp.path().join("summary.md");
        let summary_json = tmp.path().join("summary.json");
        std::fs::write(&summary_md, "## Action Items\n- [ ] Markdown task\n").expect("summary md");
        std::fs::write(&summary_json, "{invalid json").expect("summary json");

        let result = extract_action_items(&summary_md).expect("extract");

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "Markdown task");
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.starts_with("summary.json invalid:")));
    }

    #[test]
    fn extractor_returns_empty_items_for_missing_summary() {
        let tmp = tempdir().expect("tempdir");
        let result = extract_action_items(&tmp.path().join("summary.md")).expect("extract");

        assert!(result.items.is_empty());
        assert_eq!(result.warnings, vec!["summary.md not found"]);
    }
}
