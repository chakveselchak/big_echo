use crate::storage::session_store::load_meta;
use crate::storage::sqlite_repo::{get_meta_path, list_sessions};
use std::collections::BTreeSet;
use std::path::Path;

pub fn normalize_tag(value: &str) -> Option<String> {
    let tag = value.trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

pub fn normalize_tags(values: Vec<String>) -> Vec<String> {
    let mut tags = BTreeSet::new();
    for value in values {
        if let Some(tag) = normalize_tag(&value) {
            tags.insert(tag);
        }
    }
    tags.into_iter().collect()
}

pub fn collect_known_tags(app_data_dir: &Path) -> Result<Vec<String>, String> {
    let sessions = list_sessions(app_data_dir)?;
    let mut tags = BTreeSet::new();
    for session in sessions {
        let Some(meta_path) = get_meta_path(app_data_dir, &session.session_id)? else {
            continue;
        };
        let Ok(meta) = load_meta(&meta_path) else {
            continue;
        };
        for tag in meta.tags {
            if let Some(normalized) = normalize_tag(&tag) {
                tags.insert(normalized);
            }
        }
    }
    Ok(tags.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::SessionMeta;
    use crate::storage::session_store::save_meta;
    use crate::storage::sqlite_repo::upsert_session;
    use tempfile::tempdir;

    #[test]
    fn collect_known_tags_returns_sorted_unique_non_empty_tags() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        std::fs::create_dir_all(&app_data_dir).expect("app data");
        let session_dir = tmp.path().join("s1");
        std::fs::create_dir_all(&session_dir).expect("session dir");
        let meta_path = session_dir.join("meta.json");
        let mut meta = SessionMeta::new(
            "s-tags".to_string(),
            "zoom".to_string(),
            vec![
                "project/acme".to_string(),
                "call/sales".to_string(),
                "project/acme".to_string(),
                " ".to_string(),
            ],
            "Topic".to_string(),
            String::new(),
        );
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert");

        meta.session_id = "s-tags-2".to_string();
        meta.tags = vec!["person/ivan".to_string(), "call/sales".to_string()];
        let session_dir_2 = tmp.path().join("s2");
        std::fs::create_dir_all(&session_dir_2).expect("session dir 2");
        let meta_path_2 = session_dir_2.join("meta.json");
        save_meta(&meta_path_2, &meta).expect("save meta 2");
        upsert_session(&app_data_dir, &meta, &session_dir_2, &meta_path_2).expect("upsert 2");

        let tags = collect_known_tags(&app_data_dir).expect("tags");

        assert_eq!(
            tags,
            vec![
                "call/sales".to_string(),
                "person/ivan".to_string(),
                "project/acme".to_string()
            ]
        );
    }
}
