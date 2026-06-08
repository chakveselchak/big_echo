# Named Summary Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable named summary prompts whose name is the identifier and whose current text is used by every bound session.

**Architecture:** Store prompt definitions in the existing SQLite database and store the selected prompt name in session metadata. Keep backend prompt resolution authoritative: summary generation resolves explicit run override, then named prompt, then legacy freeform prompt, then settings default. The frontend modal becomes a two-column named prompt editor that can convert legacy freeform prompts into named prompts or bind sessions to existing names.

**Tech Stack:** Rust/Tauri, rusqlite, serde JSON session metadata, React 18, Ant Design, Vitest, Cargo tests.

---

## File Map

- Modify `src-tauri/src/domain/session.rs`: add `custom_summary_prompt_name` to `SessionMeta` with serde default and initialize it in `SessionMeta::new`.
- Modify `src-tauri/src/app_state.rs`: add `custom_summary_prompt_name` to `UpdateSessionDetailsRequest` and `SessionMetaView`.
- Modify `src-tauri/src/storage/sqlite_repo.rs`: create `summary_prompts` table; add `SummaryPromptView`; add list/upsert/get/delete helpers; include `custom_summary_prompt_name` in `SessionListMeta`.
- Modify `src-tauri/src/commands/sessions.rs`: expose prompt commands; persist session prompt names; clear legacy prompt text when a name is set.
- Modify `src-tauri/src/commands/mod.rs`: export new prompt commands if command modules require explicit re-export.
- Modify `src-tauri/src/main.rs`: register new Tauri commands and add IPC integration tests.
- Modify `src-tauri/src/services/pipeline_runner.rs`: resolve named prompts before summary generation.
- Modify `src/types/index.ts`: add frontend prompt types and `custom_summary_prompt_name`.
- Modify `src/components/sessions/SummaryPromptModal.tsx`: turn modal body into named prompt selector/editor.
- Modify `src/components/sessions/SessionList.tsx`: load prompt library, pass it to modal, save prompt and session binding.
- Modify `src/components/sessions/SessionCard.tsx`: count either prompt name or legacy text as a custom prompt indicator and compare the new field in local draft sync.
- Modify `src/hooks/useSessions.ts`: include the new field in equality, hashing, normalization, save payloads, flush payloads, and summary run behavior.
- Modify `src/index.css`: add two-column modal layout styles.
- Modify `src/App.main.test.tsx`, `src/hooks/useSessions.test.tsx`, and backend Rust tests in touched Rust files.

---

### Task 1: Backend Prompt Library Storage

**Files:**
- Modify: `src-tauri/src/storage/sqlite_repo.rs`

- [ ] **Step 1: Write failing SQLite prompt repository tests**

Append these tests inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/storage/sqlite_repo.rs`. Use the existing `temp_dir()` helper in that test module.

```rust
#[test]
fn summary_prompts_schema_is_created_by_open_connection() {
    let tmp = temp_dir();
    let conn = open_connection(tmp.path()).expect("open sqlite");

    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='summary_prompts'",
            [],
            |row| row.get(0),
        )
        .expect("schema query");

    assert_eq!(exists, 1);
}

#[test]
fn upsert_summary_prompt_creates_and_updates_by_name() {
    let tmp = temp_dir();

    let created = upsert_summary_prompt(tmp.path(), " Decisions ", " First prompt ")
        .expect("create prompt");
    assert_eq!(created.name, "Decisions");
    assert_eq!(created.prompt, "First prompt");
    assert!(!created.created_at_iso.is_empty());
    assert_eq!(created.created_at_iso, created.updated_at_iso);

    let updated = upsert_summary_prompt(tmp.path(), "Decisions", "Updated prompt")
        .expect("update prompt");
    assert_eq!(updated.name, "Decisions");
    assert_eq!(updated.prompt, "Updated prompt");
    assert_eq!(updated.created_at_iso, created.created_at_iso);
    assert!(!updated.updated_at_iso.is_empty());

    let fetched = get_summary_prompt(tmp.path(), "Decisions").expect("get prompt");
    assert_eq!(fetched.prompt, "Updated prompt");
}

#[test]
fn list_summary_prompts_returns_name_order() {
    let tmp = temp_dir();
    upsert_summary_prompt(tmp.path(), "Risks", "Risk prompt").expect("insert risks");
    upsert_summary_prompt(tmp.path(), "Actions", "Action prompt").expect("insert actions");

    let prompts = list_summary_prompts(tmp.path()).expect("list prompts");

    assert_eq!(
        prompts.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        vec!["Actions", "Risks"]
    );
}

#[test]
fn delete_summary_prompt_removes_unused_prompt() {
    let tmp = temp_dir();
    upsert_summary_prompt(tmp.path(), "Actions", "Action prompt").expect("insert");

    delete_summary_prompt(tmp.path(), "Actions").expect("delete");

    let prompts = list_summary_prompts(tmp.path()).expect("list prompts");
    assert!(prompts.is_empty());
}

#[test]
fn summary_prompt_name_and_prompt_are_required() {
    let tmp = temp_dir();

    assert_eq!(
        upsert_summary_prompt(tmp.path(), "   ", "Prompt").expect_err("empty name"),
        "Prompt name is required"
    );
    assert_eq!(
        upsert_summary_prompt(tmp.path(), "Name", "   ").expect_err("empty prompt"),
        "Prompt text is required"
    );
}
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test summary_prompt --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL with missing functions or missing `summary_prompts` table errors.

- [ ] **Step 3: Implement SQLite prompt repository**

