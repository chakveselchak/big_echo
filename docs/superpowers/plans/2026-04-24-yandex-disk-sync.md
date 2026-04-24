# Yandex.Disk sync — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new Settings tab that lets the user mirror the recording root to their Yandex.Disk account one-way, with manual, startup, and periodic runs.

**Architecture:** Three new public settings (`yandex_sync_enabled`, `yandex_sync_interval`, `yandex_sync_remote_folder`) backed by keyring-stored OAuth token. A new `services/yandex_disk/` module holds the HTTP client (`client.rs`), the per-run algorithm (`sync_runner.rs` — walk recording root, list each remote directory, upload missing-or-size-mismatched files), and a background scheduler (`scheduler.rs`) spawned once at startup. Tauri commands `yandex_sync_now`, `yandex_sync_status`, and token helpers expose the feature to the frontend, which renders a new `YandexSyncSettings` tab with progress and last-run status.

**Tech Stack:** Rust + Tauri 2 backend (reqwest, tokio, `async-trait`, `tokio-util` for streaming uploads, `wiremock` in dev-deps); React 18 + TypeScript + AntD frontend; Vitest + jsdom + RTL.

**Spec:** `docs/superpowers/specs/2026-04-24-yandex-disk-sync-design.md`

---

## File map

| File | Change |
|---|---|
| `src-tauri/src/settings/public_settings.rs` | Add `yandex_sync_enabled`, `yandex_sync_interval`, `yandex_sync_remote_folder` fields + defaults + validation + tests. |
| `src-tauri/src/settings/secret_store.rs` | Add `clear_secret(app_data_dir, name)` helper + tests. |
| `src-tauri/src/main.rs` | Update 2 `PublicSettings { .. }` test fixtures (lines 827-854 and 882-909). Register 5 new commands in both `generate_handler!` blocks (prod + test). Spawn the Yandex.Disk scheduler at setup. |
| `src-tauri/src/commands/sessions.rs` | Update 1 `PublicSettings { .. }` test fixture around line 1227. |
| `src-tauri/src/services/pipeline_runner.rs` | Update 1 `PublicSettings { .. }` test fixture around line 401. |
| `src-tauri/src/pipeline/mod.rs` | Update 9 `PublicSettings { .. }` test fixtures (lines 1302, 1375, 1476, 1608, 1712, 1833, 2001, 2069, 2120). |
| `src-tauri/src/services/mod.rs` | Re-export the new `yandex_disk` module. |
| `src-tauri/src/services/yandex_disk/mod.rs` | New — module root. |
| `src-tauri/src/services/yandex_disk/state.rs` | New — runtime state types + public snapshot for the UI. |
| `src-tauri/src/services/yandex_disk/client.rs` | New — `YandexDiskApi` trait + `HttpYandexDiskClient` impl. |
| `src-tauri/src/services/yandex_disk/sync_runner.rs` | New — one-pass sync algorithm with progress callback. |
| `src-tauri/src/services/yandex_disk/scheduler.rs` | New — background loop with injectable sleep + shutdown. |
| `src-tauri/src/commands/yandex_sync.rs` | New — 5 Tauri commands. |
| `src-tauri/src/commands/mod.rs` | Register the new `yandex_sync` sub-module. |
| `src-tauri/src/app_state.rs` | Add `yandex_sync: Arc<Mutex<YandexSyncRuntimeState>>` to `AppState` + default. |
| `src-tauri/Cargo.toml` | Add `async-trait = "0.1"`, `tokio-util = { version = "0.7", features = ["io"] }` to `[dependencies]`; add `wiremock = "0.6"` to `[dev-dependencies]`. |
| `src/types/index.ts` | Add three fields to `PublicSettings`; extend `SettingsTab` to include `"yandex"`; add `YandexSyncFileError`, `YandexSyncLastRun`, `YandexSyncStatus`, `YandexSyncProgress`. |
| `src/hooks/useYandexSync.ts` | New — hook for token ops, status polling, progress events. |
| `src/components/settings/YandexSyncSettings.tsx` | New — the settings tab content. |
| `src/pages/SettingsPage/index.tsx` | Add the fourth tab entry and the `yandex` key to `dirtyByTab`. |
| `src/App.main.test.tsx` | Update 11 `PublicSettings` fixtures (lines 44, 449, 654, 812, 937, 1032, 1132, 1243, 1430, 1513, 1575). |
| `src/App.tray.test.tsx` | Update 4 fixtures (lines 70, 274, 311, 395). |
| `src/App.settings.test.tsx` | Update 3 fixtures (lines 29, 129, 470); add test covering the fourth tab. |
| `src/hooks/useSettingsForm.test.tsx` | Update 1 fixture (line 24). |
| `src/components/settings/YandexSyncSettings.test.tsx` | New — component tests. |
| `src/hooks/useYandexSync.test.ts` | New — hook tests. |

---

## Task 1: Settings fields + fixture propagation

**Files:**
- Modify: `src-tauri/src/settings/public_settings.rs`
- Modify: `src-tauri/src/main.rs` (lines 827-854, 882-909)
- Modify: `src-tauri/src/commands/sessions.rs` (line 1227)
- Modify: `src-tauri/src/services/pipeline_runner.rs` (line 401)
- Modify: `src-tauri/src/pipeline/mod.rs` (lines 1302, 1375, 1476, 1608, 1712, 1833, 2001, 2069, 2120)
- Modify: `src/types/index.ts`
- Modify: `src/App.main.test.tsx`, `src/App.tray.test.tsx`, `src/App.settings.test.tsx`, `src/hooks/useSettingsForm.test.tsx`

- [ ] **Step 1: Write failing tests for the new fields**

Append inside the existing `mod tests` block at the end of `src-tauri/src/settings/public_settings.rs` (just before the final closing `}`):

```rust
    #[test]
    fn yandex_sync_defaults_are_disabled_with_24h_interval() {
        let s = PublicSettings::default();
        assert!(!s.yandex_sync_enabled);
        assert_eq!(s.yandex_sync_interval, "24h");
        assert_eq!(s.yandex_sync_remote_folder, "BigEcho");
    }

    #[test]
    fn missing_yandex_sync_fields_use_defaults() {
        // Older settings.json without any yandex_sync_* keys must still parse.
        let body = r#"{
            "recording_root":"./recordings",
            "artifact_open_app":"",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "transcription_task":"transcribe",
            "transcription_diarization_setting":"general",
            "salute_speech_scope":"SALUTE_SPEECH_CORP",
            "salute_speech_model":"general",
            "salute_speech_language":"ru-RU",
            "salute_speech_sample_rate":48000,
            "salute_speech_channels_count":1,
            "summary_url":"",
            "summary_prompt":"",
            "openai_model":"gpt-4.1-mini",
            "audio_format":"opus",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":"",
            "auto_run_pipeline_on_stop":false,
            "api_call_logging_enabled":false,
            "auto_delete_audio_enabled":false,
            "auto_delete_audio_days":30
        }"#;
        let parsed: PublicSettings = serde_json::from_str(body).expect("settings should parse");
        assert!(!parsed.yandex_sync_enabled);
        assert_eq!(parsed.yandex_sync_interval, "24h");
        assert_eq!(parsed.yandex_sync_remote_folder, "BigEcho");
    }

    #[test]
    fn accepts_valid_yandex_sync_intervals() {
        for iv in ["1h", "6h", "24h", "48h"] {
            let s = PublicSettings {
                yandex_sync_interval: iv.to_string(),
                ..Default::default()
            };
            assert!(s.validate().is_ok(), "interval {iv} should be valid");
        }
    }

    #[test]
    fn rejects_invalid_yandex_sync_interval() {
        let s = PublicSettings {
            yandex_sync_interval: "5m".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex sync interval".to_string()));
    }

    #[test]
    fn rejects_remote_folder_with_dotdot() {
        let s = PublicSettings {
            yandex_sync_remote_folder: "BigEcho/../evil".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex remote folder".to_string()));
    }

    #[test]
    fn rejects_empty_remote_folder_after_trim() {
        let s = PublicSettings {
            yandex_sync_remote_folder: "   /".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex remote folder".to_string()));
    }

    #[test]
    fn rejects_remote_folder_with_backslash() {
        let s = PublicSettings {
            yandex_sync_remote_folder: "Big\\Echo".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex remote folder".to_string()));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::public_settings::tests::yandex`
Expected: the seven tests fail (compile error — unknown fields on `PublicSettings`).

- [ ] **Step 3: Add the three fields, defaults, and validation**

In `src-tauri/src/settings/public_settings.rs`, append to the `PublicSettings` struct (just after `auto_delete_audio_days: u32,`):

```rust
    pub yandex_sync_enabled: bool,
    pub yandex_sync_interval: String,
    pub yandex_sync_remote_folder: String,
```

Append to the `impl Default for PublicSettings` literal (just after `auto_delete_audio_days: 30,`):

```rust
            yandex_sync_enabled: false,
            yandex_sync_interval: "24h".to_string(),
            yandex_sync_remote_folder: "BigEcho".to_string(),
```

Add the remote-folder sanitizer as a private helper just above `impl PublicSettings`:

```rust
fn sanitized_remote_folder(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('/').trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("..") || trimmed.contains('\\') {
        return None;
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(trimmed.to_string())
}
```

Inside `impl PublicSettings::validate()`, at the very top of the function body, add:

```rust
        const YANDEX_INTERVALS: &[&str] = &["1h", "6h", "24h", "48h"];
        if !YANDEX_INTERVALS.contains(&self.yandex_sync_interval.as_str()) {
            return Err("Invalid Yandex sync interval".to_string());
        }
        if sanitized_remote_folder(&self.yandex_sync_remote_folder).is_none() {
            return Err("Invalid Yandex remote folder".to_string());
        }
```

