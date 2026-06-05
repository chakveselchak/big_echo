use crate::app_state::AppDirs;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/chakveselchak/big_echo/releases/latest";

const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// How long a cached version-check result is considered fresh. We check the
/// GitHub Releases API at most once per 24h regardless of how often the FE
/// invokes `check_for_update` — both within a long-running session and across
/// app restarts.
pub(crate) const CACHE_TTL_SECONDS: i64 = 24 * 60 * 60;

/// Filename for the persisted cache inside `app_data_dir`. Treated as
/// best-effort: malformed/missing files are silently ignored and a fresh
/// network check is performed.
const CACHE_FILE_NAME: &str = "version_check_cache.json";

#[derive(Debug, Deserialize)]
pub(crate) struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub(crate) struct CachedUpdateCheck {
    pub info: UpdateInfo,
    pub checked_at_unix: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
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
    tag.strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag)
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

pub(crate) fn cache_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CACHE_FILE_NAME)
}

/// Best-effort load of the persisted cache. Returns `None` on any I/O or
/// parse error so the caller falls back to a network fetch.
pub(crate) fn load_cached_check(app_data_dir: &Path) -> Option<CachedUpdateCheck> {
    let raw = std::fs::read_to_string(cache_file_path(app_data_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Best-effort persist. Errors are swallowed: a failure to write the cache
/// just means the next call hits the network again, which is acceptable.
pub(crate) fn save_cached_check(app_data_dir: &Path, cached: &CachedUpdateCheck) {
    let _ = std::fs::create_dir_all(app_data_dir);
    if let Ok(raw) = serde_json::to_string_pretty(cached) {
        let _ = std::fs::write(cache_file_path(app_data_dir), raw);
    }
}

/// True iff `cached` is within the freshness TTL relative to `now_unix`.
/// `cached.checked_at_unix > now_unix` (clock went backwards / stale clone)
/// also counts as fresh — refusing to refetch under unusual clock states is
/// safer than busy-looping the network.
pub(crate) fn is_cache_fresh(cached: &CachedUpdateCheck, now_unix: i64) -> bool {
    let age = now_unix.saturating_sub(cached.checked_at_unix);
    age < CACHE_TTL_SECONDS
}

/// Pure-ish core for `check_for_update`: rate-limits actual network fetches
/// to once per `CACHE_TTL_SECONDS`. Caller injects `now_unix` and `fetcher`
/// so unit tests can drive both freshness and the network response.
pub(crate) async fn check_with_cache<F, Fut>(
    current: &str,
    app_data_dir: &Path,
    now_unix: i64,
    fetcher: F,
) -> Result<UpdateInfo, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<GithubRelease, String>>,
{
    if let Some(cached) = load_cached_check(app_data_dir) {
        if is_cache_fresh(&cached, now_unix) && cached.info.current == current {
            return Ok(cached.info);
        }
    }
    let release = fetcher().await?;
    let info = build_update_info(current, release);
    save_cached_check(
        app_data_dir,
        &CachedUpdateCheck {
            info: info.clone(),
            checked_at_unix: now_unix,
        },
    );
    Ok(info)
}

#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    dirs: tauri::State<'_, AppDirs>,
) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let app_data_dir = dirs.app_data_dir.clone();
    let now_unix = chrono::Utc::now().timestamp();
    check_with_cache(&current, &app_data_dir, now_unix, fetch_latest_release).await
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

    fn sample_cached(checked_at_unix: i64, current: &str) -> CachedUpdateCheck {
        CachedUpdateCheck {
            info: UpdateInfo {
                current: current.to_string(),
                latest: "2.1.0".to_string(),
                is_newer: true,
                html_url: "https://example.com/r".to_string(),
                body: "cached".to_string(),
                name: "v2.1.0".to_string(),
                published_at: "2026-04-20T00:00:00Z".to_string(),
            },
            checked_at_unix,
        }
    }

    fn sample_release_tag(tag: &str) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            name: Some(tag.to_string()),
            html_url: format!("https://example.com/{tag}"),
            body: Some(format!("notes for {tag}")),
            published_at: Some("2026-04-20T00:00:00Z".to_string()),
        }
    }

    #[test]
    fn is_cache_fresh_within_ttl() {
        let cached = sample_cached(1000, "2.0.2");
        assert!(is_cache_fresh(&cached, 1000));
        assert!(is_cache_fresh(&cached, 1000 + CACHE_TTL_SECONDS - 1));
        assert!(!is_cache_fresh(&cached, 1000 + CACHE_TTL_SECONDS));
        assert!(!is_cache_fresh(&cached, 1000 + CACHE_TTL_SECONDS + 1));
    }

    #[test]
    fn is_cache_fresh_treats_clock_skew_as_fresh() {
        // Clock went backwards (e.g. NTP correction or restored snapshot):
        // refusing the cache could create a busy-loop of fetches.
        let cached = sample_cached(2_000_000, "2.0.2");
        assert!(is_cache_fresh(&cached, 1_000_000));
    }

    #[tokio::test]
    async fn check_with_cache_uses_fresh_cache_without_fetching() {
        let tmp = tempfile::tempdir().expect("tempdir");
        save_cached_check(tmp.path(), &sample_cached(1000, "2.0.2"));

        let fetcher_called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fetcher_called_clone = fetcher_called.clone();
        let fetcher = move || {
            let called = fetcher_called_clone.clone();
            async move {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(sample_release_tag("v3.0.0"))
            }
        };

        let info = check_with_cache("2.0.2", tmp.path(), 1500, fetcher)
            .await
            .expect("check_with_cache");

        assert_eq!(info.body, "cached", "must return cached info");
        assert_eq!(info.latest, "2.1.0");
        assert!(
            !fetcher_called.load(std::sync::atomic::Ordering::SeqCst),
            "fetcher must not be called while cache is fresh"
        );
    }

    #[tokio::test]
    async fn check_with_cache_refetches_when_stale() {
        let tmp = tempfile::tempdir().expect("tempdir");
        save_cached_check(tmp.path(), &sample_cached(1000, "2.0.2"));

        let fetcher = || async { Ok(sample_release_tag("v3.0.0")) };
        let now = 1000 + CACHE_TTL_SECONDS + 1;
        let info = check_with_cache("2.0.2", tmp.path(), now, fetcher)
            .await
            .expect("check_with_cache");

        assert_eq!(info.latest, "v3.0.0", "stale cache must trigger refetch");

        // The new result must persist with the supplied `now_unix` so the
        // next call within TTL keeps using it.
        let cached = load_cached_check(tmp.path()).expect("cache persisted");
        assert_eq!(cached.checked_at_unix, now);
        assert_eq!(cached.info.latest, "v3.0.0");
    }

    #[tokio::test]
    async fn check_with_cache_fetches_when_no_cache_exists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let fetcher = || async { Ok(sample_release_tag("v2.5.0")) };
        let info = check_with_cache("2.0.2", tmp.path(), 12345, fetcher)
            .await
            .expect("check_with_cache");

        assert_eq!(info.latest, "v2.5.0");
        let cached = load_cached_check(tmp.path()).expect("cache persisted");
        assert_eq!(cached.info.latest, "v2.5.0");
        assert_eq!(cached.checked_at_unix, 12345);
    }

    #[tokio::test]
    async fn check_with_cache_invalidates_when_app_version_changed() {
        // App was upgraded since the last cache write — reusing the cached
        // `is_newer` flag would be wrong (it was computed against the old
        // version). Force a refetch.
        let tmp = tempfile::tempdir().expect("tempdir");
        save_cached_check(tmp.path(), &sample_cached(1000, "2.0.2"));

        let fetcher = || async { Ok(sample_release_tag("v2.5.0")) };
        let info = check_with_cache("2.5.0", tmp.path(), 1500, fetcher)
            .await
            .expect("check_with_cache");

        assert_eq!(info.current, "2.5.0");
        assert!(!info.is_newer, "current matches latest, no upgrade prompt");
    }

    #[tokio::test]
    async fn check_with_cache_returns_fetcher_error_and_does_not_persist() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let fetcher = || async { Err::<GithubRelease, _>("network down".to_string()) };
        let result = check_with_cache("2.0.2", tmp.path(), 12345, fetcher).await;

        assert!(matches!(result, Err(ref err) if err == "network down"));
        assert!(
            load_cached_check(tmp.path()).is_none(),
            "fetch failure must not write cache",
        );
    }

    #[test]
    fn load_cached_check_returns_none_for_missing_or_corrupt_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(load_cached_check(tmp.path()).is_none());

        std::fs::write(cache_file_path(tmp.path()), "{not json").expect("write corrupt cache");
        assert!(load_cached_check(tmp.path()).is_none());
    }
}
