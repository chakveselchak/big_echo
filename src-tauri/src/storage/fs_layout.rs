use chrono::{DateTime, Local};
use std::path::PathBuf;

pub fn build_session_relative_dir(_primary_tag: &str, started_at: DateTime<Local>) -> PathBuf {
    let date_part = started_at.format("%d.%m.%Y").to_string();
    let time_part = started_at.format("%H-%M-%S").to_string();
    PathBuf::from(date_part).join(format!("meeting_{}", time_part))
}

pub fn transcript_name(started_at: DateTime<Local>) -> String {
    format!("transcript_{}.txt", started_at.format("%d.%m.%Y"))
}

pub fn summary_name(started_at: DateTime<Local>) -> String {
    format!("summary_{}.md", started_at.format("%d.%m.%Y"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};

    #[test]
    fn builds_russian_date_layout() {
        let dt = FixedOffset::east_opt(3 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 10, 15, 6, 7)
            .unwrap()
            .with_timezone(&Local);

        let p = build_session_relative_dir("Zoom Team", dt);
        assert!(p.ends_with("10.03.2026/meeting_15-06-07"));
        assert!(!p.to_string_lossy().contains("zoom_team"));
    }

    #[test]
    fn builds_artifact_names_in_ru_date() {
        let dt = FixedOffset::east_opt(3 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 10, 8, 0, 0)
            .unwrap()
            .with_timezone(&Local);

        assert_eq!(transcript_name(dt), "transcript_10.03.2026.txt");
        assert_eq!(summary_name(dt), "summary_10.03.2026.md");
    }
}