- [ ] **Step 4: Run the new tests and verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::public_settings`
Expected: all settings tests pass (old + 7 new).

- [ ] **Step 5: Update the Rust test fixtures that construct `PublicSettings` literally**

At every line listed below, the test fixture is a `PublicSettings { ... }` literal that currently ends at `auto_delete_audio_days: 30,`. In each literal, add these three lines immediately after `auto_delete_audio_days: 30,`:

```rust
            yandex_sync_enabled: false,
            yandex_sync_interval: "24h".to_string(),
            yandex_sync_remote_folder: "BigEcho".to_string(),
```

Sites to update:

- `src-tauri/src/main.rs` — two literals at lines 827-854 and 882-909.
- `src-tauri/src/commands/sessions.rs` — one literal at line 1227.
- `src-tauri/src/services/pipeline_runner.rs` — one literal at line 401.
- `src-tauri/src/pipeline/mod.rs` — nine literals at lines 1302, 1375, 1476, 1608, 1712, 1833, 2001, 2069, 2120.

- [ ] **Step 6: Run the full Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (no compile errors from missing struct fields; all existing tests still green).

- [ ] **Step 7: Extend the TypeScript `PublicSettings` type and `SettingsTab`**

In `src/types/index.ts`, add the three fields at the bottom of the `PublicSettings` type:

```ts
  auto_delete_audio_enabled: boolean;
  auto_delete_audio_days: number;
  yandex_sync_enabled: boolean;
  yandex_sync_interval: "1h" | "6h" | "24h" | "48h";
  yandex_sync_remote_folder: string;
};
```

Change the `SettingsTab` type to include `"yandex"`:

```ts
export type SettingsTab = "audiototext" | "generals" | "audio" | "yandex";
```

- [ ] **Step 8: Update TypeScript test fixtures**

In each of the following files, every `PublicSettings`-shaped literal currently ends with `auto_delete_audio_days: 30,`. Add these lines immediately after that line (matching JSON key style used in that file):

```ts
        yandex_sync_enabled: false,
        yandex_sync_interval: "24h",
        yandex_sync_remote_folder: "BigEcho",
```

Sites to update:

- `src/App.main.test.tsx` at lines 49, 456, 663, 823, 950, 1047, 1149, 1262, 1451, 1536, 1600 (11 literals).
- `src/App.tray.test.tsx` at lines 72, 278, 317, 403 (4 literals).
- `src/App.settings.test.tsx` at lines 31, 133, 476 (3 literals).
- `src/hooks/useSettingsForm.test.tsx` at line 26 (1 literal).

- [ ] **Step 9: Run the frontend test suite**

Run: `npm test`
Expected: PASS for all existing suites.

- [ ] **Step 10: Commit**

```bash
git add -- \
  src-tauri/src/settings/public_settings.rs \
  src-tauri/src/main.rs \
  src-tauri/src/commands/sessions.rs \
  src-tauri/src/services/pipeline_runner.rs \
  src-tauri/src/pipeline/mod.rs \
  src/types/index.ts \
  src/App.main.test.tsx \
  src/App.tray.test.tsx \
  src/App.settings.test.tsx \
  src/hooks/useSettingsForm.test.tsx
git commit -m "feat(settings): add Yandex sync fields with defaults and validation"
```

---

## Task 2: `clear_secret` helper

**Files:**
- Modify: `src-tauri/src/settings/secret_store.rs`

- [ ] **Step 1: Write failing tests for `clear_secret`**

Append inside `src-tauri/src/settings/secret_store.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn clear_secret_removes_from_fallback_file() {
        let tmp = tempdir().expect("tempdir");
        set_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN", "abc123").expect("set");
        // Sanity: value is readable back
        let _ = get_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN");

        clear_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN").expect("clear");

        // After clear, the fallback no longer contains the key.
        let path = tmp.path().join(FALLBACK_FILE_NAME);
        if path.exists() {
            let map = load_fallback_map(&path).expect("load fallback");
            assert!(!map.contains_key("YANDEX_DISK_OAUTH_TOKEN"));
        }
    }

    #[test]
    fn clear_secret_is_idempotent_when_not_set() {
        let tmp = tempdir().expect("tempdir");
        clear_secret(tmp.path(), "NON_EXISTENT_KEY").expect("first clear");
        clear_secret(tmp.path(), "NON_EXISTENT_KEY").expect("second clear");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::secret_store::tests::clear`
Expected: compile error — `clear_secret` is not defined.

- [ ] **Step 3: Implement `clear_secret`**

Append to `src-tauri/src/settings/secret_store.rs` (just after `pub fn get_secret`):

```rust
pub fn clear_secret(app_data_dir: &Path, name: &str) -> Result<(), String> {
    // Remove from the OS keyring. Treat "no entry" as success.
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, name) {
        match entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(err) => eprintln!("warning: failed to delete keyring secret {name}: {err}"),
        }
    }

    // Remove from the fallback file.
    let path = fallback_path(app_data_dir);
    if path.exists() {
        let mut map = load_fallback_map(&path)?;
        if map.remove(name).is_some() {
            save_fallback_map(&path, &map)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::secret_store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings/secret_store.rs
git commit -m "feat(settings): add clear_secret helper for removing stored keys"
```

---

## Task 3: AppState runtime state + Cargo deps

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/src/services/yandex_disk/mod.rs`
- Create: `src-tauri/src/services/yandex_disk/state.rs`

- [ ] **Step 1: Add dependencies to `src-tauri/Cargo.toml`**

Add to the `[dependencies]` section (alphabetical placement near existing entries):

```toml
async-trait = "0.1"
tokio-util = { version = "0.7", features = ["io"] }
```

Add to the `[dev-dependencies]` section:

```toml
wiremock = "0.6"
```

- [ ] **Step 2: Create the module scaffolding**

Create `src-tauri/src/services/yandex_disk/mod.rs`:

```rust
pub mod state;
```

Create `src-tauri/src/services/yandex_disk/state.rs`:

```rust
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LastRunSummary {
    pub started_at_iso: String,
    pub finished_at_iso: String,
    pub duration_ms: u64,
    pub uploaded: u32,
    pub skipped: u32,
    pub failed: u32,
    pub errors: Vec<FileError>,
}

#[derive(Debug, Default)]
pub struct YandexSyncRuntimeState {
    pub is_running: bool,
    pub last_run: Option<LastRunSummary>,
}

pub type SharedYandexSyncState = Arc<Mutex<YandexSyncRuntimeState>>;

pub fn new_shared_state() -> SharedYandexSyncState {
    Arc::new(Mutex::new(YandexSyncRuntimeState::default()))
}

#[derive(Debug, Clone, Serialize)]
pub struct YandexSyncStatus {
    pub is_running: bool,
    pub last_run: Option<LastRunSummary>,
}

impl YandexSyncStatus {
    pub fn snapshot(state: &SharedYandexSyncState) -> Self {
        let guard = state.lock().expect("yandex_sync state lock");
        Self {
            is_running: guard.is_running,
            last_run: guard.last_run.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_runtime_state_is_idle_with_no_last_run() {
        let s = YandexSyncRuntimeState::default();
        assert!(!s.is_running);
        assert!(s.last_run.is_none());
    }

    #[test]
    fn snapshot_reflects_current_state() {
        let shared = new_shared_state();
        {
            let mut g = shared.lock().unwrap();
            g.is_running = true;
            g.last_run = Some(LastRunSummary {
                started_at_iso: "2026-04-24T10:00:00+00:00".into(),
                finished_at_iso: "2026-04-24T10:00:10+00:00".into(),
                duration_ms: 10_000,
                uploaded: 2,
                skipped: 3,
                failed: 0,
                errors: vec![],
            });
        }
        let snap = YandexSyncStatus::snapshot(&shared);
        assert!(snap.is_running);
        assert_eq!(snap.last_run.unwrap().uploaded, 2);
    }
}
```

- [ ] **Step 3: Re-export from `services/mod.rs`**

In `src-tauri/src/services/mod.rs`, add:

```rust
pub mod pipeline_runner;
pub mod yandex_disk;
```

(Keep the existing `pub mod pipeline_runner;` line; append the new one after it.)

- [ ] **Step 4: Add the field to `AppState`**

In `src-tauri/src/app_state.rs`:

Update the top-of-file imports (replace the existing `use std::sync::Mutex;` line with):

```rust
use crate::services::yandex_disk::state::{new_shared_state, SharedYandexSyncState};
use std::sync::Mutex;
```

Add the field inside `pub struct AppState`:

```rust
pub yandex_sync: SharedYandexSyncState,
```

Add the field initialization inside `impl Default for AppState::default()`, next to the others:

```rust
yandex_sync: new_shared_state(),
```

- [ ] **Step 5: Run the test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (new dep compiles cleanly, module tests pass, nothing else regresses).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock \
        src-tauri/src/services/mod.rs \
        src-tauri/src/services/yandex_disk \
        src-tauri/src/app_state.rs
git commit -m "feat(yandex-disk): add runtime state types and AppState wiring"
```

---

## Task 4: Yandex.Disk HTTP client

**Files:**
- Create: `src-tauri/src/services/yandex_disk/client.rs`
- Modify: `src-tauri/src/services/yandex_disk/mod.rs`

This task builds the `YandexDiskApi` trait and a real HTTP impl. All tests drive against a `wiremock` server.

- [ ] **Step 1: Add the module and skeleton (no behavior yet)**

In `src-tauri/src/services/yandex_disk/mod.rs`:

```rust
pub mod client;
pub mod state;
```

Create `src-tauri/src/services/yandex_disk/client.rs`:

```rust
use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

const DEFAULT_BASE: &str = "https://cloud-api.yandex.net/v1/disk";
const LIST_PAGE_SIZE: u32 = 1000;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum YandexError {
    #[error("network error: {0}")]
    Network(String),
    #[error("http error: {status} — {body}")]
    Http { status: u16, body: String },
    #[error("unauthorized")]
    Unauthorized,
    #[error("parse error: {0}")]
    Parse(String),
    #[error("io error: {0}")]
    Io(String),
}

#[async_trait]
pub trait YandexDiskApi: Send + Sync {
    async fn ensure_dir(&self, remote_path: &str) -> Result<(), YandexError>;
    async fn list_dir(&self, remote_path: &str) -> Result<HashMap<String, u64>, YandexError>;
    async fn upload_file(&self, remote_path: &str, local_path: &Path) -> Result<(), YandexError>;
}

pub struct HttpYandexDiskClient {
    base_url: String,
    token: String,
    http: Client,
}

impl HttpYandexDiskClient {
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_base(DEFAULT_BASE, token)
    }

    pub fn with_base(base: impl Into<String>, token: impl Into<String>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest client should build");
        Self {
            base_url: base.into().trim_end_matches('/').to_string(),
            token: token.into(),
            http,
        }
    }

    fn auth_header_value(&self) -> String {
        format!("OAuth {}", self.token)
    }
}

#[derive(Deserialize)]
struct UploadHrefResponse {
    href: String,
}

#[derive(Deserialize)]
struct ListItem {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Deserialize)]
struct EmbeddedField {
    items: Vec<ListItem>,
    #[serde(default)]
    total: Option<u32>,
}

