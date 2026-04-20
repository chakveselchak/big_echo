use serde::{Deserialize, Serialize};

const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/chakveselchak/big_echo/releases/latest";

const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Deserialize)]
struct GithubRelease {
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