In `src-tauri/src/storage/sqlite_repo.rs`, add the view type near the other public structs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SummaryPromptView {
    pub name: String,
    pub prompt: String,
    pub created_at_iso: String,
    pub updated_at_iso: String,
}
```

Extend the `open_connection` `execute_batch` schema with:

```sql
CREATE TABLE IF NOT EXISTS summary_prompts (
    name TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    created_at_iso TEXT NOT NULL,
    updated_at_iso TEXT NOT NULL
);
```

Add repository helpers after `open_connection`:

```rust
fn row_to_summary_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<SummaryPromptView> {
    Ok(SummaryPromptView {
        name: row.get(0)?,
        prompt: row.get(1)?,
        created_at_iso: row.get(2)?,
        updated_at_iso: row.get(3)?,
    })
}

pub fn list_summary_prompts(app_data_dir: &Path) -> Result<Vec<SummaryPromptView>, String> {
    let conn = open(app_data_dir)?;
    let mut stmt = conn
        .prepare(
            "SELECT name, prompt, created_at_iso, updated_at_iso
             FROM summary_prompts
             ORDER BY name COLLATE NOCASE ASC, name ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_summary_prompt)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get_summary_prompt(app_data_dir: &Path, name: &str) -> Result<SummaryPromptView, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Prompt name is required".to_string());
    }
    let conn = open(app_data_dir)?;
    conn.query_row(
        "SELECT name, prompt, created_at_iso, updated_at_iso
         FROM summary_prompts
         WHERE name=?1",
        params![name],
        row_to_summary_prompt,
    )
    .map_err(|err| {
        if matches!(err, rusqlite::Error::QueryReturnedNoRows) {
            format!("Summary prompt not found: {name}")
        } else {
            err.to_string()
        }
    })
}

pub fn upsert_summary_prompt(
    app_data_dir: &Path,
    name: &str,
    prompt: &str,
) -> Result<SummaryPromptView, String> {
    let name = name.trim();
    let prompt = prompt.trim();
    if name.is_empty() {
        return Err("Prompt name is required".to_string());
    }
    if prompt.is_empty() {
        return Err("Prompt text is required".to_string());
    }

    let conn = open(app_data_dir)?;
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "
        INSERT INTO summary_prompts (name, prompt, created_at_iso, updated_at_iso)
        VALUES (?1, ?2, ?3, ?3)
        ON CONFLICT(name) DO UPDATE SET
            prompt=excluded.prompt,
            updated_at_iso=excluded.updated_at_iso
        ",
        params![name, prompt, now],
    )
    .map_err(|e| e.to_string())?;
    get_summary_prompt(app_data_dir, name)
}

pub fn delete_summary_prompt(app_data_dir: &Path, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Prompt name is required".to_string());
    }
    let conn = open(app_data_dir)?;
    let deleted = conn
        .execute("DELETE FROM summary_prompts WHERE name=?1", params![name])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("Summary prompt not found: {name}"));
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run the same command:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test summary_prompt --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS for the new repository tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/sqlite_repo.rs
git commit -m "feat: add summary prompt repository"
```

---

### Task 2: Session Metadata Prompt Name

**Files:**
- Modify: `src-tauri/src/domain/session.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/storage/sqlite_repo.rs`
- Modify: `src-tauri/src/commands/sessions.rs`

- [ ] **Step 1: Write failing metadata tests**

In `src-tauri/src/domain/session.rs`, add:

```rust
#[test]
fn session_meta_defaults_missing_custom_summary_prompt_name_to_empty_string() {
    let raw = r#"{
        "session_id": "legacy",
        "created_at_iso": "2026-06-07T10:00:00+03:00",
        "started_at_iso": "2026-06-07T10:00:00+03:00",
        "ended_at_iso": null,
        "display_date_ru": "07.06.2026",
        "source": "zoom",
        "primary_tag": "zoom",
        "tags": [],
        "notes": "",
        "topic": "Legacy",
        "custom_summary_prompt": "Legacy prompt",
        "num_speakers": null,
        "status": "recorded",
        "artifacts": {
            "audio_file": "audio.opus",
            "transcript_file": "transcript.md",
            "summary_file": "summary.md",
            "meta_file": "meta.json"
        },
        "errors": []
    }"#;

    let meta: SessionMeta = serde_json::from_str(raw).expect("legacy meta");

    assert_eq!(meta.custom_summary_prompt, "Legacy prompt");
    assert_eq!(meta.custom_summary_prompt_name, "");
}
```

In `src-tauri/src/main.rs`, extend `invoke_update_session_details_persists_values` or add a focused test:

```rust
#[test]
fn invoke_update_session_details_persists_prompt_name_and_clears_legacy_prompt() {
    let (app, app_data_dir) = build_test_app();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("webview should be created");
    seed_recorded_session(&app_data_dir, "session-prompt-name");

    let session_dir = app_data_dir.join("sessions").join("session-prompt-name");
    let meta_path = session_dir.join("meta.json");
    let mut meta = load_meta(&meta_path).expect("load meta");
    meta.custom_summary_prompt = "Legacy prompt".to_string();
    save_meta(&meta_path, &meta).expect("save legacy meta");

    get_ipc_response(
        &webview,
        invoke_request(
            "update_session_details",
            json!({
                "payload": {
                    "session_id": "session-prompt-name",
                    "source": "zoom",
                    "notes": "",
                    "custom_summary_prompt": "Legacy prompt",
                    "custom_summary_prompt_name": "Actions",
                    "topic": "Prompt binding",
                    "tags": [],
                    "num_speakers": null
                }
            }),
        ),
    )
    .expect("update details should succeed");

    let saved = load_meta(&meta_path).expect("load saved meta");
    assert_eq!(saved.custom_summary_prompt_name, "Actions");
    assert_eq!(saved.custom_summary_prompt, "");
}
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test custom_summary_prompt_name --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because `custom_summary_prompt_name` does not exist.

- [ ] **Step 3: Add prompt name to Rust models and persistence**

In `src-tauri/src/domain/session.rs`, add the field after `custom_summary_prompt`:

```rust
#[serde(default)]
pub custom_summary_prompt_name: String,
```

Initialize it in `SessionMeta::new`:

```rust
custom_summary_prompt: String::new(),
custom_summary_prompt_name: String::new(),
```

In `src-tauri/src/app_state.rs`, update request and view structs:

```rust
#[serde(default, alias = "customSummaryPromptName")]
pub custom_summary_prompt_name: String,
```

Add the same field to `SessionMetaView`:

```rust
pub custom_summary_prompt_name: String,
```

In `src-tauri/src/storage/sqlite_repo.rs`, add the field to `SessionListMeta`:

```rust
pub custom_summary_prompt_name: String,
```

When building `SessionListMeta`, populate it:

```rust
custom_summary_prompt_name: meta.custom_summary_prompt_name.clone(),
```

In `src-tauri/src/commands/sessions.rs`, populate `SessionMetaView` in `get_session_meta`:

```rust
custom_summary_prompt_name: meta.custom_summary_prompt_name,
```

In `update_session_details_impl`, set prompt fields with the binding rule:

```rust
let prompt_name = payload.custom_summary_prompt_name.trim().to_string();
meta.custom_summary_prompt_name = prompt_name.clone();
meta.custom_summary_prompt = if prompt_name.is_empty() {
    payload.custom_summary_prompt.trim().to_string()
} else {
    String::new()
};
```

Update any test fixture literals that construct `SessionMetaView` or `SessionListMeta` by adding:

```rust
custom_summary_prompt_name: String::new(),
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test custom_summary_prompt_name --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/domain/session.rs src-tauri/src/app_state.rs src-tauri/src/storage/sqlite_repo.rs src-tauri/src/commands/sessions.rs src-tauri/src/main.rs
git commit -m "feat: store session summary prompt name"
```

---

### Task 3: Tauri Commands for Prompt Library

**Files:**
- Modify: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write failing IPC command tests**

In `src-tauri/src/main.rs`, add:

```rust
#[test]
fn invoke_summary_prompt_commands_create_list_update_and_delete() {
    let (app, _app_data_dir) = build_test_app();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("webview should be created");

    let created = get_ipc_response(
        &webview,
        invoke_request(
            "upsert_summary_prompt",
            json!({ "payload": { "name": "Actions", "prompt": "Action prompt" } }),
        ),
    )
    .expect("create prompt")
    .deserialize::<serde_json::Value>()
    .expect("created prompt json");
    assert_eq!(created["name"], "Actions");
    assert_eq!(created["prompt"], "Action prompt");

    let updated = get_ipc_response(
        &webview,
        invoke_request(
            "upsert_summary_prompt",
            json!({ "payload": { "name": "Actions", "prompt": "Updated prompt" } }),
        ),
    )
    .expect("update prompt")
    .deserialize::<serde_json::Value>()
    .expect("updated prompt json");
    assert_eq!(updated["name"], "Actions");
    assert_eq!(updated["prompt"], "Updated prompt");

    let list = get_ipc_response(&webview, invoke_request("list_summary_prompts", json!({})))
        .expect("list prompts")
        .deserialize::<serde_json::Value>()
        .expect("list json");
    assert_eq!(list.as_array().expect("array").len(), 1);
    assert_eq!(list[0]["name"], "Actions");

    let deleted = get_ipc_response(
        &webview,
        invoke_request("delete_summary_prompt", json!({ "name": "Actions" })),
    )
    .expect("delete prompt")
    .deserialize::<String>()
    .expect("deleted string");
    assert_eq!(deleted, "deleted");
}
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test invoke_summary_prompt_commands --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because commands are not registered.

- [ ] **Step 3: Implement command payload and handlers**

In `src-tauri/src/commands/sessions.rs`, update imports:

```rust
use serde::{Deserialize, Serialize};
```

Import prompt helpers:

```rust
delete_summary_prompt as repo_delete_summary_prompt,
list_summary_prompts as repo_list_summary_prompts,
upsert_summary_prompt as repo_upsert_summary_prompt,
SummaryPromptView,
```

Add payload and commands near session details commands:

```rust
#[derive(Debug, Deserialize)]
pub struct UpsertSummaryPromptRequest {
    pub name: String,
    pub prompt: String,
}

#[tauri::command]
pub fn list_summary_prompts(
    dirs: tauri::State<AppDirs>,
) -> Result<Vec<SummaryPromptView>, String> {
    repo_list_summary_prompts(&dirs.app_data_dir)
}

#[tauri::command]
pub fn upsert_summary_prompt(
    dirs: tauri::State<AppDirs>,
    payload: UpsertSummaryPromptRequest,
) -> Result<SummaryPromptView, String> {
    repo_upsert_summary_prompt(&dirs.app_data_dir, &payload.name, &payload.prompt)
}