#[derive(Deserialize)]
struct ListDirResponse {
    _embedded: EmbeddedField,
}

impl HttpYandexDiskClient {
    fn parent_paths(remote_path: &str) -> Vec<String> {
        // "disk:/A/B/C" → ["disk:/A", "disk:/A/B", "disk:/A/B/C"]
        let Some(stripped) = remote_path.strip_prefix("disk:/") else {
            return vec![remote_path.to_string()];
        };
        let trimmed = stripped.trim_matches('/');
        if trimmed.is_empty() {
            return vec![];
        }
        let mut out = Vec::new();
        let mut current = String::from("disk:/");
        for part in trimmed.split('/') {
            if !current.ends_with('/') {
                current.push('/');
            }
            current.push_str(part);
            out.push(current.clone());
        }
        out
    }
}

#[async_trait]
impl YandexDiskApi for HttpYandexDiskClient {
    async fn ensure_dir(&self, remote_path: &str) -> Result<(), YandexError> {
        for path in Self::parent_paths(remote_path) {
            let url = format!("{}/resources?path={}", self.base_url, urlencoding::encode(&path));
            let res = self
                .http
                .put(&url)
                .header("Authorization", self.auth_header_value())
                .send()
                .await
                .map_err(|e| YandexError::Network(e.to_string()))?;
            match res.status().as_u16() {
                200 | 201 | 409 => continue,
                401 | 403 => return Err(YandexError::Unauthorized),
                status => {
                    let body = res.text().await.unwrap_or_default();
                    return Err(YandexError::Http { status, body });
                }
            }
        }
        Ok(())
    }

    async fn list_dir(&self, remote_path: &str) -> Result<HashMap<String, u64>, YandexError> {
        let mut files: HashMap<String, u64> = HashMap::new();
        let mut offset: u32 = 0;
        loop {
            let url = format!(
                "{}/resources?path={}&limit={}&offset={}&fields={}",
                self.base_url,
                urlencoding::encode(remote_path),
                LIST_PAGE_SIZE,
                offset,
                urlencoding::encode("_embedded.items.name,_embedded.items.size,_embedded.items.type,_embedded.total")
            );
            let res = self
                .http
                .get(&url)
                .header("Authorization", self.auth_header_value())
                .send()
                .await
                .map_err(|e| YandexError::Network(e.to_string()))?;
            match res.status().as_u16() {
                200 => {}
                404 => return Ok(HashMap::new()),
                401 | 403 => return Err(YandexError::Unauthorized),
                status => {
                    let body = res.text().await.unwrap_or_default();
                    return Err(YandexError::Http { status, body });
                }
            }
            let parsed: ListDirResponse = res
                .json()
                .await
                .map_err(|e| YandexError::Parse(e.to_string()))?;
            let page_len = parsed._embedded.items.len() as u32;
            for item in parsed._embedded.items {
                if item.kind == "file" {
                    files.insert(item.name, item.size.unwrap_or(0));
                }
            }
            let total = parsed._embedded.total.unwrap_or(offset + page_len);
            offset += page_len;
            if page_len == 0 || offset >= total {
                break;
            }
        }
        Ok(files)
    }

    async fn upload_file(&self, remote_path: &str, local_path: &Path) -> Result<(), YandexError> {
        let get_href_url = format!(
            "{}/resources/upload?path={}&overwrite=false",
            self.base_url,
            urlencoding::encode(remote_path)
        );
        let href_res = self
            .http
            .get(&get_href_url)
            .header("Authorization", self.auth_header_value())
            .send()
            .await
            .map_err(|e| YandexError::Network(e.to_string()))?;
        match href_res.status().as_u16() {
            200 => {}
            401 | 403 => return Err(YandexError::Unauthorized),
            409 => return Ok(()),
            status => {
                let body = href_res.text().await.unwrap_or_default();
                return Err(YandexError::Http { status, body });
            }
        }
        let href: UploadHrefResponse = href_res
            .json()
            .await
            .map_err(|e| YandexError::Parse(e.to_string()))?;

        let file = File::open(local_path)
            .await
            .map_err(|e| YandexError::Io(e.to_string()))?;
        let size = file
            .metadata()
            .await
            .map_err(|e| YandexError::Io(e.to_string()))?
            .len();
        let stream = ReaderStream::new(file);
        let body = reqwest::Body::wrap_stream(stream);

        let put_res = self
            .http
            .put(&href.href)
            .header("Content-Length", size)
            .body(body)
            .send()
            .await
            .map_err(|e| YandexError::Network(e.to_string()))?;
        match put_res.status().as_u16() {
            200 | 201 | 202 | 409 => Ok(()),
            401 | 403 => Err(YandexError::Unauthorized),
            status => {
                let body = put_res.text().await.unwrap_or_default();
                Err(YandexError::Http { status, body })
            }
        }
    }
}
```

Add `urlencoding = "2"` to `[dependencies]` in `src-tauri/Cargo.toml` (it is a tiny, single-file crate; the alternative is implementing percent-encoding by hand).

- [ ] **Step 2: Write failing tests against `wiremock`**

Create `src-tauri/src/services/yandex_disk/client.rs` tests at the bottom of the file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client_for(server: &MockServer) -> HttpYandexDiskClient {
        HttpYandexDiskClient::with_base(&server.uri(), "test-token")
    }

    #[tokio::test]
    async fn auth_header_is_oauth_prefixed() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/resources"))
            .and(query_param("path", "disk:/BigEcho"))
            .and(wiremock::matchers::header("Authorization", "OAuth test-token"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        client_for(&server).ensure_dir("disk:/BigEcho").await.expect("ok");
    }

    #[tokio::test]
    async fn ensure_dir_treats_409_as_success() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/resources"))
            .respond_with(ResponseTemplate::new(409))
            .expect(1)
            .mount(&server)
            .await;
        client_for(&server).ensure_dir("disk:/BigEcho").await.expect("409 is ok");
    }

    #[tokio::test]
    async fn ensure_dir_creates_missing_parents_recursively() {
        let server = MockServer::start().await;
        Mock::given(method("PUT")).and(query_param("path", "disk:/BigEcho"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(query_param("path", "disk:/BigEcho/A"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(query_param("path", "disk:/BigEcho/A/B"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        client_for(&server).ensure_dir("disk:/BigEcho/A/B").await.expect("ok");
    }

    #[tokio::test]
    async fn list_dir_parses_files_only() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "_embedded": {
                "items": [
                    {"name": "audio.opus", "type": "file", "size": 100_000},
                    {"name": "subdir", "type": "dir"},
                    {"name": "transcript.md", "type": "file", "size": 1_234}
                ],
                "total": 3
            }
        });
        Mock::given(method("GET")).and(path("/resources"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;
        let got = client_for(&server).list_dir("disk:/BigEcho").await.expect("ok");
        assert_eq!(got.len(), 2);
        assert_eq!(got["audio.opus"], 100_000);
        assert_eq!(got["transcript.md"], 1_234);
    }

    #[tokio::test]
    async fn list_dir_returns_empty_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/resources"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        let got = client_for(&server).list_dir("disk:/missing").await.expect("ok");
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn list_dir_pages_through_large_directories() {
        let server = MockServer::start().await;
        let total = 1500_u32;
        let first_page = serde_json::json!({
            "_embedded": {
                "items": (0..1000).map(|i| serde_json::json!({
                    "name": format!("f{i}.opus"), "type": "file", "size": i as u64
                })).collect::<Vec<_>>(),
                "total": total
            }
        });
        let second_page = serde_json::json!({
            "_embedded": {
                "items": (1000..1500).map(|i| serde_json::json!({
                    "name": format!("f{i}.opus"), "type": "file", "size": i as u64
                })).collect::<Vec<_>>(),
                "total": total
            }
        });
        Mock::given(method("GET")).and(path("/resources")).and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(first_page))
            .expect(1)
            .mount(&server).await;
        Mock::given(method("GET")).and(path("/resources")).and(query_param("offset", "1000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(second_page))
            .expect(1)
            .mount(&server).await;

        let got = client_for(&server).list_dir("disk:/BigEcho").await.expect("ok");
        assert_eq!(got.len(), 1500);
        assert_eq!(got["f0.opus"], 0);
        assert_eq!(got["f1499.opus"], 1499);
    }

    #[tokio::test]
    async fn upload_file_requests_href_then_puts_body() {
        let server = MockServer::start().await;
        let tmp = tempdir().expect("tempdir");
        let local = tmp.path().join("hello.txt");
        std::fs::File::create(&local).unwrap().write_all(b"payload").unwrap();

        let href = format!("{}/upload/target", server.uri());
        Mock::given(method("GET")).and(path("/resources/upload"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "href": href }))
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(path("/upload/target"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;

        client_for(&server)
            .upload_file("disk:/BigEcho/hello.txt", &local)
            .await
            .expect("upload ok");
    }

    #[tokio::test]
    async fn upload_file_treats_409_on_href_as_success() {
        let server = MockServer::start().await;
        let tmp = tempdir().expect("tempdir");
        let local = tmp.path().join("hello.txt");
        std::fs::File::create(&local).unwrap().write_all(b"x").unwrap();

        Mock::given(method("GET")).and(path("/resources/upload"))
            .respond_with(ResponseTemplate::new(409))
            .expect(1)
            .mount(&server)
            .await;

        client_for(&server)
            .upload_file("disk:/BigEcho/hello.txt", &local)
            .await
            .expect("409 href is ok");
    }

    #[tokio::test]
    async fn unauthorized_status_maps_to_unauthorized_error() {
        let server = MockServer::start().await;
        Mock::given(method("PUT")).and(path("/resources"))
            .respond_with(ResponseTemplate::new(401))
            .expect(1)
            .mount(&server)
            .await;
        let err = client_for(&server)
            .ensure_dir("disk:/BigEcho")
            .await
            .expect_err("must fail");
        assert_eq!(err, YandexError::Unauthorized);
    }
}
```

