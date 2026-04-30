// Task 4 wires these helpers into pipeline writes; Task 3 only introduces them.
#![allow(dead_code)]

use crate::domain::session::SessionMeta;
use std::fs;
use std::path::Path;

pub fn render_frontmatter(meta: &SessionMeta) -> String {
    let mut rendered = String::from("---\n");
    rendered.push_str("source: ");
    rendered.push_str(&yaml_quote(meta.source.trim()));
    rendered.push('\n');
    rendered.push_str("tags:\n");
    for tag in meta
        .tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
    {
        rendered.push_str("  - ");
        rendered.push_str(&yaml_quote(tag));
        rendered.push('\n');
    }
    rendered.push_str(&render_notes(&meta.notes));
    rendered.push_str("topic: ");
    rendered.push_str(&yaml_quote(meta.topic.trim()));
    rendered.push('\n');
    rendered.push_str(&render_date(&meta.display_date_ru));
    rendered.push_str("---\n\n");
    rendered
}

fn render_date(display_date_ru: &str) -> String {
    let trimmed = display_date_ru.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("date: {trimmed}\n")
    }
}

pub fn strip_frontmatter(text: &str) -> &str {
    let Some(mut cursor) = opening_frontmatter_len(text) else {
        return text;
    };

    while cursor < text.len() {
        let line_start = cursor;
        let Some(relative_line_end) = text[line_start..].find('\n') else {
            return text;
        };
        let line_end = line_start + relative_line_end;
        let next_line_start = line_end + 1;
        let line = text[line_start..line_end]
            .strip_suffix('\r')
            .unwrap_or(&text[line_start..line_end]);

        if line == "---" {
            let body_start = if text[next_line_start..].starts_with("\r\n") {
                next_line_start + 2
            } else if text[next_line_start..].starts_with('\n') {
                next_line_start + 1
            } else {
                next_line_start
            };
            return &text[body_start..];
        }

        cursor = next_line_start;
    }

    text
}

pub fn render_markdown_artifact(meta: &SessionMeta, body: &str) -> String {
    let mut rendered = render_frontmatter(meta);
    rendered.push_str(body.trim_start_matches('\n'));
    rendered
}

pub fn write_markdown_artifact(path: &Path, meta: &SessionMeta, body: &str) -> Result<(), String> {
    fs::write(path, render_markdown_artifact(meta, body)).map_err(|e| e.to_string())
}

pub fn refresh_markdown_frontmatter(path: &Path, meta: &SessionMeta) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let current = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if current.trim().is_empty() {
        return Ok(());
    }
    let body = strip_frontmatter(&current).to_string();
    let rendered = render_markdown_artifact(meta, &body);
    // Skip disk write entirely when the rendered output equals what's already
    // on disk. With big transcripts/summaries this avoids megabytes of write
    // I/O on every session-metadata autosave even if only unrelated fields
    // changed (status event, timestamps, etc).
    if rendered == current {
        return Ok(());
    }
    fs::write(path, rendered).map_err(|e| e.to_string())
}

fn render_notes(notes: &str) -> String {
    let normalized = notes.replace('\r', "");
    if normalized.trim().is_empty() {
        return "notes: \"\"\n".to_string();
    }
    if !normalized.contains('\n') {
        return format!("notes: {}\n", yaml_quote(normalized.trim()));
    }

    let mut rendered = String::from("notes: |\n");
    for line in normalized.lines() {
        rendered.push_str("  ");
        rendered.push_str(line);
        rendered.push('\n');
    }
    rendered
}

fn opening_frontmatter_len(text: &str) -> Option<usize> {
    if text.starts_with("---\n") {
        Some(4)
    } else if text.starts_with("---\r\n") {
        Some(5)
    } else {
        None
    }
}

