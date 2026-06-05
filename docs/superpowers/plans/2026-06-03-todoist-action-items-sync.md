# Todoist Action Items Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a user-confirmed Todoist export flow for BigEcho summary action items, with a durable SQLite queue and Todoist token stored in the existing secret store.

**Architecture:** Add a focused Rust `task_sync` domain that extracts action items from `summary.json` or `summary.md`, normalizes deterministic task IDs, stores sync state in SQLite, writes a session-local `tasks_sync.json` audit snapshot, and sends selected tasks to Todoist through a provider module. React adds Todoist settings, preview modal, and session-card export controls; the LLM remains isolated from Todoist.

**Tech Stack:** Rust/Tauri, rusqlite, reqwest, serde/serde_json, sha2, chrono, React, TypeScript, Ant Design, Vitest.

---

## File Structure

Create:

- `src-tauri/src/task_sync/mod.rs` - domain facade used by Tauri commands.
- `src-tauri/src/task_sync/model.rs` - DTOs, normalized model, statuses, errors.
- `src-tauri/src/task_sync/normalizer.rs` - deterministic IDs and field normalization.
- `src-tauri/src/task_sync/extractor.rs` - `summary.json` reader and conservative Markdown fallback.
- `src-tauri/src/task_sync/snapshot.rs` - writes `tasks_sync.json` from queue/preview status.
- `src-tauri/src/task_sync/queue.rs` - SQLite persistence for `task_sync_queue`.
- `src-tauri/src/task_sync/todoist.rs` - Todoist HTTP request mapping and response parsing.
- `src-tauri/src/task_sync/worker.rs` - syncs queued rows through the provider.
- `src-tauri/src/commands/task_sync.rs` - Tauri commands for preview, enqueue, sync, status, and token helpers.
- `src/components/settings/TodoistSyncSettings.tsx` - Settings tab content for Todoist.
- `src/components/sessions/TodoistExportModal.tsx` - action-items preview and selection modal.
- `src/hooks/useTodoistSync.ts` - frontend token/status helpers for Settings.
- `src/hooks/useTodoistTasks.ts` - frontend preview/enqueue/sync helpers for sessions.
- `src/components/settings/TodoistSyncSettings.test.tsx` - settings UI tests.
- `src/components/sessions/TodoistExportModal.test.tsx` - modal behavior tests.
- `src/hooks/useTodoistSync.test.ts` - Todoist settings hook tests.

Modify:

- `src-tauri/src/lib.rs` - export `task_sync` for tests and binary.
- `src-tauri/src/main.rs` - add module and command registration.
- `src-tauri/src/commands/mod.rs` - add `task_sync` command module.
- `src-tauri/src/domain/session.rs` - add `tasks_sync_file` to `SessionArtifacts`.
- `src-tauri/src/commands/sessions.rs` - initialize imported session artifacts with `tasks_sync_file`.
- `src-tauri/src/settings/public_settings.rs` - add Todoist public settings with defaults.
- `src-tauri/src/storage/sqlite_repo.rs` - delete task-sync rows when a session is deleted.
- `src/types/index.ts` - add Todoist public settings, tab key, task-sync DTOs.
- `src/pages/SettingsPage/index.tsx` - add Todoist settings tab.
- `src/components/sessions/SessionList.tsx` - host Todoist modal and pass export action.
- `src/components/sessions/SessionCard.tsx` - add Todoist export icon button for summarized sessions.
- `src/hooks/useSessions.ts` - refresh sessions after successful Todoist sync.
- `src/App.settings.test.tsx` - cover the settings tab integration.
- `src/components/sessions/SessionList.test.tsx` - cover the session-card export entry point.

---

### Task 1: Session Artifacts And Public Settings

**Files:**
- Modify: `src-tauri/src/domain/session.rs`
- Modify: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/settings/public_settings.rs`
- Modify: `src/types/index.ts`

- [ ] **Step 1: Write failing Rust tests for artifact defaults and settings defaults**

Add these tests to the existing `#[cfg(test)] mod tests` blocks.

In `src-tauri/src/domain/session.rs`:

```rust
#[test]
fn session_artifacts_default_includes_tasks_sync_file() {
    let artifacts = SessionArtifacts::default();
    assert_eq!(artifacts.tasks_sync_file, "tasks_sync.json");
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
```

In `src-tauri/src/settings/public_settings.rs`:

```rust
#[test]
fn todoist_settings_default_to_manual_disabled_sync() {
    let settings = PublicSettings::default();

    assert!(!settings.todoist_sync_enabled);
    assert!(!settings.todoist_auto_add);
}

#[test]
fn missing_todoist_settings_use_defaults() {
    let raw = r#"{
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
        "apple_speech_locale":"ru_RU",
        "summary_url":"",
        "summary_prompt":"",
        "openai_model":"gpt-5.1-codex-mini",
        "audio_format":"opus",
        "opus_bitrate_kbps":24,
        "mic_device_name":"",
        "system_device_name":"",
        "artifact_opener_app":"",
        "auto_run_pipeline_on_stop":false,
        "api_call_logging_enabled":false,
        "auto_delete_audio_enabled":false,
        "auto_delete_audio_days":30,
        "yandex_sync_enabled":false,
        "yandex_sync_interval":"24h",
        "yandex_sync_remote_folder":"BigEcho",
        "show_minitray_overlay":false
    }"#;

    let settings: PublicSettings = serde_json::from_str(raw).expect("legacy settings");

    assert!(!settings.todoist_sync_enabled);
    assert!(!settings.todoist_auto_add);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test session_artifacts_default_includes_tasks_sync_file todoist_settings_default_to_manual_disabled_sync --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL with missing `tasks_sync_file`, `todoist_sync_enabled`, or `todoist_auto_add` fields.

- [ ] **Step 3: Add the fields and defaults**

In `src-tauri/src/domain/session.rs`, extend `SessionArtifacts`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArtifacts {
    pub audio_file: String,
    pub transcript_file: String,
    pub summary_file: String,
    pub meta_file: String,
    #[serde(default = "default_tasks_sync_file")]
    pub tasks_sync_file: String,
}

fn default_tasks_sync_file() -> String {
    "tasks_sync.json".to_string()
}
```

Update `SessionArtifacts::default()`:

```rust
tasks_sync_file: default_tasks_sync_file(),
```

In `src-tauri/src/commands/sessions.rs`, update imported session artifact construction:

```rust
meta.artifacts = SessionArtifacts {
    audio_file: format!("audio.{audio_extension}"),
    transcript_file: transcript_name(now),
    summary_file: summary_name(now),
    meta_file: "meta.json".to_string(),
    tasks_sync_file: "tasks_sync.json".to_string(),
};
```

In `src-tauri/src/settings/public_settings.rs`, add fields:

```rust
pub todoist_sync_enabled: bool,
pub todoist_auto_add: bool,
```

Add defaults:

```rust
todoist_sync_enabled: false,
todoist_auto_add: false,
```

In `src/types/index.ts`, add to `PublicSettings`:

```ts
todoist_sync_enabled: boolean;
todoist_auto_add: boolean;
```

Extend `SettingsTab`:

```ts
export type SettingsTab = "audiototext" | "generals" | "audio" | "yandex" | "todoist";
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test session_artifacts_default_includes_tasks_sync_file todoist_settings_default_to_manual_disabled_sync missing_todoist_settings_use_defaults --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS for all three tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/domain/session.rs src-tauri/src/commands/sessions.rs src-tauri/src/settings/public_settings.rs src/types/index.ts
git commit -m "feat(todoist): add sync settings and artifact defaults"
```

---

### Task 2: Task Sync Model And Normalizer