- [ ] **Step 3: Run tests and verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::yandex_disk::client`
Expected: PASS (all 8 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock \
        src-tauri/src/services/yandex_disk/mod.rs \
        src-tauri/src/services/yandex_disk/client.rs
git commit -m "feat(yandex-disk): HTTP client with ensure_dir / list_dir / upload_file"
```

---

## Task 5: `sync_runner` — the one-pass algorithm

**Files:**
- Create: `src-tauri/src/services/yandex_disk/sync_runner.rs`
- Modify: `src-tauri/src/services/yandex_disk/mod.rs`

- [ ] **Step 1: Declare module**

In `src-tauri/src/services/yandex_disk/mod.rs`, append:

```rust
pub mod sync_runner;
```

- [ ] **Step 2: Write failing tests for `sync_runner`**

Create `src-tauri/src/services/yandex_disk/sync_runner.rs`:

```rust
use crate::services::yandex_disk::client::{YandexDiskApi, YandexError};
use crate::services::yandex_disk::state::{FileError, LastRunSummary};
use async_trait::async_trait;
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MAX_ERRORS_REPORTED: usize = 20;

pub struct SyncParams {
    pub token: String,
    pub local_root: PathBuf,
    pub remote_folder: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncProgress {
    Started { total: u32 },
    Item { current: u32, total: u32, rel_path: String },
    Finished(LastRunSummary),
}

struct LocalFile {
    rel_path: String, // POSIX, forward-slash separated
    abs_path: PathBuf,
    size: u64,
}

fn collect_local_files(root: &Path) -> std::io::Result<Vec<LocalFile>> {
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let p = entry.path();
            if kind.is_dir() {
                stack.push(p);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let size = entry.metadata()?.len();
            let rel = p.strip_prefix(root).unwrap_or(&p).to_path_buf();
            let rel_posix = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            out.push(LocalFile {
                rel_path: rel_posix,
                abs_path: p,
                size,
            });
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

fn parent_rel_dir(rel_path: &str) -> &str {
    match rel_path.rfind('/') {
        Some(i) => &rel_path[..i],
        None => "",
    }
}

fn remote_dir_for(remote_folder: &str, rel_dir: &str) -> String {
    if rel_dir.is_empty() {
        format!("disk:/{}", remote_folder.trim_matches('/'))
    } else {
        format!("disk:/{}/{}", remote_folder.trim_matches('/'), rel_dir)
    }
}

pub async fn run(
    params: &SyncParams,
    api: Arc<dyn YandexDiskApi>,
    progress: &(dyn Fn(SyncProgress) + Send + Sync),
) -> LastRunSummary {
    let started_at = Utc::now();
    let started_iso = started_at.to_rfc3339();
    let mut uploaded = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;
    let mut errors: Vec<FileError> = Vec::new();

    let files = match collect_local_files(&params.local_root) {
        Ok(v) => v,
        Err(err) => {
            let finished = Utc::now();
            let summary = LastRunSummary {
                started_at_iso: started_iso,
                finished_at_iso: finished.to_rfc3339(),
                duration_ms: (finished - started_at).num_milliseconds().max(0) as u64,
                uploaded: 0,
                skipped: 0,
                failed: 1,
                errors: vec![FileError {
                    path: params.local_root.to_string_lossy().to_string(),
                    message: format!("cannot read local root: {err}"),
                }],
            };
            progress(SyncProgress::Finished(summary.clone()));
            return summary;
        }
    };
    let total = files.len() as u32;
    progress(SyncProgress::Started { total });

    if let Err(err) = api
        .ensure_dir(&remote_dir_for(&params.remote_folder, ""))
        .await
    {
        let finished = Utc::now();
        let summary = LastRunSummary {
            started_at_iso: started_iso,
            finished_at_iso: finished.to_rfc3339(),
            duration_ms: (finished - started_at).num_milliseconds().max(0) as u64,
            uploaded: 0,
            skipped: 0,
            failed: total.max(1),
            errors: vec![FileError {
                path: params.remote_folder.clone(),
                message: format!("ensure root dir: {err}"),
            }],
        };
        progress(SyncProgress::Finished(summary.clone()));
        return summary;
    }

    let mut listing_cache: HashMap<String, HashMap<String, u64>> = HashMap::new();
    let mut created_dirs: HashSet<String> = HashSet::new();

    for (idx, lf) in files.iter().enumerate() {
        let rel_dir = parent_rel_dir(&lf.rel_path);
        let remote_dir = remote_dir_for(&params.remote_folder, rel_dir);
        let current = (idx + 1) as u32;
        progress(SyncProgress::Item {
            current,
            total,
            rel_path: lf.rel_path.clone(),
        });

        if !created_dirs.contains(&remote_dir) {
            if let Err(err) = api.ensure_dir(&remote_dir).await {
                failed += 1;
                push_error(&mut errors, &lf.rel_path, format!("ensure_dir: {err}"));
                continue;
            }
            created_dirs.insert(remote_dir.clone());
        }

        let remote_map = if let Some(m) = listing_cache.get(&remote_dir) {
            m
        } else {
            match api.list_dir(&remote_dir).await {
                Ok(m) => {
                    listing_cache.insert(remote_dir.clone(), m);
                    listing_cache.get(&remote_dir).unwrap()
                }
                Err(err) => {
                    failed += 1;
                    push_error(&mut errors, &lf.rel_path, format!("list_dir: {err}"));
                    continue;
                }
            }
        };

        let name = lf.rel_path.rsplit('/').next().unwrap_or(&lf.rel_path);
        if remote_map.get(name).copied() == Some(lf.size) {
            skipped += 1;
            continue;
        }

        let remote_path = format!("{}/{}", remote_dir, name);
        match api.upload_file(&remote_path, &lf.abs_path).await {
            Ok(()) => uploaded += 1,
            Err(err) => {
                failed += 1;
                push_error(&mut errors, &lf.rel_path, err.to_string());
            }
        }
    }

    let finished = Utc::now();
    let summary = LastRunSummary {
        started_at_iso: started_iso,
        finished_at_iso: finished.to_rfc3339(),
        duration_ms: (finished - started_at).num_milliseconds().max(0) as u64,
        uploaded,
        skipped,
        failed,
        errors,
    };
    progress(SyncProgress::Finished(summary.clone()));
    summary
}

fn push_error(errors: &mut Vec<FileError>, path: &str, message: String) {
    if errors.len() < MAX_ERRORS_REPORTED {
        errors.push(FileError {
            path: path.to_string(),
            message,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    #[derive(Default)]
    struct FakeApiState {
        dirs: HashSet<String>,
        files: HashMap<String, u64>, // key: full remote path, e.g. "disk:/BigEcho/a/b.opus"
        upload_failures: HashSet<String>, // remote paths that should fail
    }

    struct FakeApi {
        inner: Mutex<FakeApiState>,
    }

    impl FakeApi {
        fn new() -> Self {
            Self { inner: Mutex::new(FakeApiState::default()) }
        }
        fn preload_file(&self, remote_path: &str, size: u64) {
            let mut g = self.inner.lock().unwrap();
            g.files.insert(remote_path.to_string(), size);
        }
        fn fail_upload_for(&self, remote_path: &str) {
            let mut g = self.inner.lock().unwrap();
            g.upload_failures.insert(remote_path.to_string());
        }
        fn upload_count(&self) -> usize {
            let g = self.inner.lock().unwrap();
            g.files.len()
        }
    }

    #[async_trait]
    impl YandexDiskApi for FakeApi {
        async fn ensure_dir(&self, remote_path: &str) -> Result<(), YandexError> {
            self.inner.lock().unwrap().dirs.insert(remote_path.to_string());
            Ok(())
        }
        async fn list_dir(&self, remote_path: &str) -> Result<HashMap<String, u64>, YandexError> {
            let g = self.inner.lock().unwrap();
            let prefix = format!("{}/", remote_path);
            let mut out = HashMap::new();
            for (k, v) in &g.files {
                if let Some(stripped) = k.strip_prefix(&prefix) {
                    if !stripped.contains('/') {
                        out.insert(stripped.to_string(), *v);
                    }
                }
            }
            Ok(out)
        }
        async fn upload_file(&self, remote_path: &str, local_path: &Path) -> Result<(), YandexError> {
            let mut g = self.inner.lock().unwrap();
            if g.upload_failures.contains(remote_path) {
                return Err(YandexError::Network("simulated".into()));
            }
            let size = std::fs::metadata(local_path).unwrap().len();
            g.files.insert(remote_path.to_string(), size);
            Ok(())
        }
    }

    fn write_file(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, bytes).unwrap();
    }

    fn record_progress() -> (Arc<Mutex<Vec<SyncProgress>>>, impl Fn(SyncProgress) + Send + Sync) {
        let events = Arc::new(Mutex::new(Vec::<SyncProgress>::new()));
        let recorder = events.clone();
        let emit = move |p: SyncProgress| recorder.lock().unwrap().push(p);
        (events, emit)
    }

    fn params(root: &Path) -> SyncParams {
        SyncParams {
            token: "t".into(),
            local_root: root.to_path_buf(),
            remote_folder: "BigEcho".into(),
        }
    }

    #[tokio::test]
    async fn empty_local_root_produces_zero_counters() {
        let tmp = tempdir().unwrap();
        let api: Arc<dyn YandexDiskApi> = Arc::new(FakeApi::new());
        let (events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api, &emit).await;
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.failed, 0);
        let events = events.lock().unwrap();
        assert!(matches!(events[0], SyncProgress::Started { total: 0 }));
        assert!(matches!(events.last(), Some(SyncProgress::Finished(_))));
    }

    #[tokio::test]
    async fn uploads_file_when_absent_on_remote() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "10.04.2026/meeting_15-06-07/audio.opus", b"hello");
        let api = Arc::new(FakeApi::new());
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.uploaded, 1);
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.failed, 0);
        assert_eq!(api.upload_count(), 1);
    }

    #[tokio::test]
    async fn skips_file_when_remote_size_matches() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "10.04.2026/meeting_15-06-07/audio.opus", b"hello");
        let api = Arc::new(FakeApi::new());
        api.preload_file("disk:/BigEcho/10.04.2026/meeting_15-06-07/audio.opus", 5);
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.skipped, 1);
    }

    #[tokio::test]
    async fn uploads_file_when_remote_size_differs() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "10.04.2026/audio.opus", b"hello");
        let api = Arc::new(FakeApi::new());
        api.preload_file("disk:/BigEcho/10.04.2026/audio.opus", 999);
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_events, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.uploaded, 1);
        assert_eq!(summary.skipped, 0);
    }

    #[tokio::test]
    async fn creates_missing_remote_directories_in_order() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "A/B/C/file.opus", b"x");
        let api = Arc::new(FakeApi::new());
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_e, emit) = record_progress();
        let _ = run(&params(tmp.path()), api_dyn, &emit).await;
        let dirs = api.inner.lock().unwrap().dirs.clone();
        assert!(dirs.contains("disk:/BigEcho"));
        assert!(dirs.contains("disk:/BigEcho/A/B/C"));
    }

    #[tokio::test]
    async fn continues_after_single_file_failure() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "a.opus", b"ok");
        write_file(tmp.path(), "b.opus", b"boom");
        let api = Arc::new(FakeApi::new());
        api.fail_upload_for("disk:/BigEcho/b.opus");
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_e, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.uploaded, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.errors.len(), 1);
        assert_eq!(summary.errors[0].path, "b.opus");
    }

    #[tokio::test]
    async fn caps_error_list_at_twenty_entries() {
        let tmp = tempdir().unwrap();
        let api = Arc::new(FakeApi::new());
        for i in 0..25 {
            let name = format!("f{i}.opus");
            write_file(tmp.path(), &name, b"x");
            api.fail_upload_for(&format!("disk:/BigEcho/{name}"));
        }
        let api_dyn: Arc<dyn YandexDiskApi> = api.clone();
        let (_e, emit) = record_progress();
        let summary = run(&params(tmp.path()), api_dyn, &emit).await;
        assert_eq!(summary.failed, 25);
        assert_eq!(summary.errors.len(), MAX_ERRORS_REPORTED);
    }

    #[tokio::test]
    async fn emits_progress_events_in_order() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "a.opus", b"aa");
        write_file(tmp.path(), "b.opus", b"bb");
        let api: Arc<dyn YandexDiskApi> = Arc::new(FakeApi::new());
        let (events, emit) = record_progress();
        let _ = run(&params(tmp.path()), api, &emit).await;
        let evs = events.lock().unwrap();
        assert!(matches!(evs[0], SyncProgress::Started { total: 2 }));
        match &evs[1] {
            SyncProgress::Item { current, total, rel_path } => {
                assert_eq!(*current, 1);
                assert_eq!(*total, 2);
                assert_eq!(rel_path, "a.opus");
            }
            other => panic!("expected Item, got {:?}", other),
        }
        match &evs[2] {
            SyncProgress::Item { current, total, rel_path } => {
                assert_eq!(*current, 2);
                assert_eq!(*total, 2);
                assert_eq!(rel_path, "b.opus");
            }
            other => panic!("expected Item, got {:?}", other),
        }
        assert!(matches!(evs.last(), Some(SyncProgress::Finished(_))));
    }
}
```

