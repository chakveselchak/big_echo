# Yandex Share-Audio-Link Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session «Поделиться» icon button that publishes the session's already-synced audio on Yandex.Disk and opens the public share link in the browser.

**Architecture:** Two new methods on the existing `YandexDiskApi` trait (`resource_meta`, `publish`) backed by the Yandex REST API; a pure `remote_audio_path` helper that mirrors the sync layout; two Tauri commands (`yandex_list_synced_sessions` for button visibility, `yandex_share_audio` for the action); frontend wiring through `useSessions → MainPage → SessionList → SessionCard`. The link is opened with the existing `open_external_url` command, so no new dependency is added.

**Tech Stack:** Rust (Tauri 2, reqwest, async-trait, tokio `JoinSet`, wiremock for tests), React + TypeScript (Ant Design, vitest + Testing Library).

---

## File Structure

**Backend (Rust):**
- `src-tauri/src/services/yandex_disk/client.rs` — MODIFY: add `ResourceMeta` struct + `resource_meta`/`publish` trait methods and their `HttpYandexDiskClient` impls + wiremock tests.
- `src-tauri/src/services/yandex_disk/share.rs` — CREATE: pure `remote_audio_path` helper + unit tests.
- `src-tauri/src/services/yandex_disk/mod.rs` — MODIFY: declare `pub mod share;`.
- `src-tauri/src/services/yandex_disk/sync_runner.rs` — MODIFY: extend the test-only `FakeApi` with the two new trait methods so the test module keeps compiling.
- `src-tauri/src/commands/yandex_sync.rs` — MODIFY: add `yandex_share_audio` + `yandex_list_synced_sessions` commands and their private helpers + tests.
- `src-tauri/src/main.rs` — MODIFY: import and register the two new commands in BOTH `generate_handler!` blocks.

**Frontend (TS):**
- `src/hooks/useSessions.ts` — MODIFY: `syncedSessionIds` state, `refreshSyncedSessions`, a mount/`yandex-sync-finished` effect, `shareSessionAudio`, and exports.
- `src/components/sessions/SessionCard.tsx` — MODIFY: `onShare`/`canShare` props + the `<ExportOutlined />` button.
- `src/components/sessions/SessionCard.test.tsx` — MODIFY: extend `renderCard` defaults + add visibility/click tests.
- `src/components/sessions/SessionList.tsx` — MODIFY: thread `onShareAudio`/`syncedSessionIds` to each `SessionCard`.
- `src/pages/MainPage/index.tsx` — MODIFY: destructure the new hook outputs and pass them to `SessionList`.

---

## Task 1: Backend — `resource_meta` + `publish` on the Yandex client

**Files:**
- Modify: `src-tauri/src/services/yandex_disk/client.rs`
- Modify: `src-tauri/src/services/yandex_disk/sync_runner.rs` (FakeApi)

- [ ] **Step 1: Add the `ResourceMeta` struct and the two trait methods**

In `client.rs`, add the struct just above the `YandexDiskApi` trait:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceMeta {
    pub size: u64,
    pub public_url: Option<String>,
}
```

Extend the trait (add the two methods after `upload_file`):

```rust
#[async_trait]
pub trait YandexDiskApi: Send + Sync {
    async fn ensure_dir(&self, remote_path: &str) -> Result<(), YandexError>;
    async fn list_dir(&self, remote_path: &str) -> Result<HashMap<String, u64>, YandexError>;
    async fn upload_file(&self, remote_path: &str, local_path: &Path) -> Result<(), YandexError>;
    /// `GET /resources?path=...&fields=name,size,public_url`. 200 → `Some`,
    /// 404 → `None` (not on the Disk), 401/403 → `Unauthorized`.
    async fn resource_meta(&self, remote_path: &str) -> Result<Option<ResourceMeta>, YandexError>;
    /// `PUT /resources/publish?path=...`. Idempotent; re-publishing keeps the
    /// same `public_url`.
    async fn publish(&self, remote_path: &str) -> Result<(), YandexError>;
}
```

- [ ] **Step 2: Add the failing wiremock tests**

In the `#[cfg(test)] mod tests` block of `client.rs`, add:

