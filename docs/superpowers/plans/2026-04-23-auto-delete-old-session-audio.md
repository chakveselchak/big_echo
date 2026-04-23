# Auto-delete old session audio — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings → Generals control that, once enabled, wipes audio files for sessions older than N days based on `ended_at_iso`. Cleanup runs once at app startup via a one-shot effect in `MainPage` and is silent — affected cards lose their `AudioPlayer` after the post-cleanup `loadSessions` refresh.

**Architecture:** Two new fields on `PublicSettings` (Rust struct + TS mirror). A new Tauri command `auto_delete_old_session_audio` iterates the session list, filters by status / audio presence / parseable `ended_at_iso` / cutoff, and reuses a small extracted helper `wipe_session_audio_file` (factored out of the existing `delete_session_audio`). The frontend triggers the IPC once on `MainPage` mount, then the existing `loadSessions` refreshes the cards which already render without the audio player when `audio_file` is empty.

**Tech Stack:** Rust + Tauri 2 backend (chrono for date parsing, rusqlite via `repo_list_sessions`), React 18 + TypeScript + AntD frontend, Vitest + jsdom + RTL.

**Spec:** `docs/superpowers/specs/2026-04-23-auto-delete-old-session-audio-design.md`

---

## File map

| File | Change |
|---|---|
| `src-tauri/src/settings/public_settings.rs` | Add `auto_delete_audio_enabled: bool` and `auto_delete_audio_days: u32` to `PublicSettings`; update `impl Default`; add tests for defaults and serde missing-field handling. |
| `src-tauri/src/commands/sessions.rs` | Extract `wipe_session_audio_file` helper from `delete_session_audio`; add `AutoDeleteSummary` struct + `auto_delete_old_session_audio` command; add tests for the cleanup logic. Update existing test fixture at line 1093 to include the new settings fields. |
| `src-tauri/src/main.rs` | Register `auto_delete_old_session_audio` in both `tauri::generate_handler!` invocations. Update existing test fixtures at lines 527, 538, 848, 901 with the new settings fields. |
| `src-tauri/src/services/pipeline_runner.rs` | Update test fixture at line 399 with new fields. |
| `src-tauri/src/pipeline/mod.rs` | Update 9 test fixtures (lines 1300, 1371, 1470, 1600, 1702, 1821, 1987, 2053, 2102) with new fields. |
| `src/types/index.ts` | Add `auto_delete_audio_enabled: boolean` and `auto_delete_audio_days: number` to `PublicSettings`. |
| `src/components/settings/GeneralSettings.tsx` | Add `Form.Item` after the Artifact opener select with checkbox + InputNumber + tooltip. |
| `src/pages/SettingsPage/index.tsx` | Add the two new fields to `dirtyByTab.generals`. |
| `src/pages/MainPage/index.tsx` | One-shot `useEffect` calling `auto_delete_old_session_audio` then `loadSessions`. |
| `src/App.main.test.tsx` | Add `auto_delete_old_session_audio` to the default IPC mock; add fields to all 12 settings fixtures (lines 44, 449, 654, 812, 937, 1032, 1132, 1243, 1430, 1513, 1575); add a test that the IPC fires exactly once at startup. |
| `src/App.tray.test.tsx` | Add fields to 4 settings fixtures (lines 70, 274, 311, 395). |
| `src/App.settings.test.tsx` | Add fields to settings fixtures at lines 29, 129, 470. |
| `src/hooks/useSettingsForm.test.tsx` | Add fields to settings fixture at line 24. |

---

## Task 1: Settings field additions + fixture propagation

**Files:**
- Modify: `src-tauri/src/settings/public_settings.rs`
- Modify: `src/types/index.ts`
- Modify: every test fixture site listed in the file map above (Rust + TS).

- [ ] **Step 1: Add fields to the Rust struct + Default**

In `src-tauri/src/settings/public_settings.rs`, add the two fields at the bottom of the struct (line 41 area, just after `api_call_logging_enabled`):

```rust
pub struct PublicSettings {
    // ...existing fields, ending with...
    pub auto_run_pipeline_on_stop: bool,
    pub api_call_logging_enabled: bool,
    pub auto_delete_audio_enabled: bool,
    pub auto_delete_audio_days: u32,
}
```

Update `impl Default for PublicSettings` (line 44 area), at the bottom of the struct literal (after `api_call_logging_enabled: false,`):

