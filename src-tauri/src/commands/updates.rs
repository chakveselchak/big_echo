use serde::{Deserialize, Serialize};

const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/chakveselchak/big_echo/releases/latest";

const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Deserialize)]
pub(crate) struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub is_newer: bool,
    pub html_url: String,
    pub body: String,
    pub name: String,
    pub published_at: String,
}

/// Strip a leading `v` or `V` from a semver-like tag.
pub(crate) fn normalize_tag(tag: &str) -> &str {
    tag.strip_prefix('v').or_else(|| tag.strip_prefix('V')).unwrap_or(tag)
}

/// Return true if `latest` is strictly greater than `current` per semver.
/// If either string doesn't parse, returns false (no update claimed).
pub(crate) fn is_newer_version(current: &str, latest: &str) -> bool {
    let cur = semver::Version::parse(normalize_tag(current));
    let lat = semver::Version::parse(normalize_tag(latest));
    match (cur, lat) {
        (Ok(c), Ok(l)) => l > c,
        _ => false,
    }
}

/// Build an UpdateInfo from a parsed GitHub release and the app's current version.
pub(crate) fn build_update_info(current: &str, release: GithubRelease) -> UpdateInfo {
    let latest = release.tag_name.clone();
    let is_newer = is_newer_version(current, &latest);
    UpdateInfo {
        current: current.to_string(),
        latest,
        is_newer,
        html_url: release.html_url,
        body: release.body.unwrap_or_default(),
        name: release.name.unwrap_or_else(|| release.tag_name.clone()),
        published_at: release.published_at.unwrap_or_default(),
    }
}

async fn fetch_latest_release() -> Result<GithubRelease, String> {
    let client = reqwest::Client::builder()
        .user_agent(CHROME_USER_AGENT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let resp = client
        .get(GITHUB_LATEST_RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub returned status {}", resp.status()));
    }

    resp.json::<GithubRelease>()
        .await
        .map_err(|e| format!("failed to parse GitHub response: {e}"))
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let release = fetch_latest_release().await?;
    Ok(build_update_info(&current, release))
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("URL must use http or https scheme".to_string());
    }

    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(&url)
            .status()
            .map_err(|e| e.to_string())?
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .status()
            .map_err(|e| e.to_string())?
    } else {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .status()
            .map_err(|e| e.to_string())?
    };

    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to open URL: exit status {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_tag_strips_lowercase_v_prefix() {
        assert_eq!(normalize_tag("v2.0.2"), "2.0.2");
    }

    #[test]
    fn normalize_tag_strips_uppercase_v_prefix() {
        assert_eq!(normalize_tag("V2.0.2"), "2.0.2");
    }

    #[test]
    fn normalize_tag_leaves_bare_version_untouched() {
        assert_eq!(normalize_tag("2.0.2"), "2.0.2");
    }

    #[test]
    fn is_newer_true_when_latest_greater() {
        assert!(is_newer_version("2.0.2", "2.1.0"));
    }

    #[test]
    fn is_newer_false_when_equal() {
        assert!(!is_newer_version("2.0.2", "2.0.2"));
    }

    #[test]
    fn is_newer_false_when_latest_lower() {
        assert!(!is_newer_version("2.1.0", "2.0.2"));
    }

    #[test]
    fn is_newer_handles_v_prefix_on_either_side() {
        assert!(is_newer_version("v2.0.2", "v2.1.0"));
    }

    #[test]
    fn is_newer_false_when_unparseable() {
        assert!(!is_newer_version("not-semver", "also-not"));
        assert!(!is_newer_version("2.0.2", "garbage"));
        assert!(!is_newer_version("garbage", "2.0.2"));
    }

    #[test]
    fn build_update_info_fills_defaults_for_missing_fields() {
        let release = GithubRelease {
            tag_name: "2.1.0".to_string(),
            name: None,
            html_url: "https://example.com/r".to_string(),
            body: None,
            published_at: None,
        };
        let info = build_update_info("2.0.2", release);
        assert_eq!(info.current, "2.0.2");
        assert_eq!(info.latest, "2.1.0");
        assert!(info.is_newer);
        assert_eq!(info.body, "");
        assert_eq!(info.name, "2.1.0");
        assert_eq!(info.published_at, "");
        assert_eq!(info.html_url, "https://example.com/r");
    }

    #[test]
    fn build_update_info_reports_not_newer_when_versions_equal() {
        let release = GithubRelease {
            tag_name: "v2.0.2".to_string(),
            name: Some("Release 2.0.2".to_string()),
            html_url: "https://example.com".to_string(),
            body: Some("notes".to_string()),
            published_at: Some("2026-01-01T00:00:00Z".to_string()),
        };
        let info = build_update_info("2.0.2", release);
        assert!(!info.is_newer);
        assert_eq!(info.body, "notes");
        assert_eq!(info.name, "Release 2.0.2");
    }
}