```rust
#[tokio::test]
async fn resource_meta_returns_public_url_on_200() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "name": "audio.opus", "size": 100_000,
        "public_url": "https://disk.yandex.ru/d/abc123"
    });
    Mock::given(method("GET"))
        .and(path("/resources"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .expect(1)
        .mount(&server)
        .await;
    let got = client_for(&server)
        .resource_meta("disk:/BigEcho/audio.opus")
        .await
        .expect("ok");
    assert_eq!(
        got,
        Some(ResourceMeta {
            size: 100_000,
            public_url: Some("https://disk.yandex.ru/d/abc123".to_string()),
        })
    );
}

#[tokio::test]
async fn resource_meta_returns_none_on_404() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/resources"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    let got = client_for(&server)
        .resource_meta("disk:/BigEcho/missing.opus")
        .await
        .expect("ok");
    assert_eq!(got, None);
}

#[tokio::test]
async fn publish_succeeds_on_200() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/resources/publish"))
        .and(query_param("path", "disk:/BigEcho/audio.opus"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&server)
        .await;
    client_for(&server)
        .publish("disk:/BigEcho/audio.opus")
        .await
        .expect("publish ok");
}

#[tokio::test]
async fn publish_maps_401_to_unauthorized() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/resources/publish"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;
    let err = client_for(&server)
        .publish("disk:/BigEcho/audio.opus")
        .await
        .expect_err("must fail");
    assert_eq!(err, YandexError::Unauthorized);
}
```

- [ ] **Step 3: Run the tests to verify they fail to compile (method not implemented)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::yandex_disk::client`
Expected: FAIL — compile error `not all trait items implemented`/`no method named resource_meta`.

- [ ] **Step 4: Implement the two methods on `HttpYandexDiskClient`**

Add the deserialization helper near the other `#[derive(Deserialize)]` structs:

```rust
#[derive(Deserialize)]
struct ResourceMetaResponse {
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    public_url: Option<String>,
}
```

Add the two methods inside `impl YandexDiskApi for HttpYandexDiskClient` (after `upload_file`):

```rust
async fn resource_meta(&self, remote_path: &str) -> Result<Option<ResourceMeta>, YandexError> {
    let url = format!(
        "{}/resources?path={}&fields={}",
        self.base_url,
        urlencoding::encode(remote_path),
        urlencoding::encode("name,size,public_url")
    );
    let res = self
        .http_meta
        .get(&url)
        .header("Authorization", self.auth_header_value())
        .send()
        .await
        .map_err(|e| YandexError::Network(e.to_string()))?;
    match res.status().as_u16() {
        200 => {}
        404 => return Ok(None),
        401 | 403 => return Err(YandexError::Unauthorized),
        status => {
            let body = res.text().await.unwrap_or_default();
            return Err(YandexError::Http { status, body });
        }
    }
    let parsed: ResourceMetaResponse = res
        .json()
        .await
        .map_err(|e| YandexError::Parse(e.to_string()))?;
    Ok(Some(ResourceMeta {
        size: parsed.size.unwrap_or(0),
        public_url: parsed.public_url,
    }))
}

async fn publish(&self, remote_path: &str) -> Result<(), YandexError> {
    let url = format!(
        "{}/resources/publish?path={}",
        self.base_url,
        urlencoding::encode(remote_path)
    );
    let res = self
        .http_meta
        .put(&url)
        .header("Authorization", self.auth_header_value())
        .send()
        .await
        .map_err(|e| YandexError::Network(e.to_string()))?;
    match res.status().as_u16() {
        200 | 201 => Ok(()),
        401 | 403 => Err(YandexError::Unauthorized),
        status => {
            let body = res.text().await.unwrap_or_default();
            Err(YandexError::Http { status, body })
        }
    }
}
```

- [ ] **Step 5: Extend the test-only `FakeApi` in `sync_runner.rs` so its test module compiles**

In `sync_runner.rs`, change the existing test import line:

```rust
    use crate::services::yandex_disk::client::YandexError;
```

to:

```rust
    use crate::services::yandex_disk::client::{ResourceMeta, YandexError};
```

Add these two methods inside `impl YandexDiskApi for FakeApi` (after `upload_file`):

```rust
        async fn resource_meta(
            &self,
            _remote_path: &str,
        ) -> Result<Option<ResourceMeta>, YandexError> {
            Ok(None)
        }
        async fn publish(&self, _remote_path: &str) -> Result<(), YandexError> {
            Ok(())
        }
```

- [ ] **Step 6: Run the client + sync_runner tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::yandex_disk::`
Expected: PASS — all `client` and `sync_runner` tests green, including the 4 new ones.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/services/yandex_disk/client.rs src-tauri/src/services/yandex_disk/sync_runner.rs
git commit -m "$(cat <<'EOF'
feat(yandex): add resource_meta and publish to disk client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend — `remote_audio_path` helper module

**Files:**
- Create: `src-tauri/src/services/yandex_disk/share.rs`
- Modify: `src-tauri/src/services/yandex_disk/mod.rs`

- [ ] **Step 1: Create `share.rs` with the failing tests first**

Create `src-tauri/src/services/yandex_disk/share.rs`:

```rust
use std::path::Path;