- [ ] **Step 3: Run tests and verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::yandex_disk::sync_runner`
Expected: PASS (all 8 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/services/yandex_disk/mod.rs \
        src-tauri/src/services/yandex_disk/sync_runner.rs
git commit -m "feat(yandex-disk): one-pass sync runner with progress events"
```

---

## Task 6: Tauri commands + registration

**Files:**
- Create: `src-tauri/src/commands/yandex_sync.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs` (imports, both `generate_handler!` blocks)

- [ ] **Step 1: Add the module**

In `src-tauri/src/commands/mod.rs`, append:

```rust
pub mod yandex_sync;
```

- [ ] **Step 2: Write the commands**

Create `src-tauri/src/commands/yandex_sync.rs`:

```rust
use crate::app_state::{AppDirs, AppState};
use crate::services::yandex_disk::client::HttpYandexDiskClient;
use crate::services::yandex_disk::state::{LastRunSummary, YandexSyncStatus};
use crate::services::yandex_disk::sync_runner::{run, SyncParams, SyncProgress};
use crate::settings::public_settings::load_settings;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

const TOKEN_KEY: &str = "YANDEX_DISK_OAUTH_TOKEN";
const PROGRESS_EVENT: &str = "yandex-sync-progress";
const FINISHED_EVENT: &str = "yandex-sync-finished";

fn resolved_local_root(app_data_dir: &std::path::Path, recording_root: &str) -> PathBuf {
    let p = PathBuf::from(recording_root);
    if p.is_absolute() {
        p
    } else {
        app_data_dir.join(p)
    }
}

#[tauri::command]
pub async fn yandex_sync_set_token(
    dirs: State<'_, AppDirs>,
    token: String,
) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token must not be empty".to_string());
    }
    set_secret(&dirs.app_data_dir, TOKEN_KEY, trimmed)
}

#[tauri::command]
pub async fn yandex_sync_clear_token(dirs: State<'_, AppDirs>) -> Result<(), String> {
    clear_secret(&dirs.app_data_dir, TOKEN_KEY)
}

#[tauri::command]
pub async fn yandex_sync_has_token(dirs: State<'_, AppDirs>) -> Result<bool, String> {
    match get_secret(&dirs.app_data_dir, TOKEN_KEY) {
        Ok(v) => Ok(!v.is_empty()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn yandex_sync_status(state: State<'_, AppState>) -> Result<YandexSyncStatus, String> {
    Ok(YandexSyncStatus::snapshot(&state.yandex_sync))
}

#[tauri::command]
pub async fn yandex_sync_now(
    app: AppHandle,
    dirs: State<'_, AppDirs>,
    state: State<'_, AppState>,
) -> Result<LastRunSummary, String> {
    {
        let mut g = state
            .yandex_sync
            .lock()
            .map_err(|_| "yandex_sync state poisoned".to_string())?;
        if g.is_running {
            return Err("Yandex sync already running".to_string());
        }
        g.is_running = true;
    }

    let result = do_run(&app, &dirs.app_data_dir).await;

    let mut g = state
        .yandex_sync
        .lock()
        .map_err(|_| "yandex_sync state poisoned".to_string())?;
    g.is_running = false;
    match result {
        Ok(summary) => {
            g.last_run = Some(summary.clone());
            Ok(summary)
        }
        Err(err) => Err(err),
    }
}

async fn do_run(app: &AppHandle, app_data_dir: &std::path::Path) -> Result<LastRunSummary, String> {
    let settings = load_settings(app_data_dir)?;
    let token = get_secret(app_data_dir, TOKEN_KEY)
        .map_err(|_| "Yandex.Disk token is not set".to_string())?;
    if token.trim().is_empty() {
        return Err("Yandex.Disk token is not set".to_string());
    }
    let params = SyncParams {
        token: token.clone(),
        local_root: resolved_local_root(app_data_dir, &settings.recording_root),
        remote_folder: settings.yandex_sync_remote_folder.clone(),
    };

    let api: std::sync::Arc<dyn crate::services::yandex_disk::client::YandexDiskApi> =
        Arc::new(HttpYandexDiskClient::new(token));

    let app_for_progress = app.clone();
    let emit = move |p: SyncProgress| match p {
        SyncProgress::Item { current, total, rel_path } => {
            let payload = serde_json::json!({
                "current": current, "total": total, "rel_path": rel_path
            });
            let _ = app_for_progress.emit(PROGRESS_EVENT, payload);
        }
        SyncProgress::Finished(summary) => {
            let _ = app_for_progress.emit(FINISHED_EVENT, &summary);
        }
        SyncProgress::Started { .. } => {}
    };

    let summary = run(&params, api, &emit).await;
    Ok(summary)
}
```