fn yaml_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::SessionMeta;
    use tempfile::tempdir;

    fn sample_meta() -> SessionMeta {
        let mut meta = SessionMeta::new(
            "session-md".to_string(),
            "zoom".to_string(),
            vec![
                "project/acme".to_string(),
                "".to_string(),
                "call/sales".to_string(),
            ],
            "Renewal sync".to_string(),
            "Check contract renewal".to_string(),
        );
        meta.display_date_ru = "29.04.2026".to_string();
        meta
    }

    #[test]
    fn render_frontmatter_quotes_fields_and_filters_empty_tags() {
        let meta = sample_meta();

        let frontmatter = render_frontmatter(&meta);

        assert_eq!(
            frontmatter,
            "---\nsource: \"zoom\"\ntags:\n  - \"project/acme\"\n  - \"call/sales\"\nnotes: \"Check contract renewal\"\ntopic: \"Renewal sync\"\ndate: 29.04.2026\n---\n\n"
        );
    }

    #[test]
    fn render_frontmatter_uses_block_scalar_for_multiline_notes() {
        let mut meta = sample_meta();
        meta.notes = "Line one\nLine two\n\nLine four".to_string();

        let frontmatter = render_frontmatter(&meta);

        assert_eq!(
            frontmatter,
            "---\nsource: \"zoom\"\ntags:\n  - \"project/acme\"\n  - \"call/sales\"\nnotes: |\n  Line one\n  Line two\n  \n  Line four\ntopic: \"Renewal sync\"\ndate: 29.04.2026\n---\n\n"
        );
    }

    #[test]
    fn strip_frontmatter_removes_only_leading_yaml_block() {
        let markdown = "---\nsource: \"old\"\n---\n\n# Transcript\n\n---\nnot frontmatter\n";

        assert_eq!(
            strip_frontmatter(markdown),
            "# Transcript\n\n---\nnot frontmatter\n"
        );
        assert_eq!(
            strip_frontmatter("# Transcript\n---\nbody\n"),
            "# Transcript\n---\nbody\n"
        );
        assert_eq!(
            strip_frontmatter("---\nsource: \"unterminated\"\nbody\n"),
            markdownish_unclosed()
        );
    }

    #[test]
    fn render_markdown_artifact_preserves_markdown_horizontal_rules() {
        let meta = sample_meta();
        let body = "---\n\n# Summary\n\n---\n\nBody";

        let artifact = render_markdown_artifact(&meta, body);

        assert_eq!(
            artifact,
            "---\nsource: \"zoom\"\ntags:\n  - \"project/acme\"\n  - \"call/sales\"\nnotes: \"Check contract renewal\"\ntopic: \"Renewal sync\"\ndate: 29.04.2026\n---\n\n---\n\n# Summary\n\n---\n\nBody"
        );
    }

    #[test]
    fn refresh_markdown_frontmatter_preserves_existing_body() {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("transcript.md");
        std::fs::write(
            &path,
            "---\nsource: \"old\"\n---\n\n# Transcript\n\nOriginal body\n",
        )
        .expect("write markdown");

        refresh_markdown_frontmatter(&path, &sample_meta()).expect("refresh frontmatter");

        let refreshed = std::fs::read_to_string(&path).expect("read markdown");
        assert_eq!(
            refreshed,
            "---\nsource: \"zoom\"\ntags:\n  - \"project/acme\"\n  - \"call/sales\"\nnotes: \"Check contract renewal\"\ntopic: \"Renewal sync\"\ndate: 29.04.2026\n---\n\n# Transcript\n\nOriginal body\n"
        );
    }

    #[test]
    fn write_markdown_artifact_writes_rendered_artifact() {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("summary.md");

        write_markdown_artifact(&path, &sample_meta(), "# Summary\n").expect("write artifact");

        let written = std::fs::read_to_string(&path).expect("read artifact");
        assert_eq!(
            written,
            "---\nsource: \"zoom\"\ntags:\n  - \"project/acme\"\n  - \"call/sales\"\nnotes: \"Check contract renewal\"\ntopic: \"Renewal sync\"\ndate: 29.04.2026\n---\n\n# Summary\n"
        );
    }

    #[test]
    fn refresh_markdown_frontmatter_ignores_missing_or_empty_files() {
        let tmp = tempdir().expect("tempdir");
        let missing_path = tmp.path().join("missing.md");
        let empty_path = tmp.path().join("empty.md");
        std::fs::write(&empty_path, "\n").expect("write empty markdown");

        refresh_markdown_frontmatter(&missing_path, &sample_meta()).expect("ignore missing");
        refresh_markdown_frontmatter(&empty_path, &sample_meta()).expect("ignore empty");

        assert!(!missing_path.exists());
        assert_eq!(std::fs::read_to_string(&empty_path).expect("read empty"), "\n");
    }

    fn markdownish_unclosed() -> &'static str {
        "---\nsource: \"unterminated\"\nbody\n"
    }
}