#[tauri::command]
pub fn delete_summary_prompt(
    dirs: tauri::State<AppDirs>,
    name: String,
) -> Result<String, String> {
    repo_delete_summary_prompt(&dirs.app_data_dir, &name)?;
    Ok("deleted".to_string())
}
```

In `src-tauri/src/main.rs`, add the commands to imports and both `tauri::generate_handler!` lists:

```rust
delete_summary_prompt, list_summary_prompts, upsert_summary_prompt,
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test invoke_summary_prompt_commands --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/sessions.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "feat: expose summary prompt commands"
```

---

### Task 4: Reject Deleting Prompts Used by Sessions

**Files:**
- Modify: `src-tauri/src/storage/sqlite_repo.rs`

- [ ] **Step 1: Write failing delete-in-use test**

In `src-tauri/src/storage/sqlite_repo.rs` tests, add:

```rust
#[test]
fn delete_summary_prompt_rejects_prompt_used_by_session_meta() {
    let tmp = temp_app_data_dir();
    upsert_summary_prompt(tmp.path(), "Actions", "Action prompt").expect("insert prompt");

    let session_dir = tmp.path().join("sessions").join("s-actions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let meta_path = session_dir.join("meta.json");
    let mut meta = SessionMeta::new(
        "s-actions".to_string(),
        "zoom".to_string(),
        vec![],
        "Prompt use".to_string(),
        "".to_string(),
    );
    meta.custom_summary_prompt_name = "Actions".to_string();
    crate::storage::session_store::save_meta(&meta_path, &meta).expect("save meta");
    upsert_session(tmp.path(), &meta, &session_dir, &meta_path).expect("upsert session");

    let err = delete_summary_prompt(tmp.path(), "Actions").expect_err("prompt in use");

    assert_eq!(
        err,
        "Summary prompt is used by 1 session(s): Actions"
    );
}
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test delete_summary_prompt_rejects_prompt_used_by_session_meta --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because deletion currently removes the prompt.

- [ ] **Step 3: Implement in-use scan**

In `src-tauri/src/storage/sqlite_repo.rs`, add:

```rust
fn count_sessions_using_summary_prompt(app_data_dir: &Path, name: &str) -> Result<usize, String> {
    let sessions = list_sessions(app_data_dir)?;
    let mut count = 0usize;
    for item in sessions {
        let Some(meta_path) = get_meta_path(app_data_dir, &item.session_id)? else {
            continue;
        };
        let meta = match load_meta(&meta_path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.custom_summary_prompt_name.trim() == name {
            count += 1;
        }
    }
    Ok(count)
}
```

At the start of `delete_summary_prompt`, before executing `DELETE`, add:

```rust
let used_count = count_sessions_using_summary_prompt(app_data_dir, name)?;
if used_count > 0 {
    return Err(format!(
        "Summary prompt is used by {used_count} session(s): {name}"
    ));
}
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test delete_summary_prompt_rejects_prompt_used_by_session_meta --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/sqlite_repo.rs
git commit -m "fix: protect summary prompts used by sessions"
```

---

### Task 5: Backend Summary Resolution by Prompt Name

**Files:**
- Modify: `src-tauri/src/services/pipeline_runner.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/hooks/useSessions.ts`
- Modify: `src/hooks/useSessions.test.tsx`

- [ ] **Step 1: Write failing backend summary resolution tests**

In `src-tauri/src/main.rs`, add:

```rust
#[test]
fn invoke_run_summary_uses_named_prompt_when_override_is_missing() {
    let (app, app_data_dir) = build_test_app();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("webview should be created");
    let (base_url, requests) = spawn_summary_capture_server();
    seed_pipeline_ready_session(&app_data_dir, "session-summary-named", &base_url);
    let session_dir = app_data_dir.join("sessions").join("session-summary-named");
    std::fs::write(session_dir.join("transcript.txt"), "existing transcript")
        .expect("write transcript");

    storage::sqlite_repo::upsert_summary_prompt(
        &app_data_dir,
        "Actions",
        "Сделай саммари только по задачам",
    )
    .expect("insert prompt");

    let meta_path = session_dir.join("meta.json");
    let mut meta = load_meta(&meta_path).expect("load meta");
    meta.custom_summary_prompt = "Legacy prompt should not be used".to_string();
    meta.custom_summary_prompt_name = "Actions".to_string();
    save_meta(&meta_path, &meta).expect("save meta");

    get_ipc_response(
        &webview,
        invoke_request("run_summary", json!({ "sessionId": "session-summary-named" })),
    )
    .expect("run_summary should succeed");

    let captured = requests.lock().expect("lock requests");
    let request_body = captured[0]
        .split("\r\n\r\n")
        .nth(1)
        .expect("http request body should exist");
    let payload: serde_json::Value =
        serde_json::from_str(request_body).expect("valid json payload");
    assert_eq!(
        payload["messages"][0]["content"].as_str(),
        Some("Сделай саммари только по задачам")
    );
}

#[test]
fn invoke_run_summary_errors_when_named_prompt_is_missing() {
    let (app, app_data_dir) = build_test_app();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("webview should be created");
    let (base_url, _requests) = spawn_summary_capture_server();
    seed_pipeline_ready_session(&app_data_dir, "session-summary-missing-prompt", &base_url);
    let session_dir = app_data_dir
        .join("sessions")
        .join("session-summary-missing-prompt");
    std::fs::write(session_dir.join("transcript.txt"), "existing transcript")
        .expect("write transcript");

    let meta_path = session_dir.join("meta.json");
    let mut meta = load_meta(&meta_path).expect("load meta");
    meta.custom_summary_prompt_name = "Missing".to_string();
    save_meta(&meta_path, &meta).expect("save meta");

    let err = get_ipc_response(
        &webview,
        invoke_request(
            "run_summary",
            json!({ "sessionId": "session-summary-missing-prompt" }),
        ),
    )
    .expect_err("run_summary should fail");

    assert!(err.to_string().contains("Summary prompt not found: Missing"));
}
```

In `src/hooks/useSessions.test.tsx`, add:

```tsx
it("runs summary without passing prompt text when the session uses a named prompt", async () => {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "list_sessions") {
      return [
        {
          session_id: "s-named",
          status: "recorded",
          primary_tag: "zoom",
          topic: "Named prompt",
          display_date_ru: "11.03.2026",
          started_at_iso: "2026-03-11T10:00:00+03:00",
          session_dir: "/tmp/s-named",
          audio_duration_hms: "00:15:20",
          has_transcript_text: true,
          has_summary_text: false,
        },
      ];
    }
    if (cmd === "get_session_meta") {
      return {
        session_id: "s-named",
        source: "zoom",
        notes: "",
        custom_summary_prompt: "",
        custom_summary_prompt_name: "Actions",
        topic: "Named prompt",
        tags: [],
      };
    }
    if (cmd === "list_known_tags") {
      return [];
    }
    return args ?? null;
  });

  const setStatus = vi.fn();
  const setLastSessionId = vi.fn();
  const { result } = renderHook(() =>
    useSessions({ setStatus, lastSessionId: null, setLastSessionId })
  );

  await act(async () => {
    await result.current.loadSessions();
  });

  await act(async () => {
    await result.current.getSummary("s-named");
  });

  expect(invokeMock).toHaveBeenCalledWith("run_summary", { sessionId: "s-named" });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test invoke_run_summary_uses_named_prompt --manifest-path src-tauri/Cargo.toml --bin bigecho
npm test -- src/hooks/useSessions.test.tsx
```

Expected: Rust test FAILS because named prompt is ignored. Frontend test FAILS if `run_summary` still sends prompt text for named sessions or types lack the new field.

- [ ] **Step 3: Resolve named prompts in backend**

In `src-tauri/src/services/pipeline_runner.rs`, import:

```rust
get_summary_prompt,
```

Replace the `summary_prompt_override` construction inside `if needs_summary` with:

```rust
let summary_prompt_override = if let Some(prompt) = custom_summary_prompt
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
{
    Some(prompt.to_string())
} else {
    let prompt_name = meta.custom_summary_prompt_name.trim();
    if !prompt_name.is_empty() {
        Some(get_summary_prompt(&data_dir, prompt_name)?.prompt)
    } else {
        let legacy_prompt = meta.custom_summary_prompt.trim();
        (!legacy_prompt.is_empty()).then(|| legacy_prompt.to_string())
    }
};
```

Keep the explicit `custom_prompt` command argument as the highest priority so existing IPC tests continue to pass.

- [ ] **Step 4: Update frontend summary run behavior**

In `src/hooks/useSessions.ts`, change `getSummary` to pass prompt text only for legacy freeform sessions:

```ts
const detail = sessionDetails[sessionId];
const hasNamedPrompt = Boolean(detail?.custom_summary_prompt_name?.trim());
const legacyPrompt = hasNamedPrompt ? "" : detail?.custom_summary_prompt?.trim() ?? "";
await tauriInvoke<string>(
  "run_summary",
  legacyPrompt ? { sessionId, customPrompt: legacyPrompt } : { sessionId }
);
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test invoke_run_summary_uses_named_prompt --manifest-path src-tauri/Cargo.toml --bin bigecho
npm test -- src/hooks/useSessions.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/services/pipeline_runner.rs src-tauri/src/main.rs src/hooks/useSessions.ts src/hooks/useSessions.test.tsx
git commit -m "feat: resolve named summary prompts"
```

---

### Task 6: Frontend Types and Session State

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/hooks/useSessions.ts`
- Modify: `src/components/sessions/SessionCard.tsx`
- Modify: `src/components/sessions/SessionCard.test.tsx`
- Modify: `src/hooks/useSessions.test.tsx`

- [ ] **Step 1: Write failing state tests**

In `src/components/sessions/SessionCard.test.tsx`, change `makeDetail` so it accepts overrides:

```tsx
function makeDetail(overrides: Partial<SessionMetaView> = {}): SessionMetaView {
  return {
    session_id: "s-brain",
    source: "slack",
    notes: "",
    custom_summary_prompt: "",
    custom_summary_prompt_name: "",
    topic: "Brain sync",
    tags: [],
    num_speakers: null,
    ...overrides,
  };
}
```

Change `renderCard` to accept detail overrides:

```tsx
function renderCard(
  item: SessionListItem,
  onUploadToBrain = vi.fn(),
  brainSyncReady = true,
  detailOverrides: Partial<SessionMetaView> = {},
) {
  const noop = () => undefined;
  const result = render(
    <SessionCard
      item={item}
      detail={makeDetail(detailOverrides)}
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
      onExportTodoist={noop}
      todoistPending={false}
      setStatus={noop}
    />,
  );
  return { ...result, onUploadToBrain };
}
```

Add the test:

```tsx
it("marks the summary prompt button when a session uses a named prompt", () => {
  const { container } = renderCard(makeItem("uploaded"), vi.fn(), true, {
    custom_summary_prompt_name: "Actions",
  });

  expect(container.querySelector(".summary-prompt-dot")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- src/components/sessions/SessionCard.test.tsx src/hooks/useSessions.test.tsx
```

Expected: FAIL because the new field is not part of types/state comparisons.

- [ ] **Step 3: Update frontend types and session state**

In `src/types/index.ts`, add:

```ts
export type SummaryPromptView = {
  name: string;
  prompt: string;
  created_at_iso: string;
  updated_at_iso: string;
};
```

Add to `SessionMetaView`:

```ts
custom_summary_prompt_name?: string;
```

In `src/hooks/useSessions.ts`:

Update `sameSessionMeta`:

```ts
(left.custom_summary_prompt_name ?? "") === (right.custom_summary_prompt_name ?? "") &&
```

Update `sessionMetaSignature`:

```ts
${meta.custom_summary_prompt_name ?? ""}\n
```

Update `normalizeSessionMeta`:

```ts
custom_summary_prompt_name: meta.custom_summary_prompt_name ?? "",
```

Update default detail objects:

```ts
custom_summary_prompt_name: "",
```

Update every `update_session_details` payload:

```ts
custom_summary_prompt_name: detail.custom_summary_prompt_name ?? "",
```

In `src/components/sessions/SessionCard.tsx`:

```ts
const hasCustomSummaryPrompt = Boolean(
  draftDetail.custom_summary_prompt_name?.trim() || draftDetail.custom_summary_prompt?.trim()
);
```

Add `custom_summary_prompt_name` comparisons to both draft-sync comparison blocks:

```ts
(detail.custom_summary_prompt_name ?? "") === (local.custom_summary_prompt_name ?? "") &&
```

and:

```ts
(detail.custom_summary_prompt_name ?? "") === (current.custom_summary_prompt_name ?? "") &&
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npm test -- src/components/sessions/SessionCard.test.tsx src/hooks/useSessions.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/hooks/useSessions.ts src/components/sessions/SessionCard.tsx src/components/sessions/SessionCard.test.tsx src/hooks/useSessions.test.tsx
git commit -m "feat: track named prompt in session state"
```

---

### Task 7: Named Prompt Modal

**Files:**
- Modify: `src/components/sessions/SummaryPromptModal.tsx`
- Modify: `src/components/sessions/SessionList.tsx`
- Modify: `src/index.css`
- Modify: `src/App.main.test.tsx`

- [ ] **Step 1: Write failing modal integration tests**

In `src/App.main.test.tsx`, add these helpers near the new tests:

```tsx
function namedPromptSettings(summaryPrompt: string) {
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
    summary_prompt: summaryPrompt,
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
    brain_sync_enabled: false,
    brain_sync_url: "https://admin.my2brain.ru/api/v1/meetings/upload",
    todoist_sync_enabled: false,
    todoist_auto_add: false,
    show_minitray_overlay: false,
  };
}

function namedPromptSessionListItem(sessionId: string, topic: string) {
  return {
    session_id: sessionId,
    status: "recorded",
    primary_tag: "slack",
    topic,
    display_date_ru: "11.03.2026",
    started_at_iso: "2026-03-11T12:30:00+03:00",
    session_dir: `/tmp/${sessionId}`,
    audio_duration_hms: "00:20:00",
    has_transcript_text: true,
    has_summary_text: false,
    brain_upload_status: "not_uploaded",
  };
}
```

Add these tests:

```tsx
it("lists named prompts, selects one, and binds the session on Ok", async () => {
  const user = userEvent.setup();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_ui_sync_state") {
      return { source: "slack", topic: "", is_recording: false, active_session_id: null };
    }
    if (cmd === "get_settings") {
      return namedPromptSettings("Default summary prompt");
    }
    if (cmd === "list_sessions") {
      return [namedPromptSessionListItem("s-prompt", "Prompt session")];
    }
    if (cmd === "get_session_meta") {
      return {
        session_id: "s-prompt",
        source: "slack",
        notes: "",
        custom_summary_prompt: "",
        custom_summary_prompt_name: "",
        topic: "Prompt session",
        tags: [],
      };
    }
    if (cmd === "list_summary_prompts") {
      return [
        {
          name: "Actions",
          prompt: "Only action items",
          created_at_iso: "2026-06-07T10:00:00+03:00",
          updated_at_iso: "2026-06-07T10:00:00+03:00",
        },
      ];
    }
    if (cmd === "upsert_summary_prompt" || cmd === "update_session_details") {
      return cmd === "upsert_summary_prompt"
        ? {
            name: "Actions",
            prompt: "Only action items",
            created_at_iso: "2026-06-07T10:00:00+03:00",
            updated_at_iso: "2026-06-07T10:00:00+03:00",
          }
        : "updated";
    }
    return null;
  });

  render(<App />);
  await screen.findByText("Prompt session");
  await user.click(screen.getByRole("button", { name: "Настроить промпт саммари" }));

  const dialog = await screen.findByRole("dialog", { name: "Промпт саммари" });
  await user.click(within(dialog).getByRole("button", { name: "Actions" }));

  expect(within(dialog).getByLabelText("Имя промпта")).toHaveValue("Actions");
  expect(within(dialog).getByLabelText("Текст промпта")).toHaveValue("Only action items");

  await user.click(within(dialog).getByRole("button", { name: "Ок" }));

  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("update_session_details", {
      payload: expect.objectContaining({
        session_id: "s-prompt",
        custom_summary_prompt: "",
        custom_summary_prompt_name: "Actions",
      }),
    });
  });
});