- [ ] **Step 3: Register commands in `src-tauri/src/main.rs`**

Add imports near the other `commands::` uses (top of file, in alphabetical block):

```rust
use commands::yandex_sync::{
    yandex_sync_clear_token, yandex_sync_has_token, yandex_sync_now, yandex_sync_set_token,
    yandex_sync_status,
};
```

Add the five commands inside the production `tauri::generate_handler![ ... ]` block (line ~437 area, after `open_external_url`):

```rust
            open_external_url,
            yandex_sync_set_token,
            yandex_sync_clear_token,
            yandex_sync_has_token,
            yandex_sync_status,
            yandex_sync_now
```

Add the same five to the test-only `generate_handler!` block in `build_test_app` (line ~633, after `sync_sessions`):

```rust
                sync_sessions,
                yandex_sync_set_token,
                yandex_sync_clear_token,
                yandex_sync_has_token,
                yandex_sync_status,
                yandex_sync_now
```

- [ ] **Step 4: Add a Tauri IPC test for the already-running guard**

Append to `src-tauri/src/main.rs` inside the `mod ipc_runtime_tests` block:

```rust
    #[test]
    fn invoke_yandex_sync_now_errors_when_already_running() {
        let (app, _dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        {
            let state = app.state::<AppState>();
            let mut g = state.yandex_sync.lock().expect("yandex_sync lock");
            g.is_running = true;
        }
        let response =
            get_ipc_response(&webview, invoke_request("yandex_sync_now", serde_json::json!({})));
        let err = response.expect_err("should fail");
        assert_eq!(extract_err_string(err), "Yandex sync already running");
    }

    #[test]
    fn invoke_yandex_sync_status_returns_current_snapshot() {
        let (app, _dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let response = get_ipc_response(
            &webview,
            invoke_request("yandex_sync_status", serde_json::json!({})),
        )
        .expect("status must succeed");
        let value = extract_ok_json(response);
        assert_eq!(value["is_running"], serde_json::Value::Bool(false));
        assert!(value["last_run"].is_null());
    }

    #[test]
    fn invoke_yandex_sync_has_token_returns_false_when_unset() {
        let (app, _dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let response = get_ipc_response(
            &webview,
            invoke_request("yandex_sync_has_token", serde_json::json!({})),
        )
        .expect("has_token must succeed");
        let value = extract_ok_json(response);
        assert_eq!(value, serde_json::Value::Bool(false));
    }

    #[test]
    fn invoke_yandex_sync_set_then_has_token() {
        let (app, _dir) = build_test_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("webview should be created");
        let set = get_ipc_response(
            &webview,
            invoke_request("yandex_sync_set_token", serde_json::json!({ "token": "abc" })),
        );
        assert!(set.is_ok());
        let response = get_ipc_response(
            &webview,
            invoke_request("yandex_sync_has_token", serde_json::json!({})),
        )
        .expect("has_token must succeed");
        let value = extract_ok_json(response);
        assert_eq!(value, serde_json::Value::Bool(true));
    }
```

