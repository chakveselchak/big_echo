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
    pub transcript_file: String,
    pub summary_file: String,
    pub meta_file: String,
}

impl Default for SessionArtifacts {
    fn default() -> Self {
        Self {
            audio_file: "audio.opus".to_string(),
            transcript_file: "transcript.md".to_string(),
            summary_file: "summary.md".to_string(),
            meta_file: "meta.json".to_string(),
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
}