```rust
            auto_run_pipeline_on_stop: false,
            api_call_logging_enabled: false,
            auto_delete_audio_enabled: false,
            auto_delete_audio_days: 30,
```

- [ ] **Step 2: Add tests for the new defaults + serde missing-field handling**

Append inside the existing `mod tests` block in `src-tauri/src/settings/public_settings.rs` (before the closing `}`):

```rust
    #[test]
    fn auto_delete_audio_is_disabled_by_default_with_30_days() {
        let settings = PublicSettings::default();
        assert!(!settings.auto_delete_audio_enabled);
        assert_eq!(settings.auto_delete_audio_days, 30);
    }

    #[test]
    fn missing_auto_delete_audio_fields_use_defaults() {
        // Older settings.json that predates the auto-delete feature must
        // deserialize without complaint and pick up the documented defaults.
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
            "api_call_logging_enabled":false
        }"#;
        let parsed: PublicSettings =
            serde_json::from_str(body).expect("settings should parse");
        assert!(!parsed.auto_delete_audio_enabled);
        assert_eq!(parsed.auto_delete_audio_days, 30);
    }
```

- [ ] **Step 3: Run the new tests — they should pass immediately**

Run: `cd src-tauri && cargo test settings::public_settings::tests::auto_delete_audio_is_disabled_by_default_with_30_days settings::public_settings::tests::missing_auto_delete_audio_fields_use_defaults --no-fail-fast`
Expected: 2 passed.

- [ ] **Step 4: Build the Rust crate to discover every literal `PublicSettings { ... }` site that now fails to compile**

Run: `cd src-tauri && cargo build --tests 2>&1 | grep "missing structure fields\|missing field" | head -30`
Expected output: a list of compile errors at the fixture sites in `commands/sessions.rs:1093`, `main.rs` (lines 527, 538, 848, 901), `services/pipeline_runner.rs:399`, and `pipeline/mod.rs` (9 sites). All complain about the two missing fields.

- [ ] **Step 5: Fix every Rust `PublicSettings { ... }` fixture site by adding the two new fields**

For each file/line listed in step 4, add these two lines immediately after the existing `api_call_logging_enabled: false,` line in that fixture (the literal value `false` and `30u32` is what every test wants — none of these fixtures exercise the auto-delete path):

```rust
            auto_delete_audio_enabled: false,
            auto_delete_audio_days: 30,
```

Specifically:
- `src-tauri/src/commands/sessions.rs` — 1 fixture (around line 1093)
- `src-tauri/src/main.rs` — 4 fixtures (around lines 527, 538, 848, 901)
- `src-tauri/src/services/pipeline_runner.rs` — 1 fixture (around line 399)
- `src-tauri/src/pipeline/mod.rs` — 9 fixtures (around lines 1300, 1371, 1470, 1600, 1702, 1821, 1987, 2053, 2102)

Use `grep -n "api_call_logging_enabled: false," src-tauri/src/...` to confirm each site, then `Edit` to add the two new lines. Whitespace must match the surrounding indentation (typically 12 spaces).

- [ ] **Step 6: Build again to confirm all Rust fixtures compile**

Run: `cd src-tauri && cargo build --tests 2>&1 | tail -5`
Expected: build succeeds with no errors (warnings about unused fields in tests are fine).

- [ ] **Step 7: Run the full Rust test suite**

Run: `cd src-tauri && cargo test --no-fail-fast 2>&1 | tail -20`
Expected: all tests pass. Existing tests are unaffected by the field addition; only the two new tests from step 2 are extra.

- [ ] **Step 8: Add the fields to the TS type**

In `src/types/index.ts`, append two fields to the `PublicSettings` type literal (just before the closing `};` after `api_call_logging_enabled: boolean;`):

```ts
export type PublicSettings = {
  // ...existing fields, ending with...
  auto_run_pipeline_on_stop: boolean;
  api_call_logging_enabled: boolean;
  auto_delete_audio_enabled: boolean;
  auto_delete_audio_days: number;
};
```

- [ ] **Step 9: Update every TS test fixture mock that builds a `PublicSettings`-shaped object**

Use `grep -rn "auto_run_pipeline_on_stop" src/` to find each site. For every `auto_run_pipeline_on_stop: false,` followed by `api_call_logging_enabled: <bool>,` block in test fixtures, add immediately after `api_call_logging_enabled: <bool>,`:

```ts
          auto_delete_audio_enabled: false,
          auto_delete_audio_days: 30,
```

(Indentation must match — typically 10 or 12 spaces.) Files:

