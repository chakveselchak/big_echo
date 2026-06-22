use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Recording,
    Recorded,
    Transcribed,
    Summarized,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArtifacts {
    pub audio_file: String,
    #[serde(default)]
    pub speed_adjusted_audio_file: String,
    #[serde(default)]
    pub audio_speed_multiplier: Option<f32>,
    pub transcript_file: String,
    pub summary_file: String,
    pub meta_file: String,
    #[serde(default = "default_tasks_sync_file")]
    pub tasks_sync_file: String,
}

fn default_tasks_sync_file() -> String {
    "tasks_sync.json".to_string()
}

impl Default for SessionArtifacts {
    fn default() -> Self {
        Self {
            audio_file: "audio.opus".to_string(),
            speed_adjusted_audio_file: String::new(),
            audio_speed_multiplier: None,
            transcript_file: "transcript.md".to_string(),
            summary_file: "summary.md".to_string(),
            meta_file: "meta.json".to_string(),
            tasks_sync_file: default_tasks_sync_file(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub session_id: String,
    pub created_at_iso: String,
    pub started_at_iso: String,
    pub ended_at_iso: Option<String>,
    pub display_date_ru: String,
    // `source`, `tags` and `notes` are marked `#[serde(default)]` so that
    // meta.json files written before commit f3872a7 (which replaced
    // `participants`/`custom_tag` with `source`/`tags`/`notes`) can still be
    // loaded. Legacy sessions fall back to empty values and backfill the
    // fields on next save.
    #[serde(default)]
    pub source: String,
    pub primary_tag: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: String,
    pub topic: String,
    #[serde(default)]
    pub custom_summary_prompt: String,
    #[serde(default)]
    pub custom_summary_prompt_name: String,
    #[serde(default)]
    pub num_speakers: Option<u32>,
    pub status: SessionStatus,
    pub artifacts: SessionArtifacts,
    #[serde(default)]
    pub errors: Vec<String>,
}

impl SessionMeta {
    pub fn new(
        session_id: String,
        source: String,
        tags: Vec<String>,
        topic: String,
        notes: String,
    ) -> Self {
        let now = Local::now();
        let source = source.trim();
        let source = if source.is_empty() { "general" } else { source }.to_string();

        Self {
            session_id,
            created_at_iso: now.to_rfc3339(),
            started_at_iso: now.to_rfc3339(),
            ended_at_iso: None,
            display_date_ru: format_ru_date(now),
            primary_tag: source.clone(),
            source,
            tags,
            notes,
            topic,
            custom_summary_prompt: String::new(),
            custom_summary_prompt_name: String::new(),
            num_speakers: None,
            status: SessionStatus::Recording,
            artifacts: SessionArtifacts::default(),
            errors: vec![],
        }
    }
}

pub fn format_ru_date(dt: DateTime<Local>) -> String {
    dt.format("%d.%m.%Y").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_meta_new_stores_source_tags_and_notes_independently() {
        let meta = SessionMeta::new(
            "s-meta".to_string(),
            "zoom".to_string(),
            vec!["project/acme".to_string(), "call/sales".to_string()],
            "Renewal sync".to_string(),
            "Check contract renewal".to_string(),
        );

        assert_eq!(meta.source, "zoom");
        assert_eq!(
            meta.tags,
            vec!["project/acme".to_string(), "call/sales".to_string()]
        );
        assert_eq!(meta.notes, "Check contract renewal");
        assert_eq!(meta.primary_tag, "zoom");
    }

    #[test]
    fn session_artifacts_default_includes_tasks_sync_file() {
        let artifacts = SessionArtifacts::default();
        assert_eq!(artifacts.tasks_sync_file, "tasks_sync.json");
    }

    #[test]
    fn session_artifacts_default_has_no_speed_adjusted_audio() {
        let artifacts = SessionArtifacts::default();
        assert_eq!(artifacts.speed_adjusted_audio_file, "");
        assert_eq!(artifacts.audio_speed_multiplier, None);
    }

    #[test]
    fn session_artifacts_deserializes_legacy_json_without_speed_audio_fields() {
        let raw = r#"{
        "audio_file": "audio.opus",
        "transcript_file": "transcript.md",
        "summary_file": "summary.md",
        "meta_file": "meta.json",
        "tasks_sync_file": "tasks_sync.json"
    }"#;

        let artifacts: SessionArtifacts = serde_json::from_str(raw).expect("legacy artifacts");

        assert_eq!(artifacts.speed_adjusted_audio_file, "");
        assert_eq!(artifacts.audio_speed_multiplier, None);
    }

    #[test]
    fn session_artifacts_deserializes_legacy_json_without_tasks_sync_file() {
        let raw = r#"{
        "audio_file": "audio.opus",
        "transcript_file": "transcript.md",
        "summary_file": "summary.md",
        "meta_file": "meta.json"
    }"#;

        let artifacts: SessionArtifacts = serde_json::from_str(raw).expect("legacy artifacts");

        assert_eq!(artifacts.tasks_sync_file, "tasks_sync.json");
    }

    #[test]
    fn session_meta_defaults_missing_custom_summary_prompt_name_to_empty_string() {
        let raw = r#"{
        "session_id": "legacy",
        "created_at_iso": "2026-06-07T10:00:00+03:00",
        "started_at_iso": "2026-06-07T10:00:00+03:00",
        "ended_at_iso": null,
        "display_date_ru": "07.06.2026",
        "source": "zoom",
        "primary_tag": "zoom",
        "tags": [],
        "notes": "",
        "topic": "Legacy",
        "custom_summary_prompt": "Legacy prompt",
        "num_speakers": null,
        "status": "recorded",
        "artifacts": {
            "audio_file": "audio.opus",
            "transcript_file": "transcript.md",
            "summary_file": "summary.md",
            "meta_file": "meta.json"
        },
        "errors": []
    }"#;

        let meta: SessionMeta = serde_json::from_str(raw).expect("legacy meta");

        assert_eq!(meta.custom_summary_prompt, "Legacy prompt");
        assert_eq!(meta.custom_summary_prompt_name, "");
    }
}