**Files:**
- Create: `src-tauri/src/task_sync/mod.rs`
- Create: `src-tauri/src/task_sync/model.rs`
- Create: `src-tauri/src/task_sync/normalizer.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write failing normalizer tests**

Create `src-tauri/src/task_sync/normalizer.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ExtractedActionItem, TaskProvider};
    use std::path::Path;

    fn raw(title: &str) -> ExtractedActionItem {
        ExtractedActionItem {
            title: title.to_string(),
            description: None,
            due: None,
            priority: None,
            assignee: None,
            source: None,
            context: None,
        }
    }

    #[test]
    fn normalizer_collapses_title_whitespace_and_defaults_priority() {
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            raw("  Согласовать   SAP_ID \n с безопасниками  "),
        )
        .expect("normalized");

        assert_eq!(item.title, "Согласовать SAP_ID с безопасниками");
        assert_eq!(item.priority, Some(1));
    }

    #[test]
    fn normalizer_accepts_only_iso_due_dates() {
        let mut accepted = raw("Task");
        accepted.due = Some("2026-06-05".to_string());
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            accepted,
        )
        .expect("accepted");
        assert_eq!(item.due.as_deref(), Some("2026-06-05"));

        let mut rejected = raw("Task");
        rejected.due = Some("завтра".to_string());
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            rejected,
        )
        .expect("rejected due preserved");
        assert_eq!(item.due, None);
        assert!(item.description.unwrap().contains("Due: завтра"));
    }

    #[test]
    fn normalizer_uses_stable_deterministic_id() {
        let mut raw = raw("Task");
        raw.due = Some("2026-06-05".to_string());

        let first = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            raw.clone(),
        )
        .expect("first");
        let second = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            raw,
        )
        .expect("second");

        assert_eq!(first.id, second.id);
    }

    #[test]
    fn normalizer_drops_empty_titles() {
        let item = normalize_one(
            TaskProvider::Todoist,
            "session-1",
            Path::new("/tmp/session/summary.md"),
            raw("   "),
        );

        assert!(item.is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test normalizer_ --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because `task_sync` module and model types are not wired.

- [ ] **Step 3: Add module wiring and model types**

Create `src-tauri/src/task_sync/mod.rs`:

```rust
pub mod model;
pub mod normalizer;
```

In `src-tauri/src/lib.rs`, add:

```rust
pub mod task_sync;
```

In `src-tauri/src/main.rs`, add near the other `mod` declarations:

```rust
mod task_sync;
```

Create `src-tauri/src/task_sync/model.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskProvider {
    Todoist,
}

impl TaskProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskProvider::Todoist => "todoist",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskSyncStatus {
    New,
    Queued,
    Synced,
    Failed,
    Skipped,
}

impl TaskSyncStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskSyncStatus::New => "new",
            TaskSyncStatus::Queued => "queued",
            TaskSyncStatus::Synced => "synced",
            TaskSyncStatus::Failed => "failed",
            TaskSyncStatus::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedActionItem {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub id: String,
    pub provider: String,
    pub title: String,
    pub description: Option<String>,
    pub due: Option<String>,
    pub priority: Option<i64>,
    pub assignee: Option<String>,
    pub context: Option<String>,
    pub source_session_id: String,
    pub source_file_path: String,
    pub status: TaskSyncStatus,
    pub external_task_id: Option<String>,
    pub error: Option<String>,
}
```

- [ ] **Step 4: Add normalizer implementation**

In `src-tauri/src/task_sync/normalizer.rs`, add above the tests:

```rust
use crate::task_sync::model::{ActionItem, ExtractedActionItem, TaskProvider, TaskSyncStatus};
use sha2::{Digest, Sha256};
use std::path::Path;

fn collapse_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn normalized_priority(value: Option<i64>) -> i64 {
    value.unwrap_or(1).clamp(1, 4)
}

fn deterministic_id(provider: TaskProvider, session_id: &str, title: &str, due: Option<&str>) -> String {
    let input = format!("{}\n{}\n{}\n{}", provider.as_str(), session_id, title, due.unwrap_or(""));
    let digest = Sha256::digest(input.as_bytes());
    format!("{digest:x}")
}

pub fn normalize_one(
    provider: TaskProvider,
    source_session_id: &str,
    source_file_path: &Path,
    raw: ExtractedActionItem,
) -> Option<ActionItem> {
    let title = collapse_ws(&raw.title);
    if title.is_empty() {
        return None;
    }

    let raw_due = raw.due.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let due = raw_due.filter(|v| is_iso_date(v)).map(str::to_string);
    let mut description_parts = Vec::new();
    if let Some(description) = raw.description.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        description_parts.push(description.to_string());
    }
    if let Some(context) = raw.context.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        description_parts.push(format!("Контекст:\n{context}"));
    }
    if let Some(assignee) = raw.assignee.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        description_parts.push(format!("Исполнитель: {assignee}"));
    }
    if raw_due.is_some() && due.is_none() {
        description_parts.push(format!("Due: {}", raw_due.unwrap()));
    }
    description_parts.push(format!("Источник: BigEcho\nВстреча: {source_session_id}\nФайл: {}", source_file_path.display()));

    Some(ActionItem {
        id: deterministic_id(provider, source_session_id, &title, due.as_deref()),
        provider: provider.as_str().to_string(),
        title,
        description: Some(description_parts.join("\n\n")),
        due,
        priority: Some(normalized_priority(raw.priority)),
        assignee: raw.assignee.map(|value| collapse_ws(&value)).filter(|value| !value.is_empty()),
        context: raw.context.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        source_session_id: source_session_id.to_string(),
        source_file_path: source_file_path.to_string_lossy().to_string(),
        status: TaskSyncStatus::New,
        external_task_id: None,
        error: None,
    })
}

pub fn normalize_many(
    provider: TaskProvider,
    source_session_id: &str,
    source_file_path: &Path,
    items: Vec<ExtractedActionItem>,
) -> Vec<ActionItem> {
    items
        .into_iter()
        .filter_map(|item| normalize_one(provider, source_session_id, source_file_path, item))
        .collect()
}
```

- [ ] **Step 5: Run normalizer tests**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test normalizer_ --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/task_sync/mod.rs src-tauri/src/task_sync/model.rs src-tauri/src/task_sync/normalizer.rs src-tauri/src/lib.rs src-tauri/src/main.rs
git commit -m "feat(todoist): add action item normalizer"
```

---

### Task 3: Extractor And Snapshot Writer

**Files:**
- Modify: `src-tauri/src/task_sync/extractor.rs`
- Modify: `src-tauri/src/task_sync/snapshot.rs`
- Modify: `src-tauri/src/task_sync/mod.rs`
- Test support uses: `src-tauri/src/storage/markdown_artifact.rs`

- [ ] **Step 1: Write failing extractor tests**

Create `src-tauri/src/task_sync/extractor.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn extractor_prefers_summary_json_action_items() {
        let tmp = tempdir().expect("tempdir");
        let summary_md = tmp.path().join("summary.md");
        let summary_json = tmp.path().join("summary.json");
        std::fs::write(&summary_md, "## Action items\n- fallback").expect("summary md");
        std::fs::write(
            &summary_json,
            r#"{"summary":"x","decisions":[],"actionItems":[{"title":"JSON task","due":"2026-06-05","priority":3}]}"#,
        )
        .expect("summary json");

        let result = extract_action_items(&summary_md).expect("extract");

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "JSON task");
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn extractor_falls_back_to_markdown_checkbox_items() {
        let tmp = tempdir().expect("tempdir");
        let summary_md = tmp.path().join("summary.md");
        std::fs::write(
            &summary_md,
            "---\nsource: \"zoom\"\n---\n\n## Action Items\n- [ ] Согласовать SAP_ID\n- [ ] Отправить договор\n",
        )
        .expect("summary md");

        let result = extract_action_items(&summary_md).expect("extract");

        assert_eq!(result.items.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), vec![
            "Согласовать SAP_ID",
            "Отправить договор",
        ]);
    }

    #[test]
    fn extractor_returns_empty_items_for_missing_summary() {
        let tmp = tempdir().expect("tempdir");
        let result = extract_action_items(&tmp.path().join("summary.md")).expect("extract");

        assert!(result.items.is_empty());
        assert_eq!(result.warnings, vec!["summary.md not found"]);
    }
}
```

- [ ] **Step 2: Write failing snapshot test**

Create `src-tauri/src/task_sync/snapshot.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ActionItem, TaskSyncStatus};
    use tempfile::tempdir;

    #[test]
    fn writes_tasks_sync_snapshot() {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("tasks_sync.json");
        let item = ActionItem {
            id: "id-1".to_string(),
            provider: "todoist".to_string(),
            title: "Task".to_string(),
            description: None,
            due: Some("2026-06-05".to_string()),
            priority: Some(3),
            assignee: Some("Андрей".to_string()),
            context: None,
            source_session_id: "session-1".to_string(),
            source_file_path: "/tmp/session/summary.md".to_string(),
            status: TaskSyncStatus::Queued,
            external_task_id: None,
            error: None,
        };

        write_snapshot(&path, "session-1", "todoist", &[item]).expect("write snapshot");

        let raw = std::fs::read_to_string(path).expect("snapshot");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(json["sourceSessionId"], "session-1");
        assert_eq!(json["provider"], "todoist");
        assert_eq!(json["items"][0]["title"], "Task");
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test extractor_ writes_tasks_sync_snapshot --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because extractor and snapshot functions are missing.

- [ ] **Step 4: Implement extractor**

In `src-tauri/src/task_sync/mod.rs`, add:

```rust
pub mod extractor;
pub mod snapshot;
```

In `src-tauri/src/task_sync/extractor.rs`, add:

```rust
use crate::storage::markdown_artifact::strip_frontmatter;
use crate::task_sync::model::ExtractedActionItem;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ExtractionResult {
    pub items: Vec<ExtractedActionItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineSummary {
    #[serde(default)]
    action_items: Vec<ExtractedActionItem>,
}

pub fn extract_action_items(summary_md_path: &Path) -> Result<ExtractionResult, String> {
    let summary_json_path = summary_md_path.with_file_name("summary.json");
    let mut warnings = Vec::new();

    if summary_json_path.exists() {
        match std::fs::read_to_string(&summary_json_path)
            .map_err(|e| e.to_string())
            .and_then(|raw| serde_json::from_str::<MachineSummary>(&raw).map_err(|e| e.to_string()))
        {
            Ok(summary) => {
                return Ok(ExtractionResult {
                    items: summary.action_items,
                    warnings,
                });
            }
            Err(err) => warnings.push(format!("summary.json invalid: {err}")),
        }
    }

    if !summary_md_path.exists() {
        warnings.push("summary.md not found".to_string());
        return Ok(ExtractionResult { items: Vec::new(), warnings });
    }

    let raw = std::fs::read_to_string(summary_md_path).map_err(|e| e.to_string())?;
    let body = strip_frontmatter(&raw);
    Ok(ExtractionResult {
        items: extract_from_markdown(body),
        warnings,
    })
}

fn extract_from_markdown(body: &str) -> Vec<ExtractedActionItem> {
    let mut in_action_section = false;
    let mut items = Vec::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let heading = trimmed.trim_start_matches('#').trim().to_ascii_lowercase();
            in_action_section = heading.contains("action item")
                || heading.contains("actions")
                || heading.contains("задач")
                || heading.contains("действ");
            continue;
        }
        if !in_action_section {
            continue;
        }
        let title = trimmed
            .strip_prefix("- [ ]")
            .or_else(|| trimmed.strip_prefix("* [ ]"))
            .or_else(|| trimmed.strip_prefix("-"))
            .or_else(|| trimmed.strip_prefix("*"))
            .map(str::trim)
            .unwrap_or("");
        if !title.is_empty() {
            items.push(ExtractedActionItem {
                title: title.to_string(),
                description: None,
                due: None,
                priority: None,
                assignee: None,
                source: None,
                context: None,
            });
        }
    }
    items
}
```

- [ ] **Step 5: Implement snapshot writer**

In `src-tauri/src/task_sync/snapshot.rs`, add:

```rust
use crate::task_sync::model::ActionItem;
use chrono::Local;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskSyncSnapshot<'a> {
    source_session_id: &'a str,
    provider: &'a str,
    updated_at: String,
    items: &'a [ActionItem],
}

pub fn write_snapshot(
    path: &Path,
    source_session_id: &str,
    provider: &str,
    items: &[ActionItem],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let snapshot = TaskSyncSnapshot {
        source_session_id,
        provider,
        updated_at: Local::now().to_rfc3339(),
        items,
    };
    let raw = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}
```

- [ ] **Step 6: Run extractor and snapshot tests**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test extractor_ writes_tasks_sync_snapshot --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/task_sync/extractor.rs src-tauri/src/task_sync/snapshot.rs src-tauri/src/task_sync/mod.rs
git commit -m "feat(todoist): extract summary action items"
```

---

### Task 4: SQLite Task Sync Queue

**Files:**
- Modify: `src-tauri/src/task_sync/queue.rs`
- Modify: `src-tauri/src/task_sync/mod.rs`
- Modify: `src-tauri/src/storage/sqlite_repo.rs`

- [ ] **Step 1: Write failing queue tests**

Create `src-tauri/src/task_sync/queue.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ActionItem, TaskSyncStatus};
    use tempfile::tempdir;

    fn item(id: &str) -> ActionItem {
        ActionItem {
            id: id.to_string(),
            provider: "todoist".to_string(),
            title: "Task".to_string(),
            description: Some("Desc".to_string()),
            due: Some("2026-06-05".to_string()),
            priority: Some(3),
            assignee: None,
            context: None,
            source_session_id: "session-1".to_string(),
            source_file_path: "/tmp/session/summary.md".to_string(),
            status: TaskSyncStatus::New,
            external_task_id: None,
            error: None,
        }
    }

    #[test]
    fn upsert_new_tasks_does_not_duplicate_ids() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("first");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("second");

        let rows = list_by_session(tmp.path(), "session-1", "todoist").expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, TaskSyncStatus::New);
    }

    #[test]
    fn mark_synced_is_not_reset_by_upsert() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()]).expect("enqueue");
        mark_synced(tmp.path(), "id-1", "todoist-task-1").expect("synced");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("upsert");

        let rows = list_by_session(tmp.path(), "session-1", "todoist").expect("list");
        assert_eq!(rows[0].status, TaskSyncStatus::Synced);
        assert_eq!(rows[0].external_task_id.as_deref(), Some("todoist-task-1"));
    }

    #[test]
    fn failed_rows_can_be_requeued() {
        let tmp = tempdir().expect("tempdir");
        upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        mark_failed(tmp.path(), "id-1", "network", true).expect("failed");
        requeue_failed(tmp.path(), "session-1", "todoist").expect("requeue");

        let batch = next_pending_batch(tmp.path(), Some("session-1"), 10).expect("batch");
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].status, TaskSyncStatus::Queued);
        assert_eq!(batch[0].error, None);
    }
}
```

- [ ] **Step 2: Run queue tests to verify they fail**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test upsert_new_tasks_does_not_duplicate_ids mark_synced_is_not_reset_by_upsert failed_rows_can_be_requeued --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because queue functions are missing.

- [ ] **Step 3: Implement queue schema and row mapping**

In `src-tauri/src/task_sync/mod.rs`, add:

```rust
pub mod queue;
```

In `src-tauri/src/task_sync/queue.rs`, add above tests:

```rust
use crate::task_sync::model::{ActionItem, TaskSyncStatus};
use chrono::Local;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