- `src/App.main.test.tsx` — 12 sites (lines 44, 449, 654, 812, 937, 1032, 1132, 1243, 1430, 1513, 1575, plus `app_call_logging_enabled` surroundings)
- `src/App.tray.test.tsx` — 4 sites (lines 70, 274, 311, 395)
- `src/App.settings.test.tsx` — 3 sites (lines 29, 129, 470)
- `src/hooks/useSettingsForm.test.tsx` — 1 site (line 24)

- [ ] **Step 10: Run the frontend test suite**

Run: `npm test 2>&1 | tail -10`
Expected: full suite green (was 121 passing as of branch HEAD; should still be 121 — fixture additions don't change behavior).

- [ ] **Step 11: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | tail -5`
Expected: clean (no output).

- [ ] **Step 12: Commit**

```bash
git add src-tauri/src/settings/public_settings.rs src-tauri/src/commands/sessions.rs src-tauri/src/main.rs src-tauri/src/services/pipeline_runner.rs src-tauri/src/pipeline/mod.rs src/types/index.ts src/App.main.test.tsx src/App.tray.test.tsx src/App.settings.test.tsx src/hooks/useSettingsForm.test.tsx
git commit -m "$(cat <<'EOF'
feat(settings): add auto_delete_audio_enabled + auto_delete_audio_days

Add the two new persisted settings fields (default disabled, 30 days),
update Rust Default + serde-default tests, mirror the TS type, and
backfill all existing test fixtures so the new struct fields don't
trip compile errors. No behavior wired yet — that lands in subsequent
commits.
EOF
)"
```

---

## Task 2: Backend cleanup logic

**Files:**
- Modify: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add chrono imports to commands/sessions.rs**

In `src-tauri/src/commands/sessions.rs`, change the existing chrono import line (currently `use chrono::{Duration, Local};`) to:

```rust
use chrono::{DateTime, Duration, Local, Utc};
```

- [ ] **Step 2: Extract the audio-wipe helper from `delete_session_audio`**

Locate the existing `delete_session_audio` function (around line 552). Insert the new helper **immediately above** it, then refactor `delete_session_audio` to use it.

New helper:

```rust
/// Removes the audio file for a session and clears `meta.artifacts.audio_file`
/// so the frontend hides the audio player on next list refresh. Pure file +
/// metadata work — does NOT check whether the session is currently being
/// recorded; the caller is responsible for that guard.
pub fn wipe_session_audio_file(
    app_data_dir: &Path,
    session_id: &str,
) -> Result<(), String> {
    let session_dir = get_session_dir(app_data_dir, session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta_path = get_meta_path(app_data_dir, session_id)?
        .ok_or_else(|| "Session metadata not found".to_string())?;
    let mut meta = load_meta(&meta_path)?;

    let audio_file_name = meta.artifacts.audio_file.trim().to_string();
    if !audio_file_name.is_empty() {
        let audio_path = session_dir.join(&audio_file_name);
        if audio_path.exists() {
            fs::remove_file(&audio_path).map_err(|e| e.to_string())?;
        }
    }

    meta.artifacts.audio_file = String::new();
    save_meta(&meta_path, &meta)?;
    Ok(())
}
```

Replace the body of `delete_session_audio` (keep the signature and the active-session guard) with a single call to the helper. Final shape:

```rust
#[tauri::command]
pub fn delete_session_audio(
    dirs: tauri::State<AppDirs>,
    state: tauri::State<AppState>,
    session_id: String,
) -> Result<(), String> {
    let active_session_id = state
        .active_session
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .as_ref()
        .map(|meta| meta.session_id.clone());
    if active_session_id.as_deref() == Some(session_id.as_str()) {
        return Err("Cannot delete audio of active recording session".to_string());
    }

    wipe_session_audio_file(&dirs.app_data_dir, &session_id)
}
```

- [ ] **Step 3: Sanity-check the refactor compiles and existing tests still pass**

Run: `cd src-tauri && cargo test --test command_flow_integration --no-fail-fast 2>&1 | tail -10`
Expected: all tests pass. The refactor is semantically a no-op for `delete_session_audio`.

- [ ] **Step 4: Add `AutoDeleteSummary` struct**

In `src-tauri/src/commands/sessions.rs`, immediately above the new `wipe_session_audio_file` helper, add:

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AutoDeleteSummary {
    pub deleted: u32,
    pub scanned: u32,
}
```

- [ ] **Step 5: Add the pure sweep helper `run_auto_delete_audio_sweep`**

Append at the end of `src-tauri/src/commands/sessions.rs` (before the `#[cfg(test)] mod tests` block). The helper is `pub(crate)` so tests can call it directly; the Tauri command (next step) is a thin wiring layer.

```rust
/// Pure sweep over the session DB: deletes audio for sessions whose
/// `ended_at_iso` is older than `cutoff`, skipping the active recording
/// (if any), Recording-status sessions, sessions without audio, and
/// sessions whose ended_at_iso is missing or unparseable. Per-session
/// errors are logged via eprintln! and do NOT abort the sweep.
pub(crate) fn run_auto_delete_audio_sweep(
    app_data_dir: &Path,
    cutoff: DateTime<Utc>,
    active_session_id: Option<&str>,
) -> Result<AutoDeleteSummary, String> {
    let sessions = repo_list_sessions(app_data_dir)?;
    let mut summary = AutoDeleteSummary { deleted: 0, scanned: 0 };
    for session in sessions {
        summary.scanned += 1;
        if active_session_id == Some(session.session_id.as_str()) {
            continue;
        }
        let meta_path = match get_meta_path(app_data_dir, &session.session_id) {
            Ok(Some(p)) => p,
            _ => continue,
        };
        let meta = match load_meta(&meta_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.status == SessionStatus::Recording {
            continue;
        }
        if meta.artifacts.audio_file.trim().is_empty() {
            continue;
        }
        let ended_at = match meta.ended_at_iso.as_deref() {
            Some(s) => match DateTime::parse_from_rfc3339(s) {
                Ok(dt) => dt.with_timezone(&Utc),
                Err(_) => continue,
            },
            None => continue,
        };
        if ended_at >= cutoff {
            continue;
        }
        match wipe_session_audio_file(app_data_dir, &session.session_id) {
            Ok(()) => summary.deleted += 1,
            Err(err) => {
                eprintln!(
                    "auto_delete_old_session_audio: failed for {}: {}",
                    session.session_id, err
                );
            }
        }
    }
    Ok(summary)
}
```

Then add the Tauri command immediately below the helper:

```rust
/// Triggered once per app launch from MainPage. Reads settings, computes
/// the cutoff timestamp, and delegates to `run_auto_delete_audio_sweep`.
#[tauri::command]
pub fn auto_delete_old_session_audio(
    dirs: tauri::State<AppDirs>,
    state: tauri::State<AppState>,
) -> Result<AutoDeleteSummary, String> {
    let settings = get_settings_from_dirs(dirs.inner())?;
    if !settings.auto_delete_audio_enabled {
        return Ok(AutoDeleteSummary { deleted: 0, scanned: 0 });
    }
    let days = settings.auto_delete_audio_days as i64;
    if days <= 0 {
        return Ok(AutoDeleteSummary { deleted: 0, scanned: 0 });
    }
    let cutoff = Utc::now() - Duration::days(days);

    let active_session_id = state
        .active_session
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .as_ref()
        .map(|meta| meta.session_id.clone());

    run_auto_delete_audio_sweep(
        &dirs.app_data_dir,
        cutoff,
        active_session_id.as_deref(),
    )
}
```

- [ ] **Step 6: Register the new command in `main.rs`**

In `src-tauri/src/main.rs`, add `auto_delete_old_session_audio` to the imports near `delete_session_audio` (around line 25):

```rust
use crate::commands::sessions::{
    /* ...existing imports... */
    auto_delete_old_session_audio,
    delete_session,
    delete_session_audio,
    /* ... */
};
```

(Keep the existing block — just add the new identifier in alphabetical position.)

Then in **both** `tauri::generate_handler!` invocations (around lines 453 and 648), add `auto_delete_old_session_audio,` next to `delete_session_audio,` so the command is registered for both windows.

- [ ] **Step 7: Add tests for the cleanup logic**

Append inside the existing `mod tests` block in `src-tauri/src/commands/sessions.rs` (before its closing `}`). The tests use the existing `tempdir()` + `upsert_session` + `save_meta` pattern visible in the file's other tests.

Add these helper imports at the top of the `mod tests` block (alongside existing `use super::*;` etc.) if not already present:

```rust
    use crate::storage::sqlite_repo::upsert_session;
    use crate::storage::session_store::save_meta;
    use chrono::{Duration as ChronoDuration, Utc};
```

Then the test cases:

```rust
    fn write_session_with_audio(
        app_data_dir: &Path,
        recording_root: &Path,
        session_id: &str,
        ended_at: Option<chrono::DateTime<Utc>>,
        status: SessionStatus,
        audio_file: &str,
    ) {
        let session_dir = recording_root.join(session_id);
        fs::create_dir_all(&session_dir).expect("create session dir");
        let audio_path = session_dir.join(audio_file);
        fs::write(&audio_path, b"FAKE").expect("write audio");

        let mut meta = SessionMeta::new(
            session_id.to_string(),
            "slack".to_string(),
            vec![],
            "Topic".to_string(),
            String::new(),
        );
        meta.status = status;
        meta.ended_at_iso = ended_at.map(|dt| dt.to_rfc3339());
        meta.artifacts = SessionArtifacts {
            audio_file: audio_file.to_string(),
            transcript_file: "transcript.md".to_string(),
            summary_file: "summary.md".to_string(),
            meta_file: "meta.json".to_string(),
        };
        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(app_data_dir, &meta, &session_dir, &meta_path)
            .expect("upsert session");
    }

    fn fixture_dirs() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        fs::create_dir_all(&app_data_dir).expect("mkdir app-data");
        let recording_root = tmp.path().join("recordings");
        (tmp, app_data_dir, recording_root)
    }

    #[test]
    fn wipe_session_audio_clears_meta_and_removes_file() {
        let (_tmp, app_data_dir, recording_root) = fixture_dirs();
        write_session_with_audio(
            &app_data_dir,
            &recording_root,
            "s-old",
            Some(Utc::now() - ChronoDuration::days(30)),
            SessionStatus::Done,
            "audio.opus",
        );

        wipe_session_audio_file(&app_data_dir, "s-old").expect("wipe ok");

        let meta_path = get_meta_path(&app_data_dir, "s-old")
            .expect("get meta path")
            .expect("meta path exists");
        let meta = load_meta(&meta_path).expect("load meta");
        assert_eq!(meta.artifacts.audio_file, "");
        let session_dir = get_session_dir(&app_data_dir, "s-old")
            .expect("get session dir")
            .expect("session dir exists");
        assert!(!session_dir.join("audio.opus").exists());
    }

    #[test]
    fn auto_delete_sweep_removes_only_old_audio() {
        let (_tmp, app_data_dir, recording_root) = fixture_dirs();
        write_session_with_audio(
            &app_data_dir,
            &recording_root,
            "s-old",
            Some(Utc::now() - ChronoDuration::days(30)),
            SessionStatus::Done,
            "audio-old.opus",
        );
        write_session_with_audio(
            &app_data_dir,
            &recording_root,
            "s-fresh",
            Some(Utc::now() - ChronoDuration::days(1)),
            SessionStatus::Done,
            "audio-fresh.opus",
        );

        let cutoff = Utc::now() - ChronoDuration::days(7);
        let summary = run_auto_delete_audio_sweep(&app_data_dir, cutoff, None)
            .expect("sweep ok");

        assert_eq!(summary, AutoDeleteSummary { deleted: 1, scanned: 2 });
        assert!(!recording_root.join("s-old").join("audio-old.opus").exists());
        assert!(recording_root.join("s-fresh").join("audio-fresh.opus").exists());

        // Old session's meta now has empty audio_file.
        let old_meta = load_meta(
            &get_meta_path(&app_data_dir, "s-old")
                .expect("meta path")
                .expect("exists"),
        )
        .expect("load meta");
        assert_eq!(old_meta.artifacts.audio_file, "");
    }

    #[test]
    fn auto_delete_sweep_skips_recording_session_even_when_old() {
        let (_tmp, app_data_dir, recording_root) = fixture_dirs();
        write_session_with_audio(
            &app_data_dir,
            &recording_root,
            "s-recording-old",
            Some(Utc::now() - ChronoDuration::days(30)),
            SessionStatus::Recording,
            "audio.opus",
        );

        let cutoff = Utc::now() - ChronoDuration::days(7);
        let summary = run_auto_delete_audio_sweep(&app_data_dir, cutoff, None)
            .expect("sweep ok");

        assert_eq!(summary, AutoDeleteSummary { deleted: 0, scanned: 1 });
        assert!(recording_root.join("s-recording-old").join("audio.opus").exists());
    }

    #[test]
    fn auto_delete_sweep_skips_active_session_even_when_old() {
        let (_tmp, app_data_dir, recording_root) = fixture_dirs();
        write_session_with_audio(
            &app_data_dir,
            &recording_root,
            "s-active",
            Some(Utc::now() - ChronoDuration::days(30)),
            SessionStatus::Done,
            "audio.opus",
        );

        let cutoff = Utc::now() - ChronoDuration::days(7);
        let summary =
            run_auto_delete_audio_sweep(&app_data_dir, cutoff, Some("s-active"))
                .expect("sweep ok");

        assert_eq!(summary, AutoDeleteSummary { deleted: 0, scanned: 1 });
        assert!(recording_root.join("s-active").join("audio.opus").exists());
    }

    #[test]
    fn auto_delete_sweep_skips_session_without_audio() {
        let (_tmp, app_data_dir, recording_root) = fixture_dirs();

        let session_dir = recording_root.join("s-no-audio");
        fs::create_dir_all(&session_dir).expect("create session dir");
        let mut meta = SessionMeta::new(
            "s-no-audio".to_string(),
            "slack".to_string(),
            vec![],
            "Topic".to_string(),
            String::new(),
        );
        meta.status = SessionStatus::Done;
        meta.ended_at_iso = Some((Utc::now() - ChronoDuration::days(30)).to_rfc3339());
        meta.artifacts.audio_file = String::new();
        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert");

        let cutoff = Utc::now() - ChronoDuration::days(7);
        let summary = run_auto_delete_audio_sweep(&app_data_dir, cutoff, None)
            .expect("sweep ok");

        // Scanned but not deleted (empty audio_file path).
        assert_eq!(summary, AutoDeleteSummary { deleted: 0, scanned: 1 });
    }

    #[test]
    fn auto_delete_sweep_skips_session_with_unparseable_ended_at() {
        let (_tmp, app_data_dir, recording_root) = fixture_dirs();

        let session_dir = recording_root.join("s-bad-ended");
        fs::create_dir_all(&session_dir).expect("create session dir");
        fs::write(session_dir.join("audio.opus"), b"FAKE").expect("write audio");
        let mut meta = SessionMeta::new(
            "s-bad-ended".to_string(),
            "slack".to_string(),
            vec![],
            "Topic".to_string(),
            String::new(),
        );
        meta.status = SessionStatus::Done;
        meta.ended_at_iso = Some("not-a-valid-date".to_string());
        meta.artifacts.audio_file = "audio.opus".to_string();
        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert");

        let cutoff = Utc::now() - ChronoDuration::days(7);
        let summary = run_auto_delete_audio_sweep(&app_data_dir, cutoff, None)
            .expect("sweep ok");

        assert_eq!(summary, AutoDeleteSummary { deleted: 0, scanned: 1 });
        assert!(session_dir.join("audio.opus").exists());
    }

    #[test]
    fn auto_delete_sweep_skips_session_with_missing_ended_at() {
        let (_tmp, app_data_dir, recording_root) = fixture_dirs();

        let session_dir = recording_root.join("s-no-end");
        fs::create_dir_all(&session_dir).expect("create session dir");
        fs::write(session_dir.join("audio.opus"), b"FAKE").expect("write audio");
        let mut meta = SessionMeta::new(
            "s-no-end".to_string(),
            "slack".to_string(),
            vec![],
            "Topic".to_string(),
            String::new(),
        );
        meta.status = SessionStatus::Done;
        meta.ended_at_iso = None;
        meta.artifacts.audio_file = "audio.opus".to_string();
        let meta_path = session_dir.join("meta.json");
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert");

        let cutoff = Utc::now() - ChronoDuration::days(7);
        let summary = run_auto_delete_audio_sweep(&app_data_dir, cutoff, None)
            .expect("sweep ok");

        assert_eq!(summary, AutoDeleteSummary { deleted: 0, scanned: 1 });
        assert!(session_dir.join("audio.opus").exists());
    }
```

Note: tests exercise `run_auto_delete_audio_sweep` directly with the cutoff already computed. The Tauri command's early-return for `enabled=false` is a tiny wrapper that just gates on the settings field — covered implicitly by Task 1's settings tests + the helper tests above.

- [ ] **Step 8: Run the new Rust tests**

Run: `cd src-tauri && cargo test commands::sessions::tests --no-fail-fast 2>&1 | tail -20`
Expected: all the new tests pass alongside the existing ones in that module.

- [ ] **Step 9: Run the full Rust test suite**

Run: `cd src-tauri && cargo test --no-fail-fast 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/commands/sessions.rs src-tauri/src/main.rs
git commit -m "$(cat <<'EOF'
feat(sessions): auto_delete_old_session_audio Tauri command

Extract a pure wipe_session_audio_file helper from the existing
delete_session_audio command (no behavioral change), then add a new
auto_delete_old_session_audio command that sweeps the session list and
removes audio for sessions older than auto_delete_audio_days
(measured against ended_at_iso). Sessions that are currently recording,
have empty audio_file, or have a missing/unparseable ended_at_iso are
skipped. Per-session errors are logged via eprintln! and do not abort
the sweep. Returns {deleted, scanned} counts.
EOF
)"
```

---

## Task 3: Frontend Settings UI

**Files:**
- Modify: `src/components/settings/GeneralSettings.tsx`
- Modify: `src/pages/SettingsPage/index.tsx`

- [ ] **Step 1: Update `GeneralSettings.tsx`**

In `src/components/settings/GeneralSettings.tsx`:

a) Update the imports line at the top to include `InputNumber` and `QuestionCircleOutlined`:

