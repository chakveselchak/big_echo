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
    Ok(meta)
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
            vec!["zoom".to_string()],
            "Topic".to_string(),
            vec!["Alice".to_string()],
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
            vec!["zoom".to_string()],
            "Topic".to_string(),
            vec!["Alice".to_string()],
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
}
