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
    let mut items = Vec::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let heading = trimmed.trim_start_matches('#').trim();
            in_action_section = is_action_heading(heading);
            continue;
        }
        if !in_action_section {
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

fn is_action_heading(heading: &str) -> bool {
    let normalized = heading.trim().to_lowercase();
    if normalized.contains("задач") || normalized.contains("действ") {
        return true;
    }

    let words = normalized
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();

    words.contains(&"actions")
        || words
            .windows(2)
            .any(|window| window == ["action", "items"])
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