```tsx
import { Button, Checkbox, Flex, Form, Input, InputNumber, Select, Tooltip } from "antd";
import { FileSyncOutlined, QuestionCircleOutlined } from "@ant-design/icons";
```

b) Insert the new `Form.Item` immediately **after** the closing `</Form.Item>` of the "Artifact opener app (optional)" select (currently around lines 99-131) and **before** the "Auto-run pipeline on Stop" `Form.Item`:

```tsx
      <Form.Item>
        <Flex align="center" gap={8} wrap="wrap">
          <Checkbox
            id="auto_delete_audio_enabled"
            aria-label="Автоматически удалять аудио-файлы для старых сессий"
            checked={Boolean(settings.auto_delete_audio_enabled)}
            onChange={(e) =>
              setSettings({ ...settings, auto_delete_audio_enabled: e.target.checked })
            }
          >
            Автоматически удалять аудио-файлы для сессий, старше
            {(isDirty("auto_delete_audio_enabled") ||
              isDirty("auto_delete_audio_days")) && dirtyDot}
          </Checkbox>
          <InputNumber
            aria-label="Дней до автоудаления аудио"
            min={1}
            max={3650}
            value={settings.auto_delete_audio_days}
            disabled={!settings.auto_delete_audio_enabled}
            onChange={(v) =>
              setSettings({ ...settings, auto_delete_audio_days: Number(v ?? 1) })
            }
            style={{ width: 80 }}
          />
          <span>дней</span>
          <Tooltip title="Проверка выполняется при запуске приложения">
            <QuestionCircleOutlined style={{ color: "#999", cursor: "help" }} />
          </Tooltip>
        </Flex>
      </Form.Item>
```

