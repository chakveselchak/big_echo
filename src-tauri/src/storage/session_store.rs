use crate::domain::session::SessionMeta;
use std::fs;
use std::path::Path;

pub fn save_meta(path: &Path, meta: &SessionMeta) -> Result<(), String> {
    let body = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())
}

pub fn load_meta(path: &Path) -> Result<SessionMeta, String> {
    let body = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut meta: SessionMeta = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    normalize_legacy_summary_artifact(&mut meta);
    normalize_legacy_source(&mut meta);
    Ok(meta)
}

/// Fills `source` from `primary_tag` for legacy meta.json files written before
/// commit f3872a7 (when `source` did not exist as a separate field).
fn normalize_legacy_source(meta: &mut SessionMeta) {
    if meta.source.trim().is_empty() {
        meta.source = if meta.primary_tag.trim().is_empty() {
            "general".to_string()
        } else {
            meta.primary_tag.clone()
        };
    }
}

fn normalize_legacy_summary_artifact(meta: &mut SessionMeta) {
    let summary_file = meta.artifacts.summary_file.trim();
    if summary_file.is_empty() {
        meta.artifacts.summary_file = "summary.md".to_string();
        return;
    }

    let path = Path::new(summary_file);
    let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
        return;
    };

    if ext.eq_ignore_ascii_case("txt") {
        meta.artifacts.summary_file = path.with_extension("md").to_string_lossy().to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::SessionArtifacts;
    use tempfile::tempdir;

    #[test]
    fn load_meta_keeps_md_summary_artifact_name() {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("meta.json");
        let mut meta = SessionMeta::new(
            "session-md".to_string(),
            "zoom".to_string(),
            vec!["zoom".to_string()],
            "Topic".to_string(),
            "Notes".to_string(),
        );
        meta.artifacts = SessionArtifacts {
            audio_file: "audio.opus".to_string(),
            transcript_file: "transcript.txt".to_string(),
            summary_file: "summary_10.03.2026.md".to_string(),
            meta_file: "meta.json".to_string(),
        };
        save_meta(&path, &meta).expect("save meta");

        let loaded = load_meta(&path).expect("load meta");
        assert_eq!(loaded.artifacts.summary_file, "summary_10.03.2026.md");
    }

    #[test]
    fn load_meta_normalizes_legacy_summary_txt_to_md() {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("meta.json");
        let mut meta = SessionMeta::new(
            "session-txt".to_string(),
            "zoom".to_string(),
            vec!["zoom".to_string()],
            "Topic".to_string(),
            "Notes".to_string(),
        );
        meta.artifacts = SessionArtifacts {
            audio_file: "audio.opus".to_string(),
            transcript_file: "transcript.txt".to_string(),
            summary_file: "summary_10.03.2026.txt".to_string(),
            meta_file: "meta.json".to_string(),
        };
        save_meta(&path, &meta).expect("save meta");

        let loaded = load_meta(&path).expect("load meta");
        assert_eq!(loaded.artifacts.summary_file, "summary_10.03.2026.md");
    }

    #[test]
    fn load_meta_defaults_missing_custom_summary_prompt_to_empty_string() {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("meta.json");
        let meta = SessionMeta::new(
            "legacy-session".to_string(),
            "zoom".to_string(),
            vec!["zoom".to_string()],
            "Topic".to_string(),
            "Notes".to_string(),
        );
        let mut body = serde_json::to_value(&meta).expect("serialize meta");
        body.as_object_mut()
            .expect("meta object")
            .remove("custom_summary_prompt");
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&body).expect("serialize legacy meta"),
        )
        .expect("write legacy meta");

        let loaded = load_meta(&path).expect("load meta");
        let loaded_json = serde_json::to_value(loaded).expect("serialize loaded meta");
        assert_eq!(loaded_json["custom_summary_prompt"], "");
    }

    #[test]
    fn load_meta_accepts_pre_source_tags_notes_schema() {
        // Sessions recorded before commit f3872a7 have no `source`/`tags`/`notes`
        // fields and still carry `participants`. Serde must accept them via
        // `#[serde(default)]` defaults, and normalization must fall back to
        // `primary_tag` for `source`. Otherwise the app silently loses
        // audio_format/has_transcript_text/etc. for these sessions.
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("meta.json");
        let legacy_body = serde_json::json!({
            "session_id": "legacy-1",
            "created_at_iso": "2026-03-27T14:10:00+03:00",
            "started_at_iso": "2026-03-27T14:10:00+03:00",
            "ended_at_iso": null,
            "display_date_ru": "27.03.2026",
            "primary_tag": "slack",
            "topic": "team-a_backend_team",
            "participants": ["user-a", "user-b"],
            "custom_summary_prompt": "",
            "status": "done",
            "artifacts": {
                "audio_file": "audio.opus",
                "transcript_file": "transcript.md",
                "summary_file": "summary.md",
                "meta_file": "meta.json",
            },
            "errors": [],
        });
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&legacy_body).expect("serialize legacy meta"),
        )
        .expect("write legacy meta");

        let loaded = load_meta(&path).expect("load legacy meta");
        assert_eq!(loaded.session_id, "legacy-1");
        assert_eq!(loaded.primary_tag, "slack");
        assert_eq!(loaded.source, "slack", "source must fall back to primary_tag");
        assert!(loaded.tags.is_empty(), "tags must default to empty vec");
        assert_eq!(loaded.notes, "", "notes must default to empty string");
        assert_eq!(loaded.artifacts.audio_file, "audio.opus");
    }
}