it("saves legacy prompt text under a new name before binding the session", async () => {
  const user = userEvent.setup();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_ui_sync_state") {
      return { source: "slack", topic: "", is_recording: false, active_session_id: null };
    }
    if (cmd === "get_settings") {
      return namedPromptSettings("Default summary prompt");
    }
    if (cmd === "list_sessions") {
      return [namedPromptSessionListItem("s-legacy", "Legacy session")];
    }
    if (cmd === "get_session_meta") {
      return {
        session_id: "s-legacy",
        source: "slack",
        notes: "",
        custom_summary_prompt: "Legacy freeform prompt",
        custom_summary_prompt_name: "",
        topic: "Legacy session",
        tags: [],
      };
    }
    if (cmd === "list_summary_prompts") {
      return [];
    }
    if (cmd === "upsert_summary_prompt") {
      return {
        name: "Legacy converted",
        prompt: "Legacy freeform prompt",
        created_at_iso: "2026-06-07T10:00:00+03:00",
        updated_at_iso: "2026-06-07T10:00:00+03:00",
      };
    }
    if (cmd === "update_session_details") {
      return "updated";
    }
    return null;
  });

  render(<App />);
  await screen.findByText("Legacy session");
  await user.click(screen.getByRole("button", { name: "Настроить промпт саммари" }));

  const dialog = await screen.findByRole("dialog", { name: "Промпт саммари" });
  expect(within(dialog).getByLabelText("Текст промпта")).toHaveValue("Legacy freeform prompt");
  await user.type(within(dialog).getByLabelText("Имя промпта"), "Legacy converted");
  await user.click(within(dialog).getByRole("button", { name: "Ок" }));

  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("upsert_summary_prompt", {
      payload: { name: "Legacy converted", prompt: "Legacy freeform prompt" },
    });
  });
  expect(invokeMock).toHaveBeenCalledWith("update_session_details", {
    payload: expect.objectContaining({
      session_id: "s-legacy",
      custom_summary_prompt: "",
      custom_summary_prompt_name: "Legacy converted",
    }),
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test -- src/App.main.test.tsx
```

Expected: FAIL because `list_summary_prompts`, name input, prompt list, and `upsert_summary_prompt` flow are missing.

- [ ] **Step 3: Implement modal props and body state**

In `src/components/sessions/SummaryPromptModal.tsx`, change imports:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Input, Modal } from "antd";
import type { SummaryPromptView } from "../../types";
```

Extend dialog state:

```ts
export type SummaryPromptDialogState = {
  sessionId: string;
  value: string;
  promptName: string;
  saving: boolean;
};
```

Extend props:

```ts
type SummaryPromptModalProps = {
  dialog: SummaryPromptDialogState | null;
  prompts: SummaryPromptView[];
  loadingPrompts: boolean;
  onCancel: () => void;
  onConfirm: (payload: { name: string; prompt: string }) => void;
};
```

Render the body with prompt list:

```tsx
<SummaryPromptModalBody
  key={dialog.sessionId}
  initialValue={dialog.value}
  initialName={dialog.promptName}
  prompts={prompts}
  loadingPrompts={loadingPrompts}
  saving={dialog.saving}
  onCancel={onCancel}
  onConfirm={onConfirm}
/>
```

Replace the body with:

```tsx
function SummaryPromptModalBody({
  initialValue,
  initialName,
  prompts,
  loadingPrompts,
  saving,
  onCancel,
  onConfirm,
}: SummaryPromptModalBodyProps) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState(initialValue);
  const [nameError, setNameError] = useState("");
  const [promptError, setPromptError] = useState("");
  const touchedRef = useRef(false);
  const selectedName = name.trim();
  const sortedPrompts = useMemo(() => prompts, [prompts]);

  useEffect(() => {
    if (touchedRef.current) return;
    setName(initialName);
    setValue(initialValue);
  }, [initialName, initialValue]);

  const selectPrompt = (prompt: SummaryPromptView) => {
    touchedRef.current = true;
    setName(prompt.name);
    setValue(prompt.prompt);
    setNameError("");
    setPromptError("");
  };

  const confirm = () => {
    const nextName = name.trim();
    const nextPrompt = value.trim();
    setNameError(nextName ? "" : "Введите имя промпта");
    setPromptError(nextPrompt ? "" : "Введите текст промпта");
    if (!nextName || !nextPrompt) return;
    onConfirm({ name: nextName, prompt: nextPrompt });
  };

  return (
    <>
      <div className="summary-prompt-editor">
        <div className="summary-prompt-list" aria-label="Сохранённые промпты">
          {sortedPrompts.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={loadingPrompts ? "Загрузка" : "Нет промптов"}
            />
          ) : (
            sortedPrompts.map((prompt) => (
              <button
                key={prompt.name}
                type="button"
                className={
                  prompt.name === selectedName
                    ? "summary-prompt-list-item summary-prompt-list-item-active"
                    : "summary-prompt-list-item"
                }
                onClick={() => selectPrompt(prompt)}
                disabled={saving}
              >
                {prompt.name}
              </button>
            ))
          )}
        </div>
        <div className="summary-prompt-fields">
          <label className="summary-prompt-field">
            <span>Имя промпта</span>
            <Input
              aria-label="Имя промпта"
              value={name}
              status={nameError ? "error" : undefined}
              onChange={(event) => {
                touchedRef.current = true;
                setName(event.target.value);
                setNameError("");
              }}
              disabled={saving}
            />
            {nameError && <span className="summary-prompt-error">{nameError}</span>}
          </label>
          <label className="summary-prompt-field">
            <span>Текст промпта</span>
            <Input.TextArea
              aria-label="Текст промпта"
              rows={10}
              value={value}
              status={promptError ? "error" : undefined}
              onChange={(event) => {
                touchedRef.current = true;
                setValue(event.target.value);
                setPromptError("");
              }}
              disabled={saving}
            />
            {promptError && <span className="summary-prompt-error">{promptError}</span>}
          </label>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
        <Button onClick={onCancel} disabled={saving}>
          Отмена
        </Button>
        <Button type="primary" onClick={confirm} loading={saving}>
          Ок
        </Button>
      </div>
    </>
  );
}
```

Define `SummaryPromptModalBodyProps` to match the props used above.

- [ ] **Step 4: Implement SessionList prompt loading and save flow**

In `src/components/sessions/SessionList.tsx`, import `SummaryPromptView`.

Add state:

```ts
const [summaryPrompts, setSummaryPrompts] = useState<SummaryPromptView[]>([]);
const [summaryPromptsLoading, setSummaryPromptsLoading] = useState(false);
```

Add loader:

```ts
async function loadSummaryPrompts() {
  setSummaryPromptsLoading(true);
  try {
    const prompts = await tauriInvoke<SummaryPromptView[]>("list_summary_prompts");
    setSummaryPrompts(prompts);
    return prompts;
  } catch (err) {
    setStatus(`error: ${getErrorMessage(err)}`);
    return [];
  } finally {
    setSummaryPromptsLoading(false);
  }
}
```

Update `openSummaryPromptDialog` to load prompts and open with the correct name/text:

```ts
async function openSummaryPromptDialog(detail: SessionMetaView) {
  const prompts = await loadSummaryPrompts();
  const promptName = detail.custom_summary_prompt_name?.trim() ?? "";
  const namedPrompt = promptName ? prompts.find((prompt) => prompt.name === promptName) : null;
  if (namedPrompt) {
    setSummaryPromptDialog({
      sessionId: detail.session_id,
      promptName: namedPrompt.name,
      value: namedPrompt.prompt,
      saving: false,
    });
    return;
  }

  const legacyPrompt = detail.custom_summary_prompt?.trim() ?? "";
  if (legacyPrompt) {
    setSummaryPromptDialog({
      sessionId: detail.session_id,
      promptName: "",
      value: detail.custom_summary_prompt ?? "",
      saving: false,
    });
    return;
  }

  const syncDefault = settings?.summary_prompt ?? cachedDefaultPromptRef.current ?? null;
  setSummaryPromptDialog({
    sessionId: detail.session_id,
    promptName: "",
    value: syncDefault ?? "",
    saving: false,
  });

  if (syncDefault === null) {
    const sessionId = detail.session_id;
    void tauriInvoke<PublicSettings>("get_settings")
      .then((currentSettings) => {
        cachedDefaultPromptRef.current = currentSettings.summary_prompt;
        setSummaryPromptDialog((prev) => {
          if (!prev || prev.sessionId !== sessionId) return prev;
          if (prev.value !== "" || prev.promptName !== "") return prev;
          return { ...prev, value: currentSettings.summary_prompt };
        });
      })
      .catch((err) => {
        setStatus(`error: ${getErrorMessage(err)}`);
      });
  }
}
```

Replace `confirmSummaryPrompt(value: string)` with:

```ts
async function confirmSummaryPrompt(payload: { name: string; prompt: string }) {
  if (!summaryPromptDialog) return;
  const current = sessionDetails[summaryPromptDialog.sessionId];
  if (!current) {
    setSummaryPromptDialog(null);
    return;
  }

  setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: true } : prev));
  try {
    const savedPrompt = await tauriInvoke<SummaryPromptView>("upsert_summary_prompt", {
      payload: { name: payload.name, prompt: payload.prompt },
    });
    setSummaryPrompts((prev) => {
      const withoutSaved = prev.filter((prompt) => prompt.name !== savedPrompt.name);
      return [...withoutSaved, savedPrompt].sort((a, b) => a.name.localeCompare(b.name));
    });

    const nextDetail: SessionMetaView = {
      ...current,
      custom_summary_prompt: "",
      custom_summary_prompt_name: savedPrompt.name,
    };
    const saved = await saveSessionDetails(summaryPromptDialog.sessionId, nextDetail);
    if (saved) {
      setSummaryPromptDialog(null);
    } else {
      setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: false } : prev));
    }
  } catch (err) {
    setStatus(`error: ${getErrorMessage(err)}`);
    setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: false } : prev));
  }
}
```

Pass new props to `SummaryPromptModal`:

```tsx
<SummaryPromptModal
  dialog={summaryPromptDialog}
  prompts={summaryPrompts}
  loadingPrompts={summaryPromptsLoading}
  onCancel={() => setSummaryPromptDialog(null)}
  onConfirm={confirmSummaryPrompt}
/>
```

- [ ] **Step 5: Add modal CSS**

In `src/index.css`, change `.summary-prompt-card` to this width:

```css
.summary-prompt-card {
  width: min(860px, calc(100vw - 48px));
}
```

Keep the existing `.summary-prompt-card textarea` rule and add these layout rules below it:

```css
.summary-prompt-editor {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  gap: 16px;
}

.summary-prompt-list {
  min-height: 280px;
  max-height: 420px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 6px;
}

.summary-prompt-list-item {
  width: 100%;
  min-height: 36px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-strong);
  text-align: left;
  padding: 8px 10px;
  cursor: pointer;
}

.summary-prompt-list-item:hover {
  background: var(--surface-muted);
}

.summary-prompt-list-item-active {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.summary-prompt-fields {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
}

.summary-prompt-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summary-prompt-field textarea {
  min-height: 220px;
  resize: vertical;
}

.summary-prompt-error {
  color: #b42318;
  font-size: 12px;
}

@media (max-width: 720px) {
  .summary-prompt-editor {
    grid-template-columns: 1fr;
  }

  .summary-prompt-list {
    min-height: 96px;
    max-height: 160px;
  }
}
```

- [ ] **Step 6: Run tests to verify GREEN**

Run:

```bash
npm test -- src/App.main.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/sessions/SummaryPromptModal.tsx src/components/sessions/SessionList.tsx src/index.css src/App.main.test.tsx
git commit -m "feat: edit named prompts from session modal"
```

---

### Task 8: Full Verification and Cleanup

**Files:**
- Review all touched files
- No new files expected

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test summary_prompt --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 2: Run backend check**

Run:

```bash
env CARGO_TARGET_DIR=/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/target CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo check --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 3: Run focused frontend tests**

Run:

```bash
npm test -- src/App.main.test.tsx src/hooks/useSessions.test.tsx src/components/sessions/SessionCard.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run full frontend test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Manual smoke test in dev app**

Run:

```bash
npm run dev
```

Expected: Vite starts and prints a local URL.

Open the app in the Browser plugin or regular browser and smoke these flows:

1. Open a session prompt modal.
2. Create named prompt `Actions`.
3. Close and reopen the modal.
4. Select `Actions`.
5. Edit the prompt text.
6. Bind another session to `Actions`.
7. Confirm both sessions display the prompt indicator.

- [ ] **Step 6: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intended files changed and no generated artifacts.

- [ ] **Step 7: Final commit if verification-only fixes were needed**

If Task 8 required any fixes, commit them:

```bash
git add src-tauri/src src src-tauri/Cargo.toml src-tauri/Cargo.lock package.json package-lock.json
git commit -m "test: verify named summary prompts"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: SQLite storage, session prompt name, backend resolution, legacy conversion UX, delete-in-use behavior, frontend modal, and tests are all mapped to tasks.
- Placeholder scan: no deferred implementation decisions remain in the plan.
- Type consistency: the canonical field name is `custom_summary_prompt_name` in Rust and TypeScript, with serde alias `customSummaryPromptName` for IPC compatibility.