- [ ] **Step 2: Update `SettingsPage/index.tsx` dirty tracking**

In `src/pages/SettingsPage/index.tsx`, find `dirtyByTab.generals` (line ~93). Change it from:

```ts
    generals:
      isDirty("recording_root") ||
      isDirty("artifact_open_app") ||
      isDirty("auto_run_pipeline_on_stop") ||
      isDirty("api_call_logging_enabled"),
```

to:

```ts
    generals:
      isDirty("recording_root") ||
      isDirty("artifact_open_app") ||
      isDirty("auto_run_pipeline_on_stop") ||
      isDirty("api_call_logging_enabled") ||
      isDirty("auto_delete_audio_enabled") ||
      isDirty("auto_delete_audio_days"),
```

- [ ] **Step 3: Build + typecheck**

Run: `npm run build 2>&1 | tail -5`
Expected: build succeeds.

Run: `npx tsc --noEmit 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `npm test 2>&1 | tail -10`
Expected: 121/121 pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/GeneralSettings.tsx src/pages/SettingsPage/index.tsx
git commit -m "$(cat <<'EOF'
feat(settings-ui): auto-delete audio control in Generals tab

Add a checkbox + InputNumber + tooltip row immediately after the
Artifact opener select. Days input is disabled while the checkbox is
off; tooltip explains that the cleanup runs at app startup. Both fields
participate in the existing per-tab dirty-dot tracking.
EOF
)"
```