fn db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("bigecho.sqlite3")
}

fn open(app_data_dir: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app_data_dir)).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS task_sync_queue (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          due TEXT,
          priority INTEGER,
          assignee TEXT,
          context TEXT,
          source_session_id TEXT NOT NULL,
          source_file_path TEXT NOT NULL,
          external_task_id TEXT,
          status TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          queued_at TEXT,
          synced_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_task_sync_queue_session_provider
        ON task_sync_queue(source_session_id, provider);
        ",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn status_from_str(value: &str) -> TaskSyncStatus {
    match value {
        "queued" => TaskSyncStatus::Queued,
        "synced" => TaskSyncStatus::Synced,
        "failed" => TaskSyncStatus::Failed,
        "skipped" => TaskSyncStatus::Skipped,
        _ => TaskSyncStatus::New,
    }
}

fn row_to_action_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActionItem> {
    let status: String = row.get(10)?;
    Ok(ActionItem {
        id: row.get(0)?,
        provider: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        due: row.get(4)?,
        priority: row.get(5)?,
        assignee: row.get(6)?,
        context: row.get(7)?,
        source_session_id: row.get(8)?,
        source_file_path: row.get(9)?,
        status: status_from_str(&status),
        external_task_id: row.get(11)?,
        error: row.get(12)?,
    })
}
```

- [ ] **Step 4: Implement queue functions**

Add these functions in the same file:

```rust
pub fn upsert_new_tasks(app_data_dir: &Path, items: &[ActionItem]) -> Result<(), String> {
    let mut conn = open(app_data_dir)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = Local::now().to_rfc3339();
    for item in items {
        tx.execute(
            "
            INSERT INTO task_sync_queue (
              id, provider, title, description, due, priority, assignee, context,
              source_session_id, source_file_path, status, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'new', ?11)
            ON CONFLICT(id) DO NOTHING
            ",
            params![
                item.id,
                item.provider,
                item.title,
                item.description,
                item.due,
                item.priority,
                item.assignee,
                item.context,
                item.source_session_id,
                item.source_file_path,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn list_by_session(app_data_dir: &Path, session_id: &str, provider: &str) -> Result<Vec<ActionItem>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn.prepare(
        "
        SELECT id, provider, title, description, due, priority, assignee, context,
               source_session_id, source_file_path, status, external_task_id, error
        FROM task_sync_queue
        WHERE source_session_id = ?1 AND provider = ?2
        ORDER BY created_at ASC
        ",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![session_id, provider], row_to_action_item).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn enqueue_tasks(app_data_dir: &Path, session_id: &str, provider: &str, ids: &[String]) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    let now = Local::now().to_rfc3339();
    for id in ids {
        conn.execute(
            "
            UPDATE task_sync_queue
            SET status = 'queued', error = NULL, queued_at = ?1
            WHERE id = ?2 AND source_session_id = ?3 AND provider = ?4 AND status IN ('new', 'failed', 'skipped')
            ",
            params![now, id, session_id, provider],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn next_pending_batch(app_data_dir: &Path, session_id: Option<&str>, limit: i64) -> Result<Vec<ActionItem>, String> {
    let conn = open(app_data_dir)?;
    let sql = if session_id.is_some() {
        "
        SELECT id, provider, title, description, due, priority, assignee, context,
               source_session_id, source_file_path, status, external_task_id, error
        FROM task_sync_queue
        WHERE status = 'queued' AND source_session_id = ?1
        ORDER BY queued_at ASC
        LIMIT ?2
        "
    } else {
        "
        SELECT id, provider, title, description, due, priority, assignee, context,
               source_session_id, source_file_path, status, external_task_id, error
        FROM task_sync_queue
        WHERE status = 'queued'
        ORDER BY queued_at ASC
        LIMIT ?2
        "
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(session_id) = session_id {
        let rows = stmt.query_map(params![session_id, limit], row_to_action_item).map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let rows = stmt.query_map(params![limit], row_to_action_item).map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

pub fn mark_synced(app_data_dir: &Path, id: &str, external_task_id: &str) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "UPDATE task_sync_queue SET status = 'synced', external_task_id = ?1, error = NULL, synced_at = ?2 WHERE id = ?3",
        params![external_task_id, Local::now().to_rfc3339(), id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_failed(app_data_dir: &Path, id: &str, error: &str, _retryable: bool) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "UPDATE task_sync_queue SET status = 'failed', error = ?1 WHERE id = ?2",
        params![error, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn requeue_failed(app_data_dir: &Path, session_id: &str, provider: &str) -> Result<(), String> {
    let conn = open(app_data_dir)?;
    conn.execute(
        "UPDATE task_sync_queue SET status = 'queued', error = NULL, queued_at = ?1 WHERE source_session_id = ?2 AND provider = ?3 AND status = 'failed'",
        params![Local::now().to_rfc3339(), session_id, provider],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 5: Delete task rows when deleting session**

In `src-tauri/src/storage/sqlite_repo.rs`, inside `delete_session`, before deleting `sessions`, add:

```rust
conn.execute(
    "DELETE FROM task_sync_queue WHERE source_session_id=?1",
    params![session_id],
)
.map_err(|e| e.to_string())?;
```

- [ ] **Step 6: Run queue tests**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test upsert_new_tasks_does_not_duplicate_ids mark_synced_is_not_reset_by_upsert failed_rows_can_be_requeued --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/task_sync/queue.rs src-tauri/src/task_sync/mod.rs src-tauri/src/storage/sqlite_repo.rs
git commit -m "feat(todoist): persist task sync queue"
```

---

### Task 5: Todoist Provider And Sync Worker

**Files:**
- Modify: `src-tauri/src/task_sync/todoist.rs`
- Modify: `src-tauri/src/task_sync/worker.rs`
- Modify: `src-tauri/src/task_sync/mod.rs`
- Modify: `src-tauri/src/task_sync/model.rs`

- [ ] **Step 1: Add Todoist error model**

In `src-tauri/src/task_sync/model.rs`, add:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskSyncErrorKind {
    MissingToken,
    InvalidToken,
    RateLimit,
    Server,
    BadRequest,
    Network,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSyncError {
    pub kind: TaskSyncErrorKind,
    pub message: String,
    pub retryable: bool,
}

impl TaskSyncError {
    pub fn new(kind: TaskSyncErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self { kind, message: message.into(), retryable }
    }
}
```

- [ ] **Step 2: Write failing Todoist provider tests**

Create `src-tauri/src/task_sync/todoist.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ActionItem, TaskSyncStatus, TaskSyncErrorKind};

    fn item() -> ActionItem {
        ActionItem {
            id: "id-1".to_string(),
            provider: "todoist".to_string(),
            title: "Task".to_string(),
            description: Some("Desc".to_string()),
            due: Some("2026-06-05".to_string()),
            priority: Some(3),
            assignee: Some("Андрей".to_string()),
            context: Some("Context".to_string()),
            source_session_id: "session-1".to_string(),
            source_file_path: "/tmp/session/summary.md".to_string(),
            status: TaskSyncStatus::Queued,
            external_task_id: None,
            error: None,
        }
    }

    #[test]
    fn todoist_payload_omits_project_id_for_inbox() {
        let payload = build_create_task_payload(&item());
        let json = serde_json::to_value(payload).expect("payload");

        assert_eq!(json["content"], "Task");
        assert_eq!(json["description"], "Desc");
        assert_eq!(json["due_date"], "2026-06-05");
        assert_eq!(json["priority"], 3);
        assert!(json.get("project_id").is_none());
    }

    #[test]
    fn maps_http_statuses_to_error_kinds() {
        assert_eq!(map_status_error(401, "bad").kind, TaskSyncErrorKind::InvalidToken);
        assert_eq!(map_status_error(429, "slow").kind, TaskSyncErrorKind::RateLimit);
        assert_eq!(map_status_error(500, "down").kind, TaskSyncErrorKind::Server);
        assert_eq!(map_status_error(400, "bad data").kind, TaskSyncErrorKind::BadRequest);
    }
}
```

- [ ] **Step 3: Implement Todoist payload and provider**

In `src-tauri/src/task_sync/mod.rs`, add:

```rust
pub mod todoist;
```

In `src-tauri/src/task_sync/todoist.rs`, add above tests:

```rust
use crate::task_sync::model::{ActionItem, TaskSyncError, TaskSyncErrorKind};
use serde::{Deserialize, Serialize};

const TODOIST_CREATE_TASK_URL: &str = "https://api.todoist.com/api/v1/tasks";

#[derive(Debug, Serialize)]
pub struct TodoistCreateTaskPayload {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TodoistTaskResponse {
    id: String,
}

pub fn build_create_task_payload(item: &ActionItem) -> TodoistCreateTaskPayload {
    TodoistCreateTaskPayload {
        content: item.title.clone(),
        description: item.description.clone(),
        due_date: item.due.clone(),
        priority: item.priority,
    }
}

pub fn map_status_error(status: u16, body: &str) -> TaskSyncError {
    match status {
        401 => TaskSyncError::new(TaskSyncErrorKind::InvalidToken, "Todoist token is invalid", false),
        429 => TaskSyncError::new(TaskSyncErrorKind::RateLimit, "Todoist rate limit reached", true),
        500..=599 => TaskSyncError::new(TaskSyncErrorKind::Server, format!("Todoist server error: {body}"), true),
        400 => TaskSyncError::new(TaskSyncErrorKind::BadRequest, format!("Todoist rejected task: {body}"), false),
        _ => TaskSyncError::new(TaskSyncErrorKind::Network, format!("Todoist request failed with status {status}: {body}"), true),
    }
}

pub async fn create_task(token: &str, item: &ActionItem) -> Result<String, TaskSyncError> {
    let client = reqwest::Client::new();
    let response = client
        .post(TODOIST_CREATE_TASK_URL)
        .bearer_auth(token)
        .json(&build_create_task_payload(item))
        .send()
        .await
        .map_err(|e| TaskSyncError::new(TaskSyncErrorKind::Network, e.to_string(), true))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| TaskSyncError::new(TaskSyncErrorKind::Network, e.to_string(), true))?;

    if !status.is_success() {
        return Err(map_status_error(status.as_u16(), &body));
    }

    let parsed: TodoistTaskResponse = serde_json::from_str(&body)
        .map_err(|e| TaskSyncError::new(TaskSyncErrorKind::Network, e.to_string(), true))?;
    Ok(parsed.id)
}
```

- [ ] **Step 4: Write failing worker test**

Create `src-tauri/src/task_sync/worker.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_sync::model::{ActionItem, TaskSyncStatus, TaskSyncError, TaskSyncErrorKind};
    use crate::task_sync::queue;
    use tempfile::tempdir;

    fn item(id: &str) -> ActionItem {
        ActionItem {
            id: id.to_string(),
            provider: "todoist".to_string(),
            title: "Task".to_string(),
            description: None,
            due: None,
            priority: Some(1),
            assignee: None,
            context: None,
            source_session_id: "session-1".to_string(),
            source_file_path: "/tmp/session/summary.md".to_string(),
            status: TaskSyncStatus::New,
            external_task_id: None,
            error: None,
        }
    }

    #[tokio::test]
    async fn worker_marks_successful_tasks_synced() {
        let tmp = tempdir().expect("tempdir");
        queue::upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        queue::enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()]).expect("enqueue");

        let result = sync_queued_with(tmp.path(), Some("session-1"), |_item| async {
            Ok("todoist-1".to_string())
        })
        .await
        .expect("sync");

        assert_eq!(result.synced, 1);
        let rows = queue::list_by_session(tmp.path(), "session-1", "todoist").expect("rows");
        assert_eq!(rows[0].status, TaskSyncStatus::Synced);
        assert_eq!(rows[0].external_task_id.as_deref(), Some("todoist-1"));
    }

    #[tokio::test]
    async fn worker_marks_failed_tasks_failed() {
        let tmp = tempdir().expect("tempdir");
        queue::upsert_new_tasks(tmp.path(), &[item("id-1")]).expect("insert");
        queue::enqueue_tasks(tmp.path(), "session-1", "todoist", &["id-1".to_string()]).expect("enqueue");

        let result = sync_queued_with(tmp.path(), Some("session-1"), |_item| async {
            Err(TaskSyncError::new(TaskSyncErrorKind::RateLimit, "rate limited", true))
        })
        .await
        .expect("sync");

        assert_eq!(result.failed, 1);
        let rows = queue::list_by_session(tmp.path(), "session-1", "todoist").expect("rows");
        assert_eq!(rows[0].status, TaskSyncStatus::Failed);
        assert_eq!(rows[0].error.as_deref(), Some("rate limited"));
    }
}
```

- [ ] **Step 5: Implement worker**

In `src-tauri/src/task_sync/mod.rs`, add:

```rust
pub mod worker;
```

In `src-tauri/src/task_sync/worker.rs`, add above tests:

```rust
use crate::task_sync::model::{ActionItem, TaskSyncError};
use crate::task_sync::{queue, todoist};
use serde::Serialize;
use std::future::Future;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSyncResult {
    pub synced: usize,
    pub failed: usize,
}

pub async fn sync_queued(app_data_dir: &Path, session_id: Option<&str>, token: &str) -> Result<TaskSyncResult, String> {
    sync_queued_with(app_data_dir, session_id, |item| async move {
        todoist::create_task(token, item).await
    })
    .await
}

pub async fn sync_queued_with<F, Fut>(
    app_data_dir: &Path,
    session_id: Option<&str>,
    create: F,
) -> Result<TaskSyncResult, String>
where
    F: Fn(&ActionItem) -> Fut,
    Fut: Future<Output = Result<String, TaskSyncError>>,
{
    let batch = queue::next_pending_batch(app_data_dir, session_id, 50)?;
    let mut result = TaskSyncResult { synced: 0, failed: 0 };
    for item in batch {
        match create(&item).await {
            Ok(external_id) => {
                queue::mark_synced(app_data_dir, &item.id, &external_id)?;
                result.synced += 1;
            }
            Err(err) => {
                queue::mark_failed(app_data_dir, &item.id, &err.message, err.retryable)?;
                result.failed += 1;
            }
        }
    }
    Ok(result)
}
```

- [ ] **Step 6: Run provider and worker tests**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test todoist_payload_omits_project_id_for_inbox maps_http_statuses_to_error_kinds worker_marks_ --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/task_sync/todoist.rs src-tauri/src/task_sync/worker.rs src-tauri/src/task_sync/mod.rs src-tauri/src/task_sync/model.rs
git commit -m "feat(todoist): add provider and sync worker"
```

---

### Task 6: Tauri Commands And Domain Facade

**Files:**
- Modify: `src-tauri/src/task_sync/mod.rs`
- Create: `src-tauri/src/commands/task_sync.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add command DTOs**

In `src-tauri/src/task_sync/model.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoistTaskPreview {
    pub session_id: String,
    pub summary_path: String,
    pub warnings: Vec<String>,
    pub items: Vec<ActionItem>,
}
```

- [ ] **Step 2: Implement domain facade**

In `src-tauri/src/task_sync/mod.rs`, keep the module exports and add:

```rust
use crate::app_state::AppDirs;
use crate::storage::session_store::load_meta;
use crate::storage::sqlite_repo::get_session_dir;
use crate::task_sync::model::{TaskProvider, TodoistTaskPreview};
use std::path::PathBuf;

pub fn preview_todoist_tasks_for_session(dirs: &AppDirs, session_id: &str) -> Result<TodoistTaskPreview, String> {
    let session_dir = get_session_dir(&dirs.app_data_dir, session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta_path = session_dir.join("meta.json");
    let meta = load_meta(&meta_path)?;
    let summary_path = session_dir.join(&meta.artifacts.summary_file);
    let extraction = extractor::extract_action_items(&summary_path)?;
    let mut normalized = normalizer::normalize_many(
        TaskProvider::Todoist,
        &meta.session_id,
        &summary_path,
        extraction.items,
    );
    queue::upsert_new_tasks(&dirs.app_data_dir, &normalized)?;
    let rows = queue::list_by_session(&dirs.app_data_dir, &meta.session_id, "todoist")?;
    for item in &mut normalized {
        if let Some(row) = rows.iter().find(|row| row.id == item.id) {
            item.status = row.status.clone();
            item.external_task_id = row.external_task_id.clone();
            item.error = row.error.clone();
        }
    }
    let snapshot_path = session_dir.join(&meta.artifacts.tasks_sync_file);
    snapshot::write_snapshot(&snapshot_path, &meta.session_id, "todoist", &normalized)?;
    Ok(TodoistTaskPreview {
        session_id: meta.session_id,
        summary_path: summary_path.to_string_lossy().to_string(),
        warnings: extraction.warnings,
        items: normalized,
    })
}

pub fn enqueue_todoist_tasks_for_session(dirs: &AppDirs, session_id: &str, task_ids: &[String]) -> Result<Vec<model::ActionItem>, String> {
    queue::enqueue_tasks(&dirs.app_data_dir, session_id, "todoist", task_ids)?;
    queue::list_by_session(&dirs.app_data_dir, session_id, "todoist")
}

pub fn status_for_session(dirs: &AppDirs, session_id: &str) -> Result<Vec<model::ActionItem>, String> {
    queue::list_by_session(&dirs.app_data_dir, session_id, "todoist")
}
```

- [ ] **Step 3: Implement command file**

Create `src-tauri/src/commands/task_sync.rs`:

```rust
use crate::app_state::AppDirs;
use crate::settings::secret_store::{clear_secret, get_secret, set_secret};
use crate::task_sync::model::{ActionItem, TaskSyncErrorKind, TodoistTaskPreview};
use crate::task_sync::worker::TaskSyncResult;
use tauri::State;

pub(crate) const TODOIST_TOKEN_KEY: &str = "TODOIST_API_TOKEN";

#[tauri::command]
pub async fn todoist_sync_set_token(dirs: State<'_, AppDirs>, token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token must not be empty".to_string());
    }
    set_secret(&dirs.app_data_dir, TODOIST_TOKEN_KEY, trimmed)
}

#[tauri::command]
pub async fn todoist_sync_clear_token(dirs: State<'_, AppDirs>) -> Result<(), String> {
    clear_secret(&dirs.app_data_dir, TODOIST_TOKEN_KEY)
}

#[tauri::command]
pub async fn todoist_sync_has_token(dirs: State<'_, AppDirs>) -> Result<bool, String> {
    match get_secret(&dirs.app_data_dir, TODOIST_TOKEN_KEY) {
        Ok(value) => Ok(!value.trim().is_empty()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub fn preview_todoist_tasks(dirs: State<'_, AppDirs>, session_id: String) -> Result<TodoistTaskPreview, String> {
    crate::task_sync::preview_todoist_tasks_for_session(dirs.inner(), &session_id)
}

#[tauri::command]
pub async fn enqueue_todoist_tasks(
    dirs: State<'_, AppDirs>,
    session_id: String,
    task_ids: Vec<String>,
) -> Result<Vec<ActionItem>, String> {
    if !todoist_sync_has_token(dirs.clone()).await? {
        return Err("missing_token: Todoist API token is not configured".to_string());
    }
    crate::task_sync::enqueue_todoist_tasks_for_session(dirs.inner(), &session_id, &task_ids)
}

#[tauri::command]
pub async fn sync_todoist_tasks(
    dirs: State<'_, AppDirs>,
    session_id: Option<String>,
) -> Result<TaskSyncResult, String> {
    let token = get_secret(&dirs.app_data_dir, TODOIST_TOKEN_KEY)
        .map_err(|_| "missing_token: Todoist API token is not configured".to_string())?;
    crate::task_sync::worker::sync_queued(&dirs.app_data_dir, session_id.as_deref(), &token).await
}

#[tauri::command]
pub fn get_todoist_sync_status(dirs: State<'_, AppDirs>, session_id: String) -> Result<Vec<ActionItem>, String> {
    crate::task_sync::status_for_session(dirs.inner(), &session_id)
}
```

If `State<'_, AppDirs>` cannot be cloned in this command, replace the token check in `enqueue_todoist_tasks` with a direct `get_secret` call:

```rust
if get_secret(&dirs.app_data_dir, TODOIST_TOKEN_KEY)
    .map(|value| value.trim().is_empty())
    .unwrap_or(true)
{
    return Err("missing_token: Todoist API token is not configured".to_string());
}
```

- [ ] **Step 4: Wire command module and handlers**

In `src-tauri/src/commands/mod.rs`:

```rust
pub mod task_sync;
```

In `src-tauri/src/main.rs`, add imports:

```rust
use commands::task_sync::{
    enqueue_todoist_tasks, get_todoist_sync_status, preview_todoist_tasks,
    sync_todoist_tasks, todoist_sync_clear_token, todoist_sync_has_token,
    todoist_sync_set_token,
};
```

Add to both `tauri::generate_handler!` lists:

```rust
todoist_sync_set_token,
todoist_sync_clear_token,
todoist_sync_has_token,
preview_todoist_tasks,
enqueue_todoist_tasks,
sync_todoist_tasks,
get_todoist_sync_status,
```

- [ ] **Step 5: Run command compile check**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo check --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS. If handler wiring fails because async command signatures need concrete argument names, adjust only `src-tauri/src/commands/task_sync.rs` and rerun the same check.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/task_sync/mod.rs src-tauri/src/commands/task_sync.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "feat(todoist): expose task sync commands"
```

---

### Task 7: Todoist Settings UI

**Files:**
- Create: `src/hooks/useTodoistSync.ts`
- Create: `src/hooks/useTodoistSync.test.ts`
- Create: `src/components/settings/TodoistSyncSettings.tsx`
- Create: `src/components/settings/TodoistSyncSettings.test.tsx`
- Modify: `src/pages/SettingsPage/index.tsx`
- Modify: `src/App.settings.test.tsx`

- [ ] **Step 1: Add frontend hook**

Create `src/hooks/useTodoistSync.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { tauriInvoke } from "../lib/tauri";
import type { SecretSaveState } from "../types";

export function useTodoistSync(enabled: boolean) {
  const [hasToken, setHasToken] = useState(false);
  const [tokenState, setTokenState] = useState<SecretSaveState>("unknown");

  const refreshHasToken = useCallback(async () => {
    try {
      const has = await tauriInvoke<boolean>("todoist_sync_has_token");
      setHasToken(Boolean(has));
    } catch {
      setHasToken(false);
    }
  }, []);

  const saveToken = useCallback(
    async (value: string) => {
      try {
        await tauriInvoke("todoist_sync_set_token", { token: value });
        setTokenState("updated");
        await refreshHasToken();
      } catch {
        setTokenState("error");
      }
    },
    [refreshHasToken],
  );

  const clearToken = useCallback(async () => {
    try {
      await tauriInvoke("todoist_sync_clear_token");
      setTokenState("unchanged");
      await refreshHasToken();
    } catch {
      setTokenState("error");
    }
  }, [refreshHasToken]);

  useEffect(() => {
    if (!enabled) return;
    void refreshHasToken();
  }, [enabled, refreshHasToken]);

  return { hasToken, tokenState, refreshHasToken, saveToken, clearToken };
}

export type UseTodoistSyncReturn = ReturnType<typeof useTodoistSync>;
```

- [ ] **Step 2: Write hook tests**

Create `src/hooks/useTodoistSync.test.ts`:

```ts
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTodoistSync } from "./useTodoistSync";

const invokeMock = vi.fn();
vi.mock("../lib/tauri", () => ({
  tauriInvoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

describe("useTodoistSync", () => {
  it("loads token presence when enabled", async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "todoist_sync_has_token") return Promise.resolve(true);
      return Promise.resolve();
    });

    const { result } = renderHook(() => useTodoistSync(true));

    await waitFor(() => expect(result.current.hasToken).toBe(true));
  });

  it("saves token through todoist command", async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "todoist_sync_has_token") return Promise.resolve(true);
      if (cmd === "todoist_sync_set_token") return Promise.resolve();
      return Promise.resolve();
    });

    const { result } = renderHook(() => useTodoistSync(true));
    await act(async () => {
      await result.current.saveToken("abc");
    });

    expect(invokeMock).toHaveBeenCalledWith("todoist_sync_set_token", { token: "abc" });
    expect(result.current.tokenState).toBe("updated");
  });
});
```

- [ ] **Step 3: Add settings component**

Create `src/components/settings/TodoistSyncSettings.tsx`:

```tsx
import { useState } from "react";
import { Button, Checkbox, Flex, Form, Input, Tag } from "antd";
import type { PublicSettings } from "../../types";
import type { UseTodoistSyncReturn } from "../../hooks/useTodoistSync";

type Props = {
  settings: PublicSettings;
  setSettings: (settings: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  todoistSync: UseTodoistSyncReturn;
};

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

export function TodoistSyncSettings({ settings, setSettings, isDirty, todoistSync }: Props) {
  const [tokenInput, setTokenInput] = useState("");
  const fieldsDisabled = !settings.todoist_sync_enabled;
  const tokenBadge = todoistSync.tokenState === "error"
    ? <Tag color="red">Error</Tag>
    : todoistSync.hasToken
      ? <Tag color="green">Saved</Tag>
      : <Tag>Not set</Tag>;

  async function saveToken() {
    if (!tokenInput.trim()) return;
    await todoistSync.saveToken(tokenInput.trim());
    setTokenInput("");
  }

  return (
    <Form layout="vertical" style={{ maxWidth: 760 }}>
      <Form.Item>
        <Checkbox
          id="todoist_sync_enabled"
          aria-label="Enable Todoist sync"
          checked={Boolean(settings.todoist_sync_enabled)}
          onChange={(event) =>
            setSettings({ ...settings, todoist_sync_enabled: event.target.checked })
          }
        >
          Enable Todoist sync{isDirty("todoist_sync_enabled") && dirtyDot}
        </Checkbox>
      </Form.Item>

      <Form.Item label={<label htmlFor="todoist_api_token">API token</label>}>
        <Flex gap={8} align="center" wrap="wrap">
          <Input.Password
            id="todoist_api_token"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            style={{ flex: "1 1 260px" }}
          />
          <Button type="primary" onClick={() => void saveToken()}>
            Save token
          </Button>
          {tokenBadge}
        </Flex>
      </Form.Item>

      <Form.Item>
        <Checkbox
          id="todoist_auto_add"
          aria-label="Auto-add action items"
          checked={Boolean(settings.todoist_auto_add)}
          disabled={fieldsDisabled || !todoistSync.hasToken}
          onChange={(event) =>
            setSettings({ ...settings, todoist_auto_add: event.target.checked })
          }
        >
          Auto-add action items{isDirty("todoist_auto_add") && dirtyDot}
        </Checkbox>
      </Form.Item>
    </Form>
  );
}
```

- [ ] **Step 4: Wire SettingsPage**

In `src/pages/SettingsPage/index.tsx`:

```ts
import { useTodoistSync } from "../../hooks/useTodoistSync";
import { TodoistSyncSettings } from "../../components/settings/TodoistSyncSettings";
```

Inside component:

```ts
const todoistSync = useTodoistSync(settingsTab === "todoist");
```

Extend `dirtyByTab`:

```ts
todoist:
  isDirty("todoist_sync_enabled") ||
  isDirty("todoist_auto_add"),
```

Add tab item:

```tsx
{
  key: "todoist" as SettingsTab,
  label: <>Todoist{dirtyByTab.todoist && dirtyDot}</>,
  children: (
    <TodoistSyncSettings
      settings={settings}
      setSettings={setSettings}
      isDirty={isDirty}
      todoistSync={todoistSync}
    />
  ),
},
```

- [ ] **Step 5: Write UI tests**

Create `src/components/settings/TodoistSyncSettings.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TodoistSyncSettings } from "./TodoistSyncSettings";
import type { PublicSettings } from "../../types";

function settings(): PublicSettings {
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
    apple_speech_locale: "ru_RU",
    summary_url: "",
    summary_prompt: "",
    openai_model: "gpt-5.1-codex-mini",
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
    show_minitray_overlay: false,
    todoist_sync_enabled: false,
    todoist_auto_add: false,
  };
}

describe("TodoistSyncSettings", () => {
  it("disables auto-add when token is missing", () => {
    render(
      <TodoistSyncSettings
        settings={{ ...settings(), todoist_sync_enabled: true }}
        setSettings={vi.fn()}
        isDirty={() => false}
        todoistSync={{
          hasToken: false,
          tokenState: "unknown",
          refreshHasToken: vi.fn(),
          saveToken: vi.fn(),
          clearToken: vi.fn(),
        }}
      />,
    );

    expect(screen.getByLabelText("Auto-add action items")).toBeDisabled();
  });

  it("saves token through hook", async () => {
    const saveToken = vi.fn().mockResolvedValue(undefined);
    render(
      <TodoistSyncSettings
        settings={{ ...settings(), todoist_sync_enabled: true }}
        setSettings={vi.fn()}
        isDirty={() => false}
        todoistSync={{
          hasToken: true,
          tokenState: "unknown",
          refreshHasToken: vi.fn(),
          saveToken,
          clearToken: vi.fn(),
        }}
      />,
    );

    await userEvent.type(screen.getByLabelText("API token"), "abc");
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));

    expect(saveToken).toHaveBeenCalledWith("abc");
  });
});
```

- [ ] **Step 6: Run frontend tests**

Run:

```bash
npm test -- TodoistSyncSettings useTodoistSync
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useTodoistSync.ts src/hooks/useTodoistSync.test.ts src/components/settings/TodoistSyncSettings.tsx src/components/settings/TodoistSyncSettings.test.tsx src/pages/SettingsPage/index.tsx src/App.settings.test.tsx
git commit -m "feat(todoist): add sync settings UI"
```

---

### Task 8: Todoist Export Modal And Session UI

**Files:**
- Create: `src/hooks/useTodoistTasks.ts`
- Create: `src/components/sessions/TodoistExportModal.tsx`
- Create: `src/components/sessions/TodoistExportModal.test.tsx`
- Modify: `src/components/sessions/SessionCard.tsx`
- Modify: `src/components/sessions/SessionList.tsx`
- Modify: `src/hooks/useSessions.ts`
- Modify: `src/types/index.ts`
- Modify: `src/components/sessions/SessionList.test.tsx`

- [ ] **Step 1: Add frontend DTOs**

In `src/types/index.ts`, add:

```ts
export type TaskSyncStatus = "new" | "queued" | "synced" | "failed" | "skipped";

export type TodoistActionItem = {
  id: string;
  provider: "todoist";
  title: string;
  description?: string | null;
  due?: string | null;
  priority?: number | null;
  assignee?: string | null;
  context?: string | null;
  sourceSessionId: string;
  sourceFilePath: string;
  status: TaskSyncStatus;
  externalTaskId?: string | null;
  error?: string | null;
};

export type TodoistTaskPreview = {
  sessionId: string;
  summaryPath: string;
  warnings: string[];
  items: TodoistActionItem[];
};

export type TodoistTaskSyncResult = {
  synced: number;
  failed: number;
};
```

- [ ] **Step 2: Add session hook**

Create `src/hooks/useTodoistTasks.ts`:

```ts
import { useCallback, useState } from "react";
import { tauriInvoke } from "../lib/tauri";
import type { TodoistTaskPreview, TodoistTaskSyncResult } from "../types";

export function useTodoistTasks() {
  const [preview, setPreview] = useState<TodoistTaskPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const openPreview = useCallback(async (sessionId: string) => {
    setLoading(true);
    try {
      const next = await tauriInvoke<TodoistTaskPreview>("preview_todoist_tasks", { sessionId });
      setPreview(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, []);

  const closePreview = useCallback(() => setPreview(null), []);

  const enqueueAndSync = useCallback(async (sessionId: string, taskIds: string[]) => {
    setSyncing(true);
    try {
      await tauriInvoke("enqueue_todoist_tasks", { sessionId, taskIds });
      const result = await tauriInvoke<TodoistTaskSyncResult>("sync_todoist_tasks", { sessionId });
      const refreshed = await tauriInvoke<TodoistTaskPreview>("preview_todoist_tasks", { sessionId });
      setPreview(refreshed);
      return result;
    } finally {
      setSyncing(false);
    }
  }, []);

  return { preview, loading, syncing, openPreview, closePreview, enqueueAndSync };
}
```

- [ ] **Step 3: Add modal component**

Create `src/components/sessions/TodoistExportModal.tsx`:

```tsx
import { useMemo, useState } from "react";
import { Alert, Button, Checkbox, Modal, Space, Tag } from "antd";
import type { TodoistTaskPreview } from "../../types";

type Props = {
  preview: TodoistTaskPreview | null;
  open: boolean;
  syncing: boolean;
  onCancel: () => void;
  onAddSelected: (taskIds: string[]) => Promise<void> | void;
};

export function TodoistExportModal({ preview, open, syncing, onCancel, onAddSelected }: Props) {
  const selectableIds = useMemo(
    () => preview?.items.filter((item) => item.status !== "synced").map((item) => item.id) ?? [],
    [preview],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const ids = selectedIds.length > 0 ? selectedIds : selectableIds;
  const hasItems = Boolean(preview && preview.items.length > 0);

  return (
    <Modal
      title="Export to Todoist"
      open={open}
      onCancel={onCancel}
      footer={[
        <Button key="skip" onClick={onCancel}>Skip</Button>,
        <Button key="all" disabled={!selectableIds.length} loading={syncing} onClick={() => void onAddSelected(selectableIds)}>
          Add all
        </Button>,
        <Button key="selected" type="primary" disabled={!ids.length} loading={syncing} onClick={() => void onAddSelected(ids)}>
          Add selected
        </Button>,
      ]}
    >
      {preview?.warnings.map((warning) => (
        <Alert key={warning} type="warning" message={warning} style={{ marginBottom: 8 }} />
      ))}
      {!hasItems && <Alert type="info" message="No action items found in this summary." />}
      <Space direction="vertical" style={{ width: "100%" }}>
        {preview?.items.map((item) => {
          const disabled = item.status === "synced";
          return (
            <div key={item.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <Checkbox
                checked={selectedIds.includes(item.id)}
                disabled={disabled}
                onChange={(event) => {
                  setSelectedIds((prev) =>
                    event.target.checked
                      ? [...prev, item.id]
                      : prev.filter((id) => id !== item.id),
                  );
                }}
                aria-label={`Select ${item.title}`}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{item.title}</div>
                <Space wrap size={4}>
                  {item.due && <Tag>{item.due}</Tag>}
                  {item.priority && <Tag>p{item.priority}</Tag>}
                  <Tag>{item.status}</Tag>
                </Space>
                {item.context && <div style={{ color: "#666", marginTop: 4 }}>{item.context}</div>}
                {item.error && <Alert type="error" message={item.error} style={{ marginTop: 6 }} />}
              </div>
            </div>
          );
        })}
      </Space>
    </Modal>
  );
}
```

- [ ] **Step 4: Write modal tests**

Create `src/components/sessions/TodoistExportModal.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TodoistExportModal } from "./TodoistExportModal";
import type { TodoistTaskPreview } from "../../types";

function preview(): TodoistTaskPreview {
  return {
    sessionId: "session-1",
    summaryPath: "/tmp/session/summary.md",
    warnings: [],
    items: [
      {
        id: "id-1",
        provider: "todoist",
        title: "Task one",
        description: null,
        due: "2026-06-05",
        priority: 3,
        assignee: null,
        context: "Context",
        sourceSessionId: "session-1",
        sourceFilePath: "/tmp/session/summary.md",
        status: "new",
        externalTaskId: null,
        error: null,
      },
      {
        id: "id-2",
        provider: "todoist",
        title: "Already synced",
        description: null,
        due: null,
        priority: 1,
        assignee: null,
        context: null,
        sourceSessionId: "session-1",
        sourceFilePath: "/tmp/session/summary.md",
        status: "synced",
        externalTaskId: "todoist-1",
        error: null,
      },
    ],
  };
}

describe("TodoistExportModal", () => {
  it("submits selected unsynced task IDs", async () => {
    const onAddSelected = vi.fn();
    render(
      <TodoistExportModal
        preview={preview()}
        open
        syncing={false}
        onCancel={vi.fn()}
        onAddSelected={onAddSelected}
      />,
    );

    await userEvent.click(screen.getByLabelText("Select Task one"));
    await userEvent.click(screen.getByRole("button", { name: "Add selected" }));

    expect(onAddSelected).toHaveBeenCalledWith(["id-1"]);
  });

  it("does not select already synced tasks through add all", async () => {
    const onAddSelected = vi.fn();
    render(
      <TodoistExportModal
        preview={preview()}
        open
        syncing={false}
        onCancel={vi.fn()}
        onAddSelected={onAddSelected}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add all" }));

    expect(onAddSelected).toHaveBeenCalledWith(["id-1"]);
  });
});
```

- [ ] **Step 5: Add SessionCard export action**

In `src/components/sessions/SessionCard.tsx`, add import:

```ts
import { CheckSquareOutlined } from "@ant-design/icons";
```

Extend props:

```ts
onExportTodoist: (sessionId: string) => void;
todoistPending: boolean;
```

Destructure them in `SessionCardImpl`.

Add this icon button in `.session-card-icon-actions` when `item.has_summary_text`:

```tsx
{item.has_summary_text && (
  <Button
    htmlType="button"
    type="text"
    size="small"
    shape="circle"
    className="session-todoist-export-button"
    aria-label="Export action items to Todoist"
    title="Export action items to Todoist"
    loading={todoistPending}
    icon={<CheckSquareOutlined aria-hidden="true" style={{ color: "gray" }} />}
    onClick={() => onExportTodoist(item.session_id)}
  />
)}
```

- [ ] **Step 6: Wire SessionList and hook**

In `src/components/sessions/SessionList.tsx`, import:

```ts
import { useTodoistTasks } from "../../hooks/useTodoistTasks";
import { TodoistExportModal } from "./TodoistExportModal";
```

Inside `SessionList`:

```ts
const todoistTasks = useTodoistTasks();
const [todoistPendingSessionId, setTodoistPendingSessionId] = useState<string | null>(null);

async function openTodoistExport(sessionId: string) {
  setTodoistPendingSessionId(sessionId);
  try {
    await todoistTasks.openPreview(sessionId);
  } catch (err) {
    setStatus(`error: ${getErrorMessage(err)}`);
  } finally {
    setTodoistPendingSessionId(null);
  }
}

async function addTodoistTasks(taskIds: string[]) {
  const sessionId = todoistTasks.preview?.sessionId;
  if (!sessionId) return;
  try {
    const result = await todoistTasks.enqueueAndSync(sessionId, taskIds);
    setStatus(`todoist_synced: ${result.synced} synced, ${result.failed} failed`);
  } catch (err) {
    setStatus(`error: ${getErrorMessage(err)}`);
  }
}
```

Pass props to `SessionCard`:

```tsx
onExportTodoist={(sessionId) => void openTodoistExport(sessionId)}
todoistPending={todoistPendingSessionId === item.session_id}
```

Render modal near existing modals:

```tsx
<TodoistExportModal
  preview={todoistTasks.preview}
  open={Boolean(todoistTasks.preview)}
  syncing={todoistTasks.syncing}
  onCancel={todoistTasks.closePreview}
  onAddSelected={(taskIds) => void addTodoistTasks(taskIds)}
/>
```

- [ ] **Step 7: Run frontend tests**

Run:

```bash
npm test -- TodoistExportModal SessionList
```

Expected: PASS after updating existing SessionCard/SessionList test props for the new required props.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useTodoistTasks.ts src/components/sessions/TodoistExportModal.tsx src/components/sessions/TodoistExportModal.test.tsx src/components/sessions/SessionCard.tsx src/components/sessions/SessionList.tsx src/hooks/useSessions.ts src/types/index.ts src/components/sessions/SessionList.test.tsx
git commit -m "feat(todoist): add action item export modal"
```

---

### Task 9: End-To-End Verification And Polish

**Files:**
- Review all files changed in Tasks 1-8.
- Modify only files needed to fix compile/test failures.

- [ ] **Step 1: Run full Rust tests**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS with Vite build output.

- [ ] **Step 4: Run Rust compile check**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo check --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 5: Manual local smoke check**

Run app:

```bash
npm run dev
```

Open Settings, confirm the Todoist tab appears, save a fake token, and confirm the tab shows `Saved`. Use an existing session with summary text, click the Todoist export icon, and confirm the modal opens. Do not send a real Todoist request unless a valid token is intentionally configured.

- [ ] **Step 6: Commit verification fixes**

If Step 1-5 required code changes:

```bash
git add src src-tauri
git commit -m "fix(todoist): polish task sync flow"
```

If Step 1-5 required no code changes, skip this commit.