- [ ] **Step 5: Run the test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (all new and existing tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/mod.rs \
        src-tauri/src/commands/yandex_sync.rs \
        src-tauri/src/main.rs
git commit -m "feat(yandex-disk): Tauri commands and IPC registration"
```

---

## Task 7: Background scheduler

**Files:**
- Create: `src-tauri/src/services/yandex_disk/scheduler.rs`
- Modify: `src-tauri/src/services/yandex_disk/mod.rs`
- Modify: `src-tauri/src/main.rs` (spawn inside `setup(|app| ...)`)

- [ ] **Step 1: Declare module**

In `src-tauri/src/services/yandex_disk/mod.rs`, append:

```rust
pub mod scheduler;
```

- [ ] **Step 2: Write failing tests for `scheduler::decide_action`**

Create `src-tauri/src/services/yandex_disk/scheduler.rs` with just the decision helper and its tests first (keeping the actual loop minimal):

```rust
use crate::services::yandex_disk::state::SharedYandexSyncState;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum SchedulerAction {
    Trigger,
    Skip, // already running, disabled, or no token
    Stop, // shutdown requested
}

pub fn decide_action(
    enabled: bool,
    has_token: bool,
    state: &SharedYandexSyncState,
) -> SchedulerAction {
    if !enabled || !has_token {
        return SchedulerAction::Skip;
    }
    let guard = state.lock().expect("yandex_sync state lock");
    if guard.is_running {
        SchedulerAction::Skip
    } else {
        SchedulerAction::Trigger
    }
}

pub fn interval_to_duration(s: &str) -> Duration {
    match s {
        "1h" => Duration::from_secs(3600),
        "6h" => Duration::from_secs(6 * 3600),
        "48h" => Duration::from_secs(48 * 3600),
        _ => Duration::from_secs(24 * 3600),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::yandex_disk::state::new_shared_state;

    #[test]
    fn triggers_when_enabled_and_token_and_not_running() {
        let s = new_shared_state();
        assert_eq!(decide_action(true, true, &s), SchedulerAction::Trigger);
    }

    #[test]
    fn skips_when_disabled() {
        let s = new_shared_state();
        assert_eq!(decide_action(false, true, &s), SchedulerAction::Skip);
    }

    #[test]
    fn skips_when_no_token() {
        let s = new_shared_state();
        assert_eq!(decide_action(true, false, &s), SchedulerAction::Skip);
    }

    #[test]
    fn skips_when_already_running() {
        let s = new_shared_state();
        s.lock().unwrap().is_running = true;
        assert_eq!(decide_action(true, true, &s), SchedulerAction::Skip);
    }

    #[test]
    fn interval_parses_known_values() {
        assert_eq!(interval_to_duration("1h"), Duration::from_secs(3600));
        assert_eq!(interval_to_duration("6h"), Duration::from_secs(21600));
        assert_eq!(interval_to_duration("24h"), Duration::from_secs(86400));
        assert_eq!(interval_to_duration("48h"), Duration::from_secs(172800));
    }

    #[test]
    fn interval_unknown_falls_back_to_24h() {
        assert_eq!(interval_to_duration("garbage"), Duration::from_secs(86400));
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::yandex_disk::scheduler`
Expected: PASS (6 tests).

- [ ] **Step 4: Add the live loop and the setup wiring**

Extend `scheduler.rs` — append after `interval_to_duration`:

```rust
use crate::services::yandex_disk::client::HttpYandexDiskClient;
use crate::services::yandex_disk::sync_runner::{run, SyncParams, SyncProgress};
use crate::settings::public_settings::load_settings;
use crate::settings::secret_store::get_secret;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const TOKEN_KEY: &str = "YANDEX_DISK_OAUTH_TOKEN";

fn resolved_local_root(app_data_dir: &Path, recording_root: &str) -> PathBuf {
    let p = PathBuf::from(recording_root);
    if p.is_absolute() {
        p
    } else {
        app_data_dir.join(p)
    }
}

pub async fn run_loop(app: AppHandle) {
    let dirs = match app.state::<crate::app_state::AppDirs>().inner().clone() {
        v => v,
    };
    let shared = app.state::<crate::app_state::AppState>().yandex_sync.clone();

    // Startup tick.
    tick_once(&app, &dirs.app_data_dir, &shared).await;

    loop {
        let sleep_for = {
            let settings = load_settings(&dirs.app_data_dir).unwrap_or_default();
            interval_to_duration(&settings.yandex_sync_interval)
        };
        tokio::time::sleep(sleep_for).await;
        tick_once(&app, &dirs.app_data_dir, &shared).await;
    }
}

async fn tick_once(app: &AppHandle, app_data_dir: &Path, shared: &SharedYandexSyncState) {
    let settings = match load_settings(app_data_dir) {
        Ok(s) => s,
        Err(_) => return,
    };
    let token = match get_secret(app_data_dir, TOKEN_KEY) {
        Ok(t) if !t.trim().is_empty() => t,
        _ => return,
    };
    let action = decide_action(settings.yandex_sync_enabled, true, shared);
    if action != SchedulerAction::Trigger {
        return;
    }

    {
        let mut g = match shared.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.is_running {
            return;
        }
        g.is_running = true;
    }

    let params = SyncParams {
        token: token.clone(),
        local_root: resolved_local_root(app_data_dir, &settings.recording_root),
        remote_folder: settings.yandex_sync_remote_folder.clone(),
    };
    let api: Arc<dyn crate::services::yandex_disk::client::YandexDiskApi> =
        Arc::new(HttpYandexDiskClient::new(token));

    let app_for_progress = app.clone();
    let emit = move |p: SyncProgress| match p {
        SyncProgress::Item { current, total, rel_path } => {
            let payload = serde_json::json!({
                "current": current, "total": total, "rel_path": rel_path
            });
            let _ = app_for_progress.emit("yandex-sync-progress", payload);
        }
        SyncProgress::Finished(summary) => {
            let _ = app_for_progress.emit("yandex-sync-finished", &summary);
        }
        SyncProgress::Started { .. } => {}
    };

    let summary = run(&params, api, &emit).await;

    let mut g = match shared.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    g.is_running = false;
    g.last_run = Some(summary);
}
```

In `src-tauri/src/main.rs` setup closure, after `spawn_retry_worker(...)` (near line 296):

```rust
        tauri::async_runtime::spawn(services::yandex_disk::scheduler::run_loop(
            app.handle().clone(),
        ));
```

- [ ] **Step 5: Run the full Rust suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (no regressions; the live loop is spawned only in the binary, not in tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/services/yandex_disk/mod.rs \
        src-tauri/src/services/yandex_disk/scheduler.rs \
        src-tauri/src/main.rs
git commit -m "feat(yandex-disk): background scheduler with startup + interval ticks"
```

---

## Task 8: Frontend types, hook, and component

**Files:**
- Modify: `src/types/index.ts` (already partially done in Task 1 — add the extra types)
- Create: `src/hooks/useYandexSync.ts`
- Create: `src/components/settings/YandexSyncSettings.tsx`
- Modify: `src/pages/SettingsPage/index.tsx`

- [ ] **Step 1: Add the remaining TS types**

Append to `src/types/index.ts`:

```ts
export type YandexSyncFileError = { path: string; message: string };
export type YandexSyncLastRun = {
  started_at_iso: string;
  finished_at_iso: string;
  duration_ms: number;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: YandexSyncFileError[];
};
export type YandexSyncStatus = { is_running: boolean; last_run: YandexSyncLastRun | null };
export type YandexSyncProgress = { current: number; total: number; rel_path: string };
```

- [ ] **Step 2: Create the hook**

Create `src/hooks/useYandexSync.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { tauriInvoke } from "../lib/tauri";
import type {
  SecretSaveState,
  YandexSyncLastRun,
  YandexSyncProgress,
  YandexSyncStatus,
} from "../types";

const POLL_MS = 2000;
const PROGRESS_EVENT = "yandex-sync-progress";
const FINISHED_EVENT = "yandex-sync-finished";

export function useYandexSync(enabled: boolean) {
  const [hasToken, setHasToken] = useState<boolean>(false);
  const [tokenState, setTokenState] = useState<SecretSaveState>("unknown");
  const [status, setStatus] = useState<YandexSyncStatus>({ is_running: false, last_run: null });
  const [progress, setProgress] = useState<YandexSyncProgress | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshHasToken = useCallback(async () => {
    try {
      const has = await tauriInvoke<boolean>("yandex_sync_has_token");
      setHasToken(Boolean(has));
    } catch {
      setHasToken(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await tauriInvoke<YandexSyncStatus>("yandex_sync_status");
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const saveToken = useCallback(async (value: string) => {
    try {
      await tauriInvoke("yandex_sync_set_token", { token: value });
      setTokenState("updated");
      await refreshHasToken();
    } catch {
      setTokenState("error");
    }
  }, [refreshHasToken]);

  const clearToken = useCallback(async () => {
    try {
      await tauriInvoke("yandex_sync_clear_token");
      setTokenState("unchanged");
      await refreshHasToken();
    } catch {
      setTokenState("error");
    }
  }, [refreshHasToken]);

  const syncNow = useCallback(async (): Promise<YandexSyncLastRun | null> => {
    try {
      const summary = await tauriInvoke<YandexSyncLastRun>("yandex_sync_now");
      await refreshStatus();
      return summary;
    } catch {
      await refreshStatus();
      return null;
    }
  }, [refreshStatus]);

  useEffect(() => {
    if (!enabled) return;
    void refreshHasToken();
    void refreshStatus();
  }, [enabled, refreshHasToken, refreshStatus]);

  useEffect(() => {
    if (!enabled) return;
    const unlistenProgress = listen<YandexSyncProgress>(PROGRESS_EVENT, (e) => {
      setProgress(e.payload);
    });
    const unlistenFinished = listen<YandexSyncLastRun>(FINISHED_EVENT, (e) => {
      setProgress(null);
      setStatus({ is_running: false, last_run: e.payload });
    });
    return () => {
      void unlistenProgress.then((fn) => fn());
      void unlistenFinished.then((fn) => fn());
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (status.is_running) {
      pollTimer.current = setInterval(() => {
        void refreshStatus();
      }, POLL_MS);
      return () => {
        if (pollTimer.current) clearInterval(pollTimer.current);
        pollTimer.current = null;
      };
    }
    return;
  }, [enabled, status.is_running, refreshStatus]);

  return {
    hasToken,
    tokenState,
    status,
    progress,
    refreshHasToken,
    refreshStatus,
    saveToken,
    clearToken,
    syncNow,
  };
}
```

- [ ] **Step 3: Create the component**

Create `src/components/settings/YandexSyncSettings.tsx`:

```tsx
import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Flex,
  Form,
  Input,
  Progress,
  Select,
  Space,
  Tag,
} from "antd";
import { LinkOutlined } from "@ant-design/icons";
import type { PublicSettings } from "../../types";
import { tauriInvoke } from "../../lib/tauri";
import { useYandexSync } from "../../hooks/useYandexSync";

type Props = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  enabled: boolean;
};

const TOKEN_URL = "https://yandex.ru/dev/disk/poligon/";

const dirtyDot = (
  <span
    style={{
      display: "inline-block",
      width: 6,
      height: 6,
      borderRadius: "50%",
      backgroundColor: "var(--ant-color-warning, #faad14)",
      marginLeft: 4,
      verticalAlign: "middle",
    }}
    aria-hidden="true"
  />
);

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

export function YandexSyncSettings({ settings, setSettings, isDirty, enabled }: Props) {
  const y = useYandexSync(enabled);
  const [tokenInput, setTokenInput] = useState("");

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return;
    await y.saveToken(tokenInput.trim());
    setTokenInput("");
  };

  const openTokenPage = () => {
    void tauriInvoke("open_external_url", { url: TOKEN_URL });
  };

  const tokenBadge = y.hasToken ? (
    <Tag color="green">Saved</Tag>
  ) : (
    <Tag>Not set</Tag>
  );

  const canSyncNow = y.hasToken && !y.status.is_running;
  const fieldsDisabled = !settings.yandex_sync_enabled;

  return (
    <Form layout="vertical" style={{ maxWidth: 760 }}>
      <Form.Item>
        <Checkbox
          id="yandex_sync_enabled"
          aria-label="Enable Yandex.Disk sync"
          checked={Boolean(settings.yandex_sync_enabled)}
          onChange={(e) =>
            setSettings({ ...settings, yandex_sync_enabled: e.target.checked })
          }
        >
          Enable Yandex.Disk sync
          {isDirty("yandex_sync_enabled") && dirtyDot}
        </Checkbox>
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="yandex_sync_token">OAuth token</label>
        }
      >
        <Flex gap={8} align="center" wrap="wrap">
          <Input.Password
            id="yandex_sync_token"
            placeholder="OAuth token from oauth.yandex.ru"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{ flex: "1 1 260px" }}
          />
          <Button type="primary" onClick={() => void handleSaveToken()}>
            Save token
          </Button>
          {tokenBadge}
          <Button onClick={() => void y.clearToken()} disabled={!y.hasToken}>
            Clear
          </Button>
        </Flex>
        <Flex gap={8} align="center" style={{ marginTop: 8 }}>
          <Button
            icon={<LinkOutlined aria-hidden="true" />}
            onClick={openTokenPage}
          >
            Get token
          </Button>
          <span style={{ color: "#888" }}>
            Opens Yandex.Disk Polygon in your browser.
          </span>
        </Flex>
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="yandex_sync_remote_folder">
            Folder on Yandex.Disk (will be created if missing)
            {isDirty("yandex_sync_remote_folder") && dirtyDot}
          </label>
        }
      >
        <Input
          id="yandex_sync_remote_folder"
          value={settings.yandex_sync_remote_folder}
          onChange={(e) =>
            setSettings({ ...settings, yandex_sync_remote_folder: e.target.value })
          }
          disabled={fieldsDisabled}
        />
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="yandex_sync_interval">
            Sync interval
            {isDirty("yandex_sync_interval") && dirtyDot}
          </label>
        }
        help={`Runs on app startup and every ${settings.yandex_sync_interval} while the app is running.`}
      >
        <Select
          id="yandex_sync_interval"
          value={settings.yandex_sync_interval}
          disabled={fieldsDisabled}
          onChange={(value) =>
            setSettings({
              ...settings,
              yandex_sync_interval: value as PublicSettings["yandex_sync_interval"],
            })
          }
          options={[
            { value: "1h", label: "Every hour" },
            { value: "6h", label: "Every 6 hours" },
            { value: "24h", label: "Every 24 hours" },
            { value: "48h", label: "Every 48 hours" },
          ]}
        />
      </Form.Item>

      <Form.Item>
        <Button
          type="primary"
          onClick={() => void y.syncNow()}
          loading={y.status.is_running}
          disabled={!canSyncNow}
        >
          Sync now
        </Button>
      </Form.Item>

      {y.status.is_running && y.progress && (
        <div style={{ marginBottom: 12 }}>
          <div>
            Processing {y.progress.current} / {y.progress.total}: <code>{y.progress.rel_path}</code>
          </div>
          <Progress
            percent={
              y.progress.total > 0
                ? Math.round((y.progress.current * 100) / y.progress.total)
                : 0
            }
            size="small"
          />
        </div>
      )}

      {y.status.last_run && (
        <Alert
          type={y.status.last_run.failed > 0 ? "warning" : "success"}
          message={
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              <div>
                Last sync:{" "}
                {new Date(y.status.last_run.finished_at_iso).toLocaleString()} (
                {formatDuration(y.status.last_run.duration_ms)})
              </div>
              <div>
                Uploaded {y.status.last_run.uploaded} · Skipped{" "}
                {y.status.last_run.skipped} · Failed {y.status.last_run.failed}
              </div>
              {y.status.last_run.failed > 0 && (
                <Collapse
                  size="small"
                  items={[
                    {
                      key: "errors",
                      label: "Show errors",
                      children: (
                        <ul style={{ margin: 0, paddingLeft: 20 }}>
                          {y.status.last_run.errors.slice(0, 20).map((e, i) => (
                            <li key={`${e.path}-${i}`}>
                              <code>{e.path}</code> — {e.message}
                            </li>
                          ))}
                        </ul>
                      ),
                    },
                  ]}
                />
              )}
            </Space>
          }
        />
      )}
    </Form>
  );
}
```

- [ ] **Step 4: Wire the tab into `SettingsPage`**

In `src/pages/SettingsPage/index.tsx`:

Add the import near the other settings imports:

```tsx
import { YandexSyncSettings } from "../../components/settings/YandexSyncSettings";
```

Extend `dirtyByTab` (line 76 area):

```ts
  const dirtyByTab: Record<SettingsTab, boolean> = {
    // …existing keys…
    audio: /* existing */,
    yandex:
      isDirty("yandex_sync_enabled") ||
      isDirty("yandex_sync_interval") ||
      isDirty("yandex_sync_remote_folder"),
  };
```

Append a fourth entry to `tabItems` (just after the `"audio"` entry):

```tsx
    {
      key: "yandex" as SettingsTab,
      label: (
        <>
          Sync Yandex.Disk{dirtyByTab.yandex && dirtyDot}
        </>
      ),
      children: (
        <YandexSyncSettings
          settings={settings}
          setSettings={setSettings}
          isDirty={isDirty}
          enabled={settingsTab === "yandex"}
        />
      ),
    },
```

- [ ] **Step 5: Run build + typecheck**

Run: `npm run build`
Expected: succeeds with no TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts \
        src/hooks/useYandexSync.ts \
        src/components/settings/YandexSyncSettings.tsx \
        src/pages/SettingsPage/index.tsx
git commit -m "feat(ui): Sync Yandex.Disk settings tab with progress and status"
```

---

## Task 9: Frontend tests

**Files:**
- Create: `src/components/settings/YandexSyncSettings.test.tsx`
- Create: `src/hooks/useYandexSync.test.ts`
- Modify: `src/App.settings.test.tsx` (add test for the fourth tab; add default IPC mocks for new commands)

- [ ] **Step 1: Write failing tests for the hook**

Create `src/hooks/useYandexSync.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useYandexSync } from "./useYandexSync";

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

describe("useYandexSync", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => void 0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads has_token and status on mount when enabled", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_has_token") return Promise.resolve(true);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.reject(new Error("unexpected"));
    });
    const { result } = renderHook(() => useYandexSync(true));
    await waitFor(() => expect(result.current.hasToken).toBe(true));
  });

  it("does not load when disabled", async () => {
    renderHook(() => useYandexSync(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("saveToken refreshes has_token after success", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_set_token") return Promise.resolve();
      if (cmd === "yandex_sync_has_token") return Promise.resolve(true);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.reject(new Error("unexpected"));
    });
    const { result } = renderHook(() => useYandexSync(true));
    await act(async () => {
      await result.current.saveToken("abc");
    });
    expect(invokeMock).toHaveBeenCalledWith("yandex_sync_set_token", { token: "abc" });
    expect(result.current.hasToken).toBe(true);
    expect(result.current.tokenState).toBe("updated");
  });

  it("clearToken invokes yandex_sync_clear_token and refreshes has_token to false", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_clear_token") return Promise.resolve();
      if (cmd === "yandex_sync_has_token") return Promise.resolve(false);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.reject(new Error("unexpected"));
    });
    const { result } = renderHook(() => useYandexSync(true));
    await act(async () => {
      await result.current.clearToken();
    });
    expect(result.current.hasToken).toBe(false);
  });

  it("subscribes to yandex-sync-progress and yandex-sync-finished", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_has_token") return Promise.resolve(true);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.resolve();
    });
    renderHook(() => useYandexSync(true));
    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith("yandex-sync-progress", expect.any(Function));
      expect(listenMock).toHaveBeenCalledWith("yandex-sync-finished", expect.any(Function));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/hooks/useYandexSync.test.ts`
Expected: tests fail until `useYandexSync.ts` from Task 8 is in place. (If Task 8 already shipped, they pass — that is acceptable.)

- [ ] **Step 3: Verify the hook tests pass against the Task 8 implementation**

Run: `npm test -- src/hooks/useYandexSync.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Write failing component tests**