---

## Task 4: Frontend startup trigger + IPC test

**Files:**
- Modify: `src/pages/MainPage/index.tsx`
- Modify: `src/App.main.test.tsx`

- [ ] **Step 1: Add the one-shot useEffect in `MainPage`**

In `src/pages/MainPage/index.tsx`, find the existing `useEffect` block that calls `loadSessionsRef.current?.()` when `mainTab !== "sessions"`. **Above** that block (and below the existing analytics-init useEffect), add:

```tsx
  const autoDeleteDoneRef = useRef(false);
  useEffect(() => {
    if (autoDeleteDoneRef.current) return;
    autoDeleteDoneRef.current = true;
    void tauriInvoke<{ deleted: number; scanned: number }>(
      "auto_delete_old_session_audio",
    )
      .catch(() => undefined)
      .finally(() => {
        void loadSessionsRef.current?.();
      });
  }, []);
```

The ref-flag guard is defense-in-depth against React StrictMode double-mount in dev. The `.catch` swallows errors silently per the spec.

Verify `useRef` is already in the React imports at the top of the file (it is — used by the existing refs). No new imports needed.

- [ ] **Step 2: Update the default IPC mock in `App.main.test.tsx`**

In `src/App.main.test.tsx`, locate the `defaultImpl` function inside `vi.hoisted(...)` (around line 8). Add a handler for the new command, alphabetized near the other handlers:

```ts
    if (cmd === "auto_delete_old_session_audio") {
      return { deleted: 0, scanned: 0 };
    }
```

- [ ] **Step 3: Add a test asserting the IPC fires once on app mount and is followed by `list_sessions`**

Append a new `it` to the existing `describe("App main window", ...)` block in `src/App.main.test.tsx` (anywhere inside the describe; order doesn't matter):

```tsx
  it("triggers auto_delete_old_session_audio once at startup before listing sessions", async () => {
    render(<App />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("auto_delete_old_session_audio");
    });
    const calls = invokeMock.mock.calls.map(([cmd]) => cmd);
    const autoDeleteCalls = calls.filter((cmd) => cmd === "auto_delete_old_session_audio");
    expect(autoDeleteCalls).toHaveLength(1);
    const autoDeleteIdx = calls.indexOf("auto_delete_old_session_audio");
    const listSessionsIdx = calls.lastIndexOf("list_sessions");
    expect(listSessionsIdx).toBeGreaterThan(autoDeleteIdx);
  });
```

The `lastIndexOf` for `list_sessions` is intentional — `list_sessions` may be called multiple times during startup (analytics, refresh after auto-delete); we just want at least one call after the cleanup IPC.

- [ ] **Step 4: Run the test for the new behavior**

Run: `npm test -- src/App.main.test.tsx 2>&1 | tail -10`
Expected: full test file green, including the new test.

- [ ] **Step 5: Run the full suite**

Run: `npm test 2>&1 | tail -10`
Expected: 122/122 (was 121; +1 new test).

- [ ] **Step 6: Commit**

```bash
git add src/pages/MainPage/index.tsx src/App.main.test.tsx
git commit -m "$(cat <<'EOF'
feat(sessions): trigger auto_delete_old_session_audio on app startup

One-shot useEffect in MainPage invokes the new Tauri command exactly
once per launch (ref-flag guards StrictMode double-mount), then refreshes
the session list. Errors are silently swallowed per the spec — affected
cards just lose their AudioPlayer once the refreshed list arrives.
EOF
)"
```

---

## Task 5: Final verification

**Files:** none

- [ ] **Step 1: Build everything**

Run: `npm run build 2>&1 | tail -5`
Expected: clean Vite build.

Run: `cd src-tauri && cargo build --release 2>&1 | tail -5`
Expected: clean release build.

- [ ] **Step 2: Run all tests**

Run: `npm test 2>&1 | tail -10`
Expected: 122/122 green.

Run: `cd src-tauri && cargo test --no-fail-fast 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 3: Manual UI walkthrough (controller hands off to user)**

Start `npm run tauri dev` (with `CMAKE_POLICY_VERSION_MINIMUM=3.5` if needed).

Then in the running app:
1. Open Settings → Generals. The new row appears between "Artifact opener app" and "Auto-run pipeline on Stop". Hover the (?) — tooltip says "Проверка выполняется при запуске приложения".
2. Toggle the checkbox: number input becomes editable. Type a value. Click Save settings. Restart the app.
3. Have at least two sessions: one with `ended_at_iso` older than your N (use existing old recordings), one fresh. After restart, the old session's audio player and any audio-only controls disappear; the fresh session's audio is intact.
4. Disable the checkbox, save, restart. No further audio deletions on the next launch.
5. Confirm transcripts/summaries/notes/topic on the cleaned sessions remain untouched — only the audio file was wiped.

If all five check out — done.