/// Computes the Yandex.Disk remote path of a session's audio file, mirroring the
/// layout produced by the sync runner: `disk:/{folder}/{rel}/{audio_file}`, where
/// `rel` is `session_dir` relative to `recording_root` in POSIX form.
///
/// Returns `None` when there is nothing to share: an empty `audio_file`, or a
/// `session_dir` that is not located under `recording_root`.
pub fn remote_audio_path(
    remote_folder: &str,
    recording_root: &Path,
    session_dir: &Path,
    audio_file: &str,
) -> Option<String> {
    let audio_file = audio_file.trim();
    if audio_file.is_empty() {
        return None;
    }
    let rel = session_dir.strip_prefix(recording_root).ok()?;
    let folder = remote_folder.trim().trim_matches('/');
    let mut parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    parts.push(audio_file.to_string());
    Some(format!("disk:/{}/{}", folder, parts.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_remote_path_for_nested_session() {
        let root = Path::new("/data/recordings");
        let dir = Path::new("/data/recordings/10.04.2026/meeting_15-06-07");
        let got = remote_audio_path("BigEcho", root, dir, "audio.opus");
        assert_eq!(
            got.as_deref(),
            Some("disk:/BigEcho/10.04.2026/meeting_15-06-07/audio.opus")
        );
    }

    #[test]
    fn trims_surrounding_slashes_in_folder() {
        let root = Path::new("/r");
        let dir = Path::new("/r/s");
        assert_eq!(
            remote_audio_path("/BigEcho/", root, dir, "audio.mp3").as_deref(),
            Some("disk:/BigEcho/s/audio.mp3")
        );
    }

    #[test]
    fn none_when_audio_file_blank() {
        let root = Path::new("/r");
        let dir = Path::new("/r/s");
        assert_eq!(remote_audio_path("BigEcho", root, dir, "   "), None);
    }

    #[test]
    fn none_when_session_dir_outside_root() {
        let root = Path::new("/r");
        let dir = Path::new("/other/s");
        assert_eq!(remote_audio_path("BigEcho", root, dir, "audio.opus"), None);
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/services/yandex_disk/mod.rs`, add the declaration in alphabetical position (after `runner`, before `state` is fine; placement is cosmetic):

```rust
pub mod scheduler;
pub mod share;
pub mod state;
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::yandex_disk::share`
Expected: PASS — 4 tests.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/services/yandex_disk/share.rs src-tauri/src/services/yandex_disk/mod.rs
git commit -m "$(cat <<'EOF'
feat(yandex): add remote_audio_path helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Backend — `yandex_share_audio` command

**Files:**
- Modify: `src-tauri/src/commands/yandex_sync.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add imports + the `share_audio_link` helper with failing tests**

At the top of `commands/yandex_sync.rs`, extend the imports. Add these lines alongside the existing `use` statements:

```rust
use crate::services::yandex_disk::client::{HttpYandexDiskClient, YandexDiskApi};
use crate::services::yandex_disk::share::remote_audio_path;
use crate::settings::public_settings::load_settings;
use crate::storage::session_store::load_meta;
use crate::storage::sqlite_repo::{get_meta_path, get_session_dir};
use crate::root_recordings_dir;
use std::path::Path;
use std::sync::Arc;
```

Add the helper (pure async, testable) above the `#[tauri::command]` functions:

```rust
/// Publishes `remote_path` (if needed) and returns its public share URL.
/// Returns `Err` when the file is not on the Disk (404) or no `public_url`
/// could be obtained.
async fn share_audio_link(
    api: Arc<dyn YandexDiskApi>,
    remote_path: &str,
) -> Result<String, String> {
    let meta = api
        .resource_meta(remote_path)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Файл ещё не синхронизирован на Диск".to_string())?;
    if let Some(url) = meta.public_url {
        return Ok(url);
    }
    api.publish(remote_path).await.map_err(|e| e.to_string())?;
    let published = api
        .resource_meta(remote_path)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Не удалось получить ссылку".to_string())?;
    published
        .public_url
        .ok_or_else(|| "Не удалось получить публичную ссылку".to_string())
}
```

Add a test module at the bottom of the file (if a `#[cfg(test)] mod tests` already exists, add these into it and reuse a single `MapFake`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::yandex_disk::client::{ResourceMeta, YandexError};
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Path → metadata fake. A `None` value (or absent key) models a 404.
    /// `publish` lazily assigns a `public_url` to a stored file that lacks one,
    /// modelling the real "publish then read" flow. `unauthorized` forces 401.
    struct MapFake {
        metas: Mutex<HashMap<String, Option<ResourceMeta>>>,
        unauthorized: bool,
    }

    impl MapFake {
        fn new() -> Self {
            Self {
                metas: Mutex::new(HashMap::new()),
                unauthorized: false,
            }
        }
        fn with(mut self, path: &str, meta: Option<ResourceMeta>) -> Self {
            self.metas.get_mut().unwrap().insert(path.to_string(), meta);
            self
        }
    }

    #[async_trait]
    impl YandexDiskApi for MapFake {
        async fn ensure_dir(&self, _p: &str) -> Result<(), YandexError> {
            Ok(())
        }
        async fn list_dir(&self, _p: &str) -> Result<HashMap<String, u64>, YandexError> {
            Ok(HashMap::new())
        }
        async fn upload_file(&self, _p: &str, _l: &Path) -> Result<(), YandexError> {
            Ok(())
        }
        async fn resource_meta(&self, p: &str) -> Result<Option<ResourceMeta>, YandexError> {
            if self.unauthorized {
                return Err(YandexError::Unauthorized);
            }
            Ok(self.metas.lock().unwrap().get(p).cloned().flatten())
        }
        async fn publish(&self, p: &str) -> Result<(), YandexError> {
            let mut m = self.metas.lock().unwrap();
            if let Some(Some(meta)) = m.get_mut(p) {
                if meta.public_url.is_none() {
                    meta.public_url = Some("https://disk.yandex.ru/d/PUB".to_string());
                }
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn share_returns_existing_public_url_without_publishing() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(MapFake::new().with(
            "disk:/BigEcho/a.opus",
            Some(ResourceMeta {
                size: 1,
                public_url: Some("https://disk.yandex.ru/d/EXISTING".to_string()),
            }),
        ));
        let url = share_audio_link(api, "disk:/BigEcho/a.opus")
            .await
            .expect("ok");
        assert_eq!(url, "https://disk.yandex.ru/d/EXISTING");
    }

    #[tokio::test]
    async fn share_publishes_then_returns_url() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(MapFake::new().with(
            "disk:/BigEcho/a.opus",
            Some(ResourceMeta {
                size: 1,
                public_url: None,
            }),
        ));
        let url = share_audio_link(api, "disk:/BigEcho/a.opus")
            .await
            .expect("ok");
        assert_eq!(url, "https://disk.yandex.ru/d/PUB");
    }

    #[tokio::test]
    async fn share_errors_when_not_synced() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(MapFake::new());
        let err = share_audio_link(api, "disk:/BigEcho/missing.opus")
            .await
            .expect_err("must fail");
        assert!(err.contains("не синхронизирован"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::yandex_sync`
Expected: FAIL — `share_audio_link` compiles but is not yet used by a command; tests should actually PASS already since the helper exists. If they PASS, that is fine — proceed. (The helper is the unit under test; the command in Step 3 is thin glue.)

- [ ] **Step 3: Add the `yandex_share_audio` command**

Add to `commands/yandex_sync.rs`:

```rust
#[tauri::command]
pub async fn yandex_share_audio(
    dirs: State<'_, AppDirs>,
    session_id: String,
) -> Result<String, String> {
    let settings = load_settings(&dirs.app_data_dir)?;
    let token = get_secret(&dirs.app_data_dir, TOKEN_KEY)
        .map_err(|_| "Yandex.Disk token is not set".to_string())?;
    if token.trim().is_empty() {
        return Err("Yandex.Disk token is not set".to_string());
    }

    let session_dir = get_session_dir(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta_path = get_meta_path(&dirs.app_data_dir, &session_id)?
        .ok_or_else(|| "Session metadata not found".to_string())?;
    let meta = load_meta(&meta_path)?;
    let recording_root = root_recordings_dir(&dirs.app_data_dir, &settings)?;

    let remote_path = remote_audio_path(
        &settings.yandex_sync_remote_folder,
        &recording_root,
        &session_dir,
        &meta.artifacts.audio_file,
    )
    .ok_or_else(|| "Нет аудио для этой сессии".to_string())?;

    let api: Arc<dyn YandexDiskApi> = Arc::new(HttpYandexDiskClient::new(token));
    share_audio_link(api, &remote_path).await
}
```

> `State` and `AppDirs` are already imported in this file (used by existing commands). `get_secret` and `TOKEN_KEY` are already imported.

- [ ] **Step 4: Register the command in both `generate_handler!` blocks of `main.rs`**

Update the import (around line 52-54) from:

```rust
use commands::yandex_sync::{
    yandex_sync_clear_token, yandex_sync_has_token, yandex_sync_now, yandex_sync_set_token,
    yandex_sync_status,
};
```

to:

```rust
use commands::yandex_sync::{
    yandex_share_audio, yandex_sync_clear_token, yandex_sync_has_token, yandex_sync_now,
    yandex_sync_set_token, yandex_sync_status,
};
```

In BOTH `generate_handler!` blocks, add `yandex_share_audio,` right after the `yandex_sync_now,` line (around lines 696 and 974):

```rust
            yandex_sync_now,
            yandex_share_audio,
```

- [ ] **Step 5: Build + run tests to verify everything compiles and passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::yandex_sync`
Expected: PASS — the 3 `share_audio_link` tests, and the crate compiles with the new command registered.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/yandex_sync.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(yandex): add yandex_share_audio command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Backend — `yandex_list_synced_sessions` command

**Files:**
- Modify: `src-tauri/src/commands/yandex_sync.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add imports + `audio_file_for` and `check_synced` helpers with failing tests**

Extend the imports at the top of `commands/yandex_sync.rs`:

```rust
use crate::services::yandex_disk::client::{ResourceMeta, YandexError};
use crate::storage::sqlite_repo::{list_sessions, SessionListItem};
use tokio::task::JoinSet;
```

Add the helpers (above the command functions):

```rust
/// Effective audio filename for a session: the stored `audio_file`, or a
/// `audio.{format}` fallback. Empty when neither is usable (mirrors the
/// frontend `resolveSessionAudioPath`).
fn audio_file_for(item: &SessionListItem) -> String {
    let stored = item.audio_file.trim();
    if !stored.is_empty() {
        return stored.to_string();
    }
    let fmt = item.audio_format.trim();
    if fmt.is_empty() || fmt == "unknown" {
        return String::new();
    }
    format!("audio.{fmt}")
}

/// Probes each `(session_id, remote_path)` with bounded concurrency and returns
/// the ids whose audio exists on the Disk. Per-file network/parse errors are
/// treated as "not synced"; a 401/403 on any probe aborts with an error.
async fn check_synced(
    api: Arc<dyn YandexDiskApi>,
    candidates: Vec<(String, String)>,
) -> Result<Vec<String>, String> {
    const LIMIT: usize = 8;
    let mut iter = candidates.into_iter();
    let mut set: JoinSet<(String, Result<Option<ResourceMeta>, YandexError>)> = JoinSet::new();

    for _ in 0..LIMIT {
        match iter.next() {
            Some((id, path)) => {
                let api = api.clone();
                set.spawn(async move {
                    let r = api.resource_meta(&path).await;
                    (id, r)
                });
            }
            None => break,
        }
    }

    let mut synced = Vec::new();
    let mut unauthorized = false;
    while let Some(joined) = set.join_next().await {
        if let Ok((id, result)) = joined {
            match result {
                Ok(Some(_)) => synced.push(id),
                Ok(None) => {}
                Err(YandexError::Unauthorized) => unauthorized = true,
                Err(_) => {}
            }
        }
        if let Some((id, path)) = iter.next() {
            let api = api.clone();
            set.spawn(async move {
                let r = api.resource_meta(&path).await;
                (id, r)
            });
        }
    }

    if unauthorized {
        return Err("Yandex.Disk authorization failed".to_string());
    }
    Ok(synced)
}
```

Add tests into the existing `#[cfg(test)] mod tests` block (reuse `MapFake` from Task 3):

```rust
    #[test]
    fn audio_file_for_uses_stored_name() {
        let item = SessionListItem {
            session_id: "s".into(),
            status: "done".into(),
            primary_tag: "slack".into(),
            topic: "t".into(),
            display_date_ru: "10.04.2026".into(),
            started_at_iso: "2026-04-10T10:00:00+03:00".into(),
            session_dir: "/r/s".into(),
            audio_file: "audio.opus".into(),
            audio_format: "opus".into(),
            audio_duration_hms: "00:00:01".into(),
            has_transcript_text: false,
            has_summary_text: false,
            brain_upload_status: crate::storage::sqlite_repo::BrainUploadStatus::NotUploaded,
            brain_server_ingested_once: false,
            brain_upload_last_error: None,
            brain_upload_updated_at_iso: None,
            meta: None,
        };
        assert_eq!(audio_file_for(&item), "audio.opus");
    }

    #[tokio::test]
    async fn check_synced_returns_only_present_ids() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(
            MapFake::new()
                .with(
                    "disk:/BigEcho/a.opus",
                    Some(ResourceMeta { size: 1, public_url: None }),
                )
                .with("disk:/BigEcho/b.opus", None),
        );
        let got = check_synced(
            api,
            vec![
                ("a".to_string(), "disk:/BigEcho/a.opus".to_string()),
                ("b".to_string(), "disk:/BigEcho/b.opus".to_string()),
            ],
        )
        .await
        .expect("ok");
        assert_eq!(got, vec!["a".to_string()]);
    }

    #[tokio::test]
    async fn check_synced_errors_on_unauthorized() {
        let api: Arc<dyn YandexDiskApi> = Arc::new(MapFake {
            metas: std::sync::Mutex::new(std::collections::HashMap::new()),
            unauthorized: true,
        });
        let err = check_synced(api, vec![("a".into(), "disk:/BigEcho/a.opus".into())])
            .await
            .expect_err("must fail");
        assert!(err.contains("authorization"));
    }
```

- [ ] **Step 2: Run the tests to verify they pass (helpers already implemented)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::yandex_sync`
Expected: PASS — including `audio_file_for_uses_stored_name`, `check_synced_returns_only_present_ids`, `check_synced_errors_on_unauthorized`.

- [ ] **Step 3: Add the `yandex_list_synced_sessions` command**

Add to `commands/yandex_sync.rs`:

```rust
#[tauri::command]
pub async fn yandex_list_synced_sessions(
    dirs: State<'_, AppDirs>,
) -> Result<Vec<String>, String> {
    let token = match get_secret(&dirs.app_data_dir, TOKEN_KEY) {
        Ok(t) if !t.trim().is_empty() => t,
        _ => return Ok(Vec::new()),
    };
    let settings = load_settings(&dirs.app_data_dir)?;
    let recording_root = root_recordings_dir(&dirs.app_data_dir, &settings)?;
    let sessions = list_sessions(&dirs.app_data_dir)?;

    let mut candidates: Vec<(String, String)> = Vec::new();
    for s in sessions {
        let audio_file = audio_file_for(&s);
        if let Some(path) = remote_audio_path(
            &settings.yandex_sync_remote_folder,
            &recording_root,
            Path::new(&s.session_dir),
            &audio_file,
        ) {
            candidates.push((s.session_id, path));
        }
    }

    let api: Arc<dyn YandexDiskApi> = Arc::new(HttpYandexDiskClient::new(token));
    check_synced(api, candidates).await
}
```

- [ ] **Step 4: Register the command in both `generate_handler!` blocks of `main.rs`**

Update the `commands::yandex_sync` import to also bring in `yandex_list_synced_sessions`:

```rust
use commands::yandex_sync::{
    yandex_list_synced_sessions, yandex_share_audio, yandex_sync_clear_token,
    yandex_sync_has_token, yandex_sync_now, yandex_sync_set_token, yandex_sync_status,
};
```

In BOTH `generate_handler!` blocks, add the line after `yandex_share_audio,`:

```rust
            yandex_share_audio,
            yandex_list_synced_sessions,
```

- [ ] **Step 5: Build + run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::yandex_sync`
Expected: PASS — crate compiles with both new commands registered.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/yandex_sync.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(yandex): add yandex_list_synced_sessions command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Frontend — `useSessions` wiring

**Files:**
- Modify: `src/hooks/useSessions.ts`

- [ ] **Step 1: Add the `listen` import**

At the top of `useSessions.ts`, add after the existing imports:

```ts
import { listen } from "@tauri-apps/api/event";
```

> `useEffect`, `useState`, `getErrorMessage`, and `tauriInvoke` are already imported.

- [ ] **Step 2: Add state, refresher, effect, and the share action**

Add the state near the other `useState` declarations (after `artifactPreview`):

```ts
  const [syncedSessionIds, setSyncedSessionIds] = useState<Set<string>>(new Set());
```

Add these functions in the body of the hook (near `openSessionFolder`):

```ts
  async function refreshSyncedSessions() {
    try {
      const ids = await tauriInvoke<string[]>("yandex_list_synced_sessions");
      setSyncedSessionIds(new Set(ids));
    } catch {
      // No token, network error, or auth failure → hide the share button
      // everywhere by treating nothing as synced. Stays quiet (no status spam).
      setSyncedSessionIds(new Set());
    }
  }

  async function shareSessionAudio(sessionId: string) {
    try {
      const url = await tauriInvoke<string>("yandex_share_audio", { sessionId });
      await tauriInvoke("open_external_url", { url });
      setStatus(`Открыл ссылку: ${url}`);
    } catch (err) {
      setStatus(getErrorMessage(err));
    }
  }
```

Add the effect that loads the set on mount and refreshes it after every sync finishes:

```ts
  useEffect(() => {
    void refreshSyncedSessions();
    let unlisten: (() => void) | undefined;
    void listen("yandex-sync-finished", () => {
      void refreshSyncedSessions();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 3: Export the two new values**

In the hook's `return { ... }` object, add `shareSessionAudio` and `syncedSessionIds` (keep the existing alphabetical-ish grouping):

```ts
    setSessionSearchQuery,
    shareSessionAudio,
    summaryPendingBySession,
    syncedSessionIds,
    textPendingBySession,
  };
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors from `useSessions.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSessions.ts
git commit -m "$(cat <<'EOF'
feat(yandex): track synced sessions and share action in useSessions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend — `SessionCard` share button

**Files:**
- Modify: `src/components/sessions/SessionCard.tsx`
- Modify: `src/components/sessions/SessionCard.test.tsx`

- [ ] **Step 1: Extend `renderCard` + add the failing visibility tests**

In `SessionCard.test.tsx`, update the `renderCard` helper signature and the rendered element to include the new props. Change the helper to:

```tsx
function renderCard(
  item: SessionListItem,
  onUploadToBrain = vi.fn(),
  brainSyncReady = true,
  canShare = false,
  onShare = vi.fn(),
) {
  const noop = () => undefined;
  const result = render(
    <SessionCard
      item={item}
      detail={makeDetail()}
      textPending={false}
      summaryPending={false}
      pipelineState={undefined as PipelineUiState | undefined}
      searchQuery=""
      knownTagOptions={[]}
      transcriptMatch={false}
      summaryMatch={false}
      showNumSpeakers={false}
      brainUploadPending={false}
      brainSyncReady={brainSyncReady}
      onContextMenu={noop}
      onDetailChange={noop}
      onOpenArtifact={noop}
      onGetText={noop}
      onGetSummary={noop}
      onOpenSummaryPrompt={noop}
      onDelete={noop}
      onDeleteAudio={noop}
      onFieldBlur={noop}
      onOpenFolder={noop}
      onUploadToBrain={onUploadToBrain}
      onShare={onShare}
      canShare={canShare}
      setStatus={noop}
    />,
  );
  return { ...result, onUploadToBrain, onShare };
}
```

Also add `onShare={noop}` and `canShare={false}` to the standalone `render(<SessionCard ... />)` call near line 147 (the "uses local pending state" test) so it keeps compiling.

Add a new describe block at the end of the file:

```tsx
describe("SessionCard share button", () => {
  it("hides the share button when canShare is false", () => {
    renderCard(makeItem("uploaded"), vi.fn(), true, false);
    expect(
      screen.queryByRole("button", { name: "Поделиться ссылкой на аудио" }),
    ).not.toBeInTheDocument();
  });

  it("shows the share button and calls onShare when canShare is true", async () => {
    const user = userEvent.setup();
    const { onShare } = renderCard(makeItem("uploaded"), vi.fn(), true, true);
    await user.click(
      screen.getByRole("button", { name: "Поделиться ссылкой на аудио" }),
    );
    expect(onShare).toHaveBeenCalledWith("s-brain");
  });

  it("hides the share button for sessions without audio even if canShare", () => {
    renderCard(
      makeItem("uploaded", { audio_file: "", audio_format: "unknown" }),
      vi.fn(),
      true,
      true,
    );
    expect(
      screen.queryByRole("button", { name: "Поделиться ссылкой на аудио" }),
    ).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/sessions/SessionCard.test.tsx`
Expected: FAIL — type error / button not found (`onShare`/`canShare` props don't exist yet).

- [ ] **Step 3: Add the props and the button to `SessionCard.tsx`**

Add `ExportOutlined` to the `@ant-design/icons` import (line 4):

```tsx
import { CheckSquareOutlined, ClearOutlined, DeleteOutlined, DeploymentUnitOutlined, ExportOutlined, FolderOpenOutlined, MessageOutlined } from "@ant-design/icons";
```

Add the two props to `SessionCardProps` (after `onUploadToBrain`):

```tsx
  onUploadToBrain: (sessionId: string) => void;
  onShare: (sessionId: string) => void;
  canShare: boolean;
```

Destructure them in `SessionCardImpl` (after `onUploadToBrain,`):

```tsx
  onUploadToBrain,
  onShare,
  canShare,
```

Add the button inside the `session-card-icon-actions` div, immediately after the folder-open `<Button>` (after its closing `/>` near line 271):

```tsx
            {hasAudio && canShare && (
              <Button
                htmlType="button"
                type="text"
                size="small"
                shape="circle"
                className="session-share-button"
                aria-label="Поделиться ссылкой на аудио"
                title="Поделиться ссылкой на аудио (Яндекс.Диск)"
                icon={<ExportOutlined aria-hidden="true" style={{ color: "gray" }} />}
                onClick={() => onShare(item.session_id)}
              />
            )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/sessions/SessionCard.test.tsx`
Expected: PASS — all existing Brain tests plus the 3 new share tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/sessions/SessionCard.tsx src/components/sessions/SessionCard.test.tsx
git commit -m "$(cat <<'EOF'
feat(sessions): add share button to session card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend — thread props through `SessionList` and `MainPage`

**Files:**
- Modify: `src/components/sessions/SessionList.tsx`
- Modify: `src/pages/MainPage/index.tsx`

- [ ] **Step 1: Add the two props to `SessionListProps` and destructure them**

In `SessionList.tsx`, add to the props type (after `onUploadToBrain` on line 69):

```tsx
  onUploadToBrain: (sessionId: string) => void;
  onShareAudio: (sessionId: string) => void;
  syncedSessionIds: Set<string>;
```

Add to the destructured parameters (after `onUploadToBrain,` on line 109):

```tsx
  onUploadToBrain,
  onShareAudio,
  syncedSessionIds,
```

- [ ] **Step 2: Pass the props to each `SessionCard`**

In the `SessionCard` JSX (the block around lines 444-474), add after `onUploadToBrain={onUploadToBrain}`:

```tsx
                  onUploadToBrain={onUploadToBrain}
                  onShare={onShareAudio}
                  canShare={syncedSessionIds.has(item.session_id)}
```

- [ ] **Step 3: Wire `MainPage` to the hook outputs**

In `src/pages/MainPage/index.tsx`, add to the `useSessions` destructure (alongside the other returns, e.g. after `setSessionSearchQuery,`):

```tsx
    shareSessionAudio,
    syncedSessionIds,
```

In the `<SessionList ... />` JSX, add after `onUploadToBrain={(sessionId) => void uploadSessionToBrain(sessionId)}` (line 326):

```tsx
          onUploadToBrain={(sessionId) => void uploadSessionToBrain(sessionId)}
          onShareAudio={(sessionId) => void shareSessionAudio(sessionId)}
          syncedSessionIds={syncedSessionIds}
```

- [ ] **Step 4: Update the `SessionList.test.tsx` typed props object**

`SessionList.test.tsx` builds a fully-typed props object (`const props: ComponentProps<typeof SessionList>`, around lines 98-135). The two new required props must be added or `tsc` fails. Add after `onUploadToBrain: noop,` (line 132):

```tsx
    onUploadToBrain: noop,
    onShareAudio: noop,
    syncedSessionIds: new Set<string>(),
```

- [ ] **Step 5: Typecheck + run the sessions tests**

Run: `npx tsc --noEmit && npx vitest run src/components/sessions/`
Expected: PASS — no type errors; `SessionList.test.tsx` and `SessionCard.test.tsx` green.

- [ ] **Step 6: Commit**

```bash
git add src/components/sessions/SessionList.tsx src/pages/MainPage/index.tsx src/components/sessions/SessionList.test.tsx
git commit -m "$(cat <<'EOF'
feat(sessions): thread share-audio props to session cards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — entire backend suite green.

- [ ] **Step 2: Rust lint + format check**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
Expected: PASS — no clippy warnings, formatting clean. (If `fmt --check` reports diffs, run `cargo fmt --manifest-path src-tauri/Cargo.toml` and commit the formatting.)

- [ ] **Step 3: Frontend typecheck + full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — no type errors; all vitest suites green.

- [ ] **Step 4: Manual smoke test (optional but recommended)**

With a configured Yandex token and at least one synced session: launch the app, confirm the «Поделиться» icon appears only on synced sessions, click it, and confirm the Yandex share page opens in the browser. Confirm the button is absent when no token is configured.

---

## Self-Review Notes (covered by this plan)

- **Spec → tasks mapping:** `resource_meta`/`publish` (Task 1) · `remote_audio_path` module (Task 2) · `yandex_share_audio` + open-in-browser via `open_external_url` (Task 3 + Task 5 `shareSessionAudio`) · `yandex_list_synced_sessions` with bounded concurrency (Task 4) · `syncedSessionIds`/refresh-on-finished (Task 5) · `<ExportOutlined />` button gated on `hasAudio && canShare` (Task 6) · prop threading (Task 7) · tests at every layer.
- **Refinement vs spec:** the spec proposed opening the URL from inside the Rust command; this plan instead returns the URL and opens it via the pre-existing, already-tested `open_external_url` command (DRY, no OS-open code duplicated). Behaviour is identical.
- **Type consistency:** `ResourceMeta { size, public_url }`, command names `yandex_share_audio` / `yandex_list_synced_sessions`, and FE prop names `onShare`/`canShare` (SessionCard) vs `onShareAudio`/`syncedSessionIds` (SessionList/MainPage) are used consistently across tasks.