Create `src/components/settings/YandexSyncSettings.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { YandexSyncSettings } from "./YandexSyncSettings";
import type { PublicSettings } from "../../types";

const invokeMock = vi.fn();
vi.mock("../../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => void 0),
}));

function baseSettings(overrides: Partial<PublicSettings> = {}): PublicSettings {
  return {
    recording_root: "./recordings",
    artifact_open_app: "",
    transcription_provider: "nexara",
    transcription_url: "",
    transcription_task: "transcribe",
    transcription_diarization_setting: "general",
    salute_speech_scope: "SALUTE_SPEECH_CORP",
    salute_speech_model: "general",
    salute_speech_language: "ru-RU",
    salute_speech_sample_rate: 48000,
    salute_speech_channels_count: 1,
    summary_url: "",
    summary_prompt: "",
    openai_model: "gpt-4.1-mini",
    audio_format: "opus",
    opus_bitrate_kbps: 24,
    mic_device_name: "",
    system_device_name: "",
    auto_run_pipeline_on_stop: false,
    api_call_logging_enabled: false,
    auto_delete_audio_enabled: false,
    auto_delete_audio_days: 30,
    yandex_sync_enabled: false,
    yandex_sync_interval: "24h",
    yandex_sync_remote_folder: "BigEcho",
    ...overrides,
  };
}

describe("YandexSyncSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_has_token") return Promise.resolve(false);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.resolve();
    });
  });

  it("disables interval and remote-folder inputs when master switch is off", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings({ yandex_sync_enabled: false })}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    const folder = screen.getByLabelText(/Folder on Yandex.Disk/i) as HTMLInputElement;
    expect(folder).toBeDisabled();
  });

  it("Sync now is disabled until a token is saved", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    const btn = screen.getByRole("button", { name: /Sync now/i });
    expect(btn).toBeDisabled();
  });

  it("Get token button invokes open_external_url with Polygon URL", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Get token/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
        url: "https://yandex.ru/dev/disk/poligon/",
      }),
    );
  });

  it("Save token invokes yandex_sync_set_token with trimmed value", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/OAuth token/i), {
      target: { value: "  abc  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save token/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("yandex_sync_set_token", { token: "abc" }),
    );
  });

  it("renders last_run counters when status has a last_run", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_has_token") return Promise.resolve(true);
      if (cmd === "yandex_sync_status")
        return Promise.resolve({
          is_running: false,
          last_run: {
            started_at_iso: "2026-04-24T10:00:00Z",
            finished_at_iso: "2026-04-24T10:02:14Z",
            duration_ms: 134_000,
            uploaded: 3,
            skipped: 128,
            failed: 1,
            errors: [{ path: "a/b.opus", message: "network" }],
          },
        });
      return Promise.resolve();
    });
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    await screen.findByText(/Uploaded 3 · Skipped 128 · Failed 1/);
    await screen.findByText(/Show errors/);
  });
});
```

- [ ] **Step 5: Run the component tests**

Run: `npm test -- src/components/settings/YandexSyncSettings.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Update `App.settings.test.tsx` IPC mocks and add a tab-switch test**

Open `src/App.settings.test.tsx` and locate the existing default IPC mock (search for the block that lists commands like `get_settings`). Add entries for the new commands returning safe defaults:

```ts
    if (cmd === "yandex_sync_has_token") return Promise.resolve(false);
    if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
    if (cmd === "yandex_sync_set_token") return Promise.resolve();
    if (cmd === "yandex_sync_clear_token") return Promise.resolve();
    if (cmd === "yandex_sync_now")
      return Promise.resolve({
        started_at_iso: "",
        finished_at_iso: "",
        duration_ms: 0,
        uploaded: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      });
```

Append a test that verifies the fourth tab renders:

```tsx
  test("renders the Sync Yandex.Disk tab", async () => {
    render(<App />);
    const tab = await screen.findByRole("tab", { name: /Sync Yandex.Disk/i });
    fireEvent.click(tab);
    await screen.findByText(/Enable Yandex\.Disk sync/i);
  });
```

(Adapt the imports — `fireEvent`, `screen` — to whatever the file already uses.)

- [ ] **Step 7: Run the full frontend suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/YandexSyncSettings.test.tsx \
        src/hooks/useYandexSync.test.ts \
        src/App.settings.test.tsx
git commit -m "test(ui): cover Yandex.Disk sync hook, component, and tab wiring"
```

---

## Task 10: Final build + manual smoke

- [ ] **Step 1: Full Rust suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 2: Full frontend suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual acceptance (optional, from spec §3.3)**

If a real Yandex account is available, follow the eight-step acceptance checklist in the spec: save token → Sync now → verify mirror → re-run → add file → re-run → disable Wi-Fi → clear token. Otherwise mark this step complete based on the unit / integration test coverage.
