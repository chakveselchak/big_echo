# Session Transcription Speed Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session speed dropdown that creates/selects the audio speed used by the next manual `Get text` transcription.

**Architecture:** Backend persists the selected effective audio in existing session artifact fields and exposes speed availability in `SessionListItem`. The frontend renders a speed icon dropdown in each session card and calls a new Tauri command to create/select speed audio before refreshing sessions. Manual transcription continues to call `run_transcription`, which already uses the effective-audio helper.

**Tech Stack:** Rust/Tauri commands and storage helpers, serde session metadata, ffmpeg `atempo`, React/TypeScript, Ant Design `Dropdown`, Vitest, Cargo tests.

---

## File Map

- Modify `src-tauri/src/storage/sqlite_repo.rs`: expose available speed multipliers in `SessionListItem`; keep effective-audio selection based on existing artifact fields.
- Modify `src-tauri/src/commands/sessions.rs`: add backend command to select/generate per-session transcription speed.
- Modify `src-tauri/src/main.rs`: register the new Tauri command in runtime and test app invoke handlers.
- Modify `src/types/index.ts`: add `available_audio_speed_multipliers?: number[]` to `SessionListItem`.
- Modify `src/hooks/useSessions.ts`: add a `setSessionTranscriptionSpeed(sessionId, speed)` action, pending state, and list-refresh behavior.
- Modify `src/components/sessions/SessionList.tsx`: pass the speed action and pending state into `SessionCard`.
- Modify `src/components/sessions/SessionCard.tsx`: add the speed icon dropdown in the header action group.
- Modify `src/index.css`: style the speed icon, dropdown row, checkmark slot, and green availability dot.
- Modify tests in `src-tauri/src/commands/sessions.rs`, `src-tauri/src/storage/sqlite_repo.rs`, `src/components/sessions/SessionCard.test.tsx`, and `src/hooks/useSessions.test.tsx`.

## Task 1: Backend Session Speed Selection Command

**Files:**
- Modify: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/main.rs`
- Test: `src-tauri/src/commands/sessions.rs`

- [ ] **Step 1: Write failing Rust tests for selecting `1x` and existing `1.5x`**

Add these tests inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/commands/sessions.rs`. The tests create their own session directory, write `meta.json`, and upsert the session, so they do not depend on any helper.

```rust
#[test]
fn set_session_transcription_audio_speed_one_x_clears_selected_speed() {
    let temp = tempfile::tempdir().expect("tempdir");
    let app_data_dir = temp.path().join("app");
    let session_dir = temp.path().join("recordings").join("s-speed");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::write(session_dir.join("audio.opus"), b"original").expect("original audio");
    std::fs::write(session_dir.join("audio_1.5x.opus"), b"speed").expect("speed audio");

    let mut meta = crate::domain::session::SessionMeta::new(
        "s-speed".to_string(),
        "general".to_string(),
        vec![],
        "Speed".to_string(),
        String::new(),
    );
    meta.status = crate::domain::session::SessionStatus::Recorded;
    meta.artifacts.audio_file = "audio.opus".to_string();
    meta.artifacts.speed_adjusted_audio_file = "audio_1.5x.opus".to_string();
    meta.artifacts.audio_speed_multiplier = Some(1.5);
    let meta_path = session_dir.join("meta.json");
    crate::storage::session_store::save_meta(&meta_path, &meta).expect("save meta");
    crate::storage::sqlite_repo::upsert_session(&app_data_dir, &meta, &session_dir, &meta_path)
        .expect("upsert");

    set_session_transcription_audio_speed_core(&app_data_dir, "s-speed", 1.0).expect("select 1x");

    let loaded = crate::storage::session_store::load_meta(&meta_path).expect("load meta");
    assert_eq!(loaded.artifacts.speed_adjusted_audio_file, "");
    assert_eq!(loaded.artifacts.audio_speed_multiplier, None);
    assert_eq!(
        crate::storage::sqlite_repo::effective_audio_file_for_session(&session_dir, &loaded),
        "audio.opus"
    );
}

#[test]
fn set_session_transcription_audio_speed_reuses_existing_speed_file() {
    let temp = tempfile::tempdir().expect("tempdir");
    let app_data_dir = temp.path().join("app");
    let session_dir = temp.path().join("recordings").join("s-speed");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::write(session_dir.join("audio.opus"), b"original").expect("original audio");
    std::fs::write(session_dir.join("audio_1.5x.opus"), b"speed").expect("speed audio");

    let mut meta = crate::domain::session::SessionMeta::new(
        "s-speed".to_string(),
        "general".to_string(),
        vec![],
        "Speed".to_string(),
        String::new(),
    );
    meta.status = crate::domain::session::SessionStatus::Recorded;
    meta.artifacts.audio_file = "audio.opus".to_string();
    let meta_path = session_dir.join("meta.json");
    crate::storage::session_store::save_meta(&meta_path, &meta).expect("save meta");
    crate::storage::sqlite_repo::upsert_session(&app_data_dir, &meta, &session_dir, &meta_path)
        .expect("upsert");

    set_session_transcription_audio_speed_core(&app_data_dir, "s-speed", 1.5).expect("select 1.5x");

    let loaded = crate::storage::session_store::load_meta(&meta_path).expect("load meta");
    assert_eq!(loaded.artifacts.speed_adjusted_audio_file, "audio_1.5x.opus");
    assert_eq!(loaded.artifacts.audio_speed_multiplier, Some(1.5));
    assert_eq!(
        crate::storage::sqlite_repo::effective_audio_file_for_session(&session_dir, &loaded),
        "audio_1.5x.opus"
    );
}

#[test]
fn set_session_transcription_audio_speed_generates_missing_speed_file() {
    let temp = tempfile::tempdir().expect("tempdir");
    let app_data_dir = temp.path().join("app");
    let session_dir = temp.path().join("recordings").join("s-speed");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    crate::audio::opus_writer::write_silence_opus(&session_dir.join("audio.opus"), 1000, 24)
        .expect("original audio");

    let mut meta = crate::domain::session::SessionMeta::new(
        "s-speed".to_string(),
        "general".to_string(),
        vec![],
        "Speed".to_string(),
        String::new(),
    );
    meta.status = crate::domain::session::SessionStatus::Recorded;
    meta.artifacts.audio_file = "audio.opus".to_string();
    let meta_path = session_dir.join("meta.json");
    crate::storage::session_store::save_meta(&meta_path, &meta).expect("save meta");
    crate::storage::sqlite_repo::upsert_session(&app_data_dir, &meta, &session_dir, &meta_path)
        .expect("upsert");

    set_session_transcription_audio_speed_core(&app_data_dir, "s-speed", 1.25).expect("select 1.25x");

    assert!(session_dir.join("audio_1.25x.opus").is_file());
    let loaded = crate::storage::session_store::load_meta(&meta_path).expect("load meta");
    assert_eq!(loaded.artifacts.speed_adjusted_audio_file, "audio_1.25x.opus");
    assert_eq!(loaded.artifacts.audio_speed_multiplier, Some(1.25));
}

#[test]
fn set_session_transcription_audio_speed_rejects_unsupported_speed() {
    let temp = tempfile::tempdir().expect("tempdir");
    let err = set_session_transcription_audio_speed_core(temp.path(), "s-speed", 1.1)
        .expect_err("unsupported speed should fail");

    assert_eq!(err, "Invalid audio speed multiplier");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test set_session_transcription_audio_speed --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because `set_session_transcription_audio_speed_core` does not exist.

- [ ] **Step 3: Implement speed validation and core command**

Add this near the other session commands in `src-tauri/src/commands/sessions.rs`:

```rust
fn validate_session_audio_speed(speed: f32) -> Result<f32, String> {
    const ALLOWED: &[f32] = &[1.0, 1.25, 1.5, 1.75, 2.0];
    ALLOWED
        .iter()
        .copied()
        .find(|allowed| (speed - *allowed).abs() < f32::EPSILON)
        .ok_or_else(|| "Invalid audio speed multiplier".to_string())
}

pub(crate) fn set_session_transcription_audio_speed_core(
    app_data_dir: &Path,
    session_id: &str,
    speed: f32,
) -> Result<(), String> {
    let speed = validate_session_audio_speed(speed)?;
    let session_dir = get_session_dir(app_data_dir, session_id)?
        .ok_or_else(|| "Session not found".to_string())?;
    let meta_path = get_meta_path(app_data_dir, session_id)?
        .ok_or_else(|| "Session metadata not found".to_string())?;
    let mut meta = load_meta(&meta_path)?;
    let original_file = meta.artifacts.audio_file.trim().to_string();
    if original_file.is_empty() {
        return Err("Session audio is missing".to_string());
    }
    let original_path = session_dir.join(&original_file);
    if !original_path.is_file() {
        return Err("Session audio file was not found".to_string());
    }

    if speed <= 1.0 {
        meta.artifacts.speed_adjusted_audio_file = String::new();
        meta.artifacts.audio_speed_multiplier = None;
        save_meta(&meta_path, &meta)?;
        upsert_session(app_data_dir, &meta, &session_dir, &meta_path)?;
        add_event(
            app_data_dir,
            &meta.session_id,
            "audio_speed_selected",
            "Selected original audio for transcription",
        )?;
        return Ok(());
    }

    let speed_file = crate::audio::file_writer::speed_adjusted_audio_file_name(&original_file, speed)
        .ok_or_else(|| format!("Cannot build speed-adjusted file name for {original_file}"))?;
    let speed_path = session_dir.join(&speed_file);
    if !speed_path.is_file() {
        let settings = get_settings_from_dirs(&AppDirs {
            app_data_dir: app_data_dir.to_path_buf(),
        })?;
        crate::audio::file_writer::write_speed_adjusted_audio_file(
            &original_path,
            &speed_path,
            &settings.audio_format,
            settings.opus_bitrate_kbps,
            speed,
        )
        .map_err(|err| format!("Audio speed-up failed: {err}"))?;
    }

    meta.artifacts.speed_adjusted_audio_file = speed_file;
    meta.artifacts.audio_speed_multiplier = Some(speed);
    save_meta(&meta_path, &meta)?;
    upsert_session(app_data_dir, &meta, &session_dir, &meta_path)?;
    add_event(
        app_data_dir,
        &meta.session_id,
        "audio_speed_selected",
        &format!("Selected {}x audio for transcription", crate::audio::file_writer::audio_speed_label(speed)),
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_session_transcription_audio_speed(
    dirs: tauri::State<'_, AppDirs>,
    session_id: String,
    speed: f32,
) -> Result<(), String> {
    set_session_transcription_audio_speed_core(&dirs.app_data_dir, &session_id, speed)
}
```

- [ ] **Step 4: Register the command**

In `src-tauri/src/main.rs`, add `set_session_transcription_audio_speed` to the `use crate::commands::sessions::{...}` import if commands are imported explicitly, then add it to both `tauri::generate_handler!` lists:

```rust
set_session_transcription_audio_speed,
```

Place it near `delete_session_audio` and `list_sessions`.

- [ ] **Step 5: Run backend tests**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test set_session_transcription_audio_speed --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 6: Commit backend command**

Run:

```bash
git add src-tauri/src/commands/sessions.rs src-tauri/src/main.rs
git commit -m "feat: select session transcription speed"
```

Before committing, run `git diff --cached --name-only` and confirm only `src-tauri/src/commands/sessions.rs` and `src-tauri/src/main.rs` are staged.

## Task 2: Speed Availability In Session List

**Files:**
- Modify: `src-tauri/src/storage/sqlite_repo.rs`
- Modify: `src/types/index.ts`
- Test: `src-tauri/src/storage/sqlite_repo.rs`

- [ ] **Step 1: Write failing Rust test for available speeds**

Extend the existing `list_sessions_exposes_speed_adjusted_audio_when_file_exists` test or add a new test:

```rust
#[test]
fn list_sessions_exposes_available_audio_speed_multipliers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let session_dir = dir.path().join("sessions").join("s-speed");
    std::fs::create_dir_all(&session_dir).expect("session dir");

    let mut meta = crate::domain::session::SessionMeta::new(
        "s-speed".to_string(),
        "general".to_string(),
        vec![],
        "Speed".to_string(),
        String::new(),
    );
    meta.status = crate::domain::session::SessionStatus::Recorded;
    meta.artifacts.audio_file = "audio.opus".to_string();
    let meta_path = session_dir.join("meta.json");
    crate::storage::session_store::save_meta(&meta_path, &meta).expect("save meta");
    std::fs::write(session_dir.join("audio.opus"), b"original").expect("original");
    std::fs::write(session_dir.join("audio_1.25x.opus"), b"speed").expect("speed");
    upsert_session(dir.path(), &meta, &session_dir, &meta_path).expect("upsert");

    let sessions = list_sessions(dir.path()).expect("list sessions");

    assert_eq!(sessions[0].available_audio_speed_multipliers, vec![1.0, 1.25]);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test list_sessions_exposes_available_audio_speed_multipliers --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because `available_audio_speed_multipliers` does not exist.

- [ ] **Step 3: Add backend field and helper**

In `SessionListItem` in `src-tauri/src/storage/sqlite_repo.rs`, add:

```rust
pub available_audio_speed_multipliers: Vec<f32>,
```

Initialize it in the SQL row mapping:

```rust
available_audio_speed_multipliers: Vec::new(),
```

Add helper:

```rust
fn available_audio_speed_multipliers(session_dir: &Path, meta: &SessionMeta) -> Vec<f32> {
    let mut out = Vec::new();
    if !meta.artifacts.audio_file.trim().is_empty()
        && session_dir.join(meta.artifacts.audio_file.trim()).is_file()
    {
        out.push(1.0);
    }
    for speed in [1.25_f32, 1.5, 1.75, 2.0] {
        if let Some(file_name) =
            crate::audio::file_writer::speed_adjusted_audio_file_name(&meta.artifacts.audio_file, speed)
        {
            if session_dir.join(file_name).is_file() {
                out.push(speed);
            }
        }
    }
    out
}
```

When hydrating metadata in `list_sessions`, set:

```rust
item.available_audio_speed_multipliers =
    available_audio_speed_multipliers(&session_dir, &meta);
```

- [ ] **Step 4: Add frontend type field**

In `src/types/index.ts`, add to `SessionListItem`:

```ts
available_audio_speed_multipliers?: number[];
```

- [ ] **Step 5: Preserve React item identity for availability**

In `src/hooks/useSessions.ts`, update the item equality check in `loadSessionsInner` with:

```ts
JSON.stringify(existing.available_audio_speed_multipliers ?? []) ===
  JSON.stringify(fresh.available_audio_speed_multipliers ?? [])
```

Add it next to the existing audio speed field comparisons.

- [ ] **Step 6: Run backend availability test**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test list_sessions_exposes_available_audio_speed_multipliers --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 7: Commit availability payload**

Run:

```bash
git add src-tauri/src/storage/sqlite_repo.rs src/types/index.ts src/hooks/useSessions.ts
git commit -m "feat: expose session audio speed availability"
```

## Task 3: Frontend Hook Action

**Files:**
- Modify: `src/hooks/useSessions.ts`
- Test: `src/hooks/useSessions.test.tsx`

- [ ] **Step 1: Write failing hook test**

Add a test to `src/hooks/useSessions.test.tsx` near the existing command action tests:

```ts
it("selects session transcription speed and reloads sessions", async () => {
  const setStatus = vi.fn();
  const setLastSessionId = vi.fn();
  const { result } = renderHook(() =>
    useSessions({ setStatus, lastSessionId: null, setLastSessionId })
  );

  await act(async () => {
    await result.current.setSessionTranscriptionSpeed("s-1", 1.5);
  });

  expect(invokeMock).toHaveBeenCalledWith("set_session_transcription_audio_speed", {
    sessionId: "s-1",
    speed: 1.5,
  });
  expect(setStatus).toHaveBeenCalledWith("audio_speed_selected");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run --exclude '.worktrees/**' src/hooks/useSessions.test.tsx -t "selects session transcription speed"
```

Expected: FAIL because `setSessionTranscriptionSpeed` does not exist.

- [ ] **Step 3: Implement hook action and pending state**

In `useSessions`, add state:

```ts
const [speedPendingBySession, setSpeedPendingBySession] = useState<Record<string, boolean>>({});
```

Add action:

```ts
async function setSessionTranscriptionSpeed(sessionId: string, speed: number) {
  setSpeedPendingBySession((prev) => ({ ...prev, [sessionId]: true }));
  try {
    await tauriInvoke("set_session_transcription_audio_speed", { sessionId, speed });
    setStatus("audio_speed_selected");
    await loadSessions();
  } catch (err) {
    setStatus(`error: ${getErrorMessage(err)}`);
  } finally {
    setSpeedPendingBySession((prev) => ({ ...prev, [sessionId]: false }));
  }
}
```

Prune `speedPendingBySession` in the existing prune effect:

```ts
setSpeedPendingBySession((prev) => prune(prev) ?? prev);
```

Return both:

```ts
setSessionTranscriptionSpeed,
speedPendingBySession,
```

- [ ] **Step 4: Run hook test**

Run:

```bash
npx vitest run --exclude '.worktrees/**' src/hooks/useSessions.test.tsx -t "selects session transcription speed"
```

Expected: PASS.

- [ ] **Step 5: Commit hook action**

Run:

```bash
git add src/hooks/useSessions.ts src/hooks/useSessions.test.tsx
git commit -m "feat: add session speed selection hook"
```

## Task 4: Session Card Speed Dropdown UI

**Files:**
- Modify: `src/components/sessions/SessionCard.tsx`
- Modify: `src/components/sessions/SessionList.tsx`
- Modify: `src/index.css`
- Test: `src/components/sessions/SessionCard.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add tests in `src/components/sessions/SessionCard.test.tsx`:

```tsx
it("renders speed dropdown with selected check and availability dots", async () => {
  const onSetSpeed = vi.fn();
  renderWithI18n(
    <SessionCard
      {...makeProps({
        item: makeItem("uploaded", {
          audio_file: "audio.opus",
          speed_adjusted_audio_file: "audio_1.5x.opus",
          audio_speed_multiplier: 1.5,
          available_audio_speed_multipliers: [1, 1.25, 1.5],
        }),
        onSetTranscriptionSpeed: onSetSpeed,
      })}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: "Выбрать скорость транскрибации" }));

  expect(screen.getByRole("menuitem", { name: /1x/ })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /1.5x/ })).toHaveTextContent("✓");
  expect(screen.getByRole("menuitem", { name: /1.25x/ }).querySelector(".session-speed-available-dot")).toBeTruthy();
});

it("calls speed selection when a dropdown speed is clicked", async () => {
  const onSetSpeed = vi.fn();
  renderWithI18n(
    <SessionCard
      {...makeProps({
        item: makeItem("uploaded", {
          session_id: "s-brain",
          audio_file: "audio.opus",
          available_audio_speed_multipliers: [1],
        }),
        onSetTranscriptionSpeed: onSetSpeed,
      })}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: "Выбрать скорость транскрибации" }));
  await userEvent.click(screen.getByRole("menuitem", { name: /2x/ }));

  expect(onSetSpeed).toHaveBeenCalledWith("s-brain", 2);
});
```

Update `makeProps` in the same test file with default props:

```tsx
onSetTranscriptionSpeed: noop,
speedPending: false,
```

The intended new component props are:

```ts
onSetTranscriptionSpeed: (sessionId: string, speed: number) => void;
speedPending: boolean;
```

- [ ] **Step 2: Run UI tests to verify they fail**

Run:

```bash
npx vitest run --exclude '.worktrees/**' src/components/sessions/SessionCard.test.tsx -t "speed dropdown"
```

Expected: FAIL because the speed dropdown is not rendered.

- [ ] **Step 3: Implement `SessionCard` props and speed icon**

Update imports:

```tsx
import { Badge, Button, Col, ConfigProvider, Dropdown, Form, Input, InputNumber, Row, Select } from "antd";
import { CheckOutlined, CheckSquareOutlined, ClearOutlined, DeleteOutlined, DeploymentUnitOutlined, ExportOutlined, FolderOpenOutlined, MessageOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
```

Add constants near `fixedSourceOptions`:

```tsx
const sessionSpeedOptions = [1, 1.25, 1.5, 1.75, 2] as const;

function SpeedometerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 46 45" aria-hidden="true" focusable="false">
      <g transform="translate(0.338000, 0.000000)" fill="currentColor" fillRule="nonzero">
        <path d="M41.318,14.422 L44.464,10.672 C44.771,10.308 44.722,9.764 44.359,9.458 L41.822,7.328 C41.457,7.024 40.914,7.071 40.609,7.436 L37.679,10.927 C35.257,9.157 32.4,7.965 29.29,7.538 L29.29,4.444 L33.032,4.444 C33.452,4.444 33.792,4.103 33.792,3.682 L33.792,0.76 C33.792,0.339 33.452,0 33.032,0 L20.498,0 C20.078,0 19.738,0.339 19.738,0.76 L19.738,3.682 C19.738,4.103 20.078,4.444 20.498,4.444 L24.24,4.444 L24.24,7.526 C21.16,7.946 18.285,9.126 15.838,10.91 L12.924,7.437 C12.617,7.072 12.076,7.025 11.711,7.329 L9.174,9.459 C8.809,9.765 8.762,10.309 9.067,10.673 L12.202,14.409 C11.188,15.696 10.327,17.122 9.669,18.68 C9.343,19.446 9.702,20.33 10.468,20.655 C11.236,20.981 12.118,20.62 12.443,19.854 C14.881,14.086 20.504,10.36 26.767,10.36 C35.339,10.36 42.314,17.333 42.314,25.907 C42.314,34.477 35.339,41.451 26.767,41.451 C24.261,41.451 21.871,40.874 19.66,39.737 C18.922,39.354 18.014,39.645 17.633,40.385 C17.25,41.124 17.541,42.031 18.281,42.413 C20.885,43.755 23.82,44.463 26.767,44.463 C36.999,44.463 45.326,36.139 45.326,25.906 C45.324,21.571 43.818,17.586 41.318,14.422 Z" />
        <path d="M29.951,26.481 C35.025,20.445 35.328,18.7 34.984,18.356 C34.64,18.014 32.896,18.315 26.861,23.391 C23.988,25.805 24.892,27.19 25.521,27.819 C26.15,28.45 27.537,29.354 29.951,26.481 Z" />
        <path d="M17.73,24.225 C17.73,23.512 17.154,22.934 16.439,22.934 L1.291,22.934 C0.576,22.934 0,23.512 0,24.225 C0,24.938 0.576,25.516 1.291,25.516 L16.439,25.516 C17.154,25.516 17.73,24.938 17.73,24.225 Z" />
        <path d="M16.439,29.461 L7.666,29.461 C6.953,29.461 6.373,30.039 6.373,30.752 C6.373,31.465 6.953,32.043 7.666,32.043 L16.439,32.043 C17.154,32.043 17.73,31.465 17.73,30.752 C17.73,30.039 17.154,29.461 16.439,29.461 Z" />
        <path d="M16.439,35.989 L3.793,35.989 C3.078,35.989 2.5,36.566 2.5,37.28 C2.5,37.993 3.078,38.571 3.793,38.571 L16.439,38.571 C17.154,38.571 17.73,37.993 17.73,37.28 C17.73,36.566 17.154,35.989 16.439,35.989 Z" />
      </g>
    </svg>
  );
}
```

Add props:

```ts
onSetTranscriptionSpeed: (sessionId: string, speed: number) => void;
speedPending: boolean;
```

Inside component:

```tsx
const selectedSpeed = item.audio_speed_multiplier ?? 1;
const availableSpeeds = new Set(item.available_audio_speed_multipliers ?? (hasAudio ? [1] : []));
const speedMenuItems: MenuProps["items"] = sessionSpeedOptions.map((speed) => ({
  key: String(speed),
  label: (
    <span className="session-speed-menu-item">
      <span className="session-speed-check-slot">
        {selectedSpeed === speed && <CheckOutlined aria-hidden="true" />}
      </span>
      <span>{speed}x</span>
      <span className="session-speed-dot-slot">
        {availableSpeeds.has(speed) && <span className="session-speed-available-dot" />}
      </span>
    </span>
  ),
}));
```

Render in `.session-card-icon-actions`, before delete:

```tsx
{hasAudio && (
  <Dropdown
    menu={{
      items: speedMenuItems,
      onClick: ({ key }) => onSetTranscriptionSpeed(item.session_id, Number(key)),
    }}
    trigger={["click"]}
  >
    <Button
      htmlType="button"
      type="text"
      size="small"
      shape="circle"
      className="session-speed-button"
      aria-label="Выбрать скорость транскрибации"
      title="Выбрать скорость транскрибации"
      loading={speedPending}
      icon={<SpeedometerIcon />}
    />
  </Dropdown>
)}
```

- [ ] **Step 4: Wire `SessionList` props**

In `SessionListProps`, add:

```ts
speedPendingBySession: Record<string, boolean>;
onSetTranscriptionSpeed: (sessionId: string, speed: number) => void;
```

Destructure both props and pass them into each `SessionCard`:

```tsx
speedPending={Boolean(speedPendingBySession[item.session_id])}
onSetTranscriptionSpeed={onSetTranscriptionSpeed}
```

In `src/pages/MainPage/index.tsx`, add these names to the `useSessions` destructuring:

```tsx
setSessionTranscriptionSpeed,
speedPendingBySession,
```

Where `SessionList` is rendered, pass:

```tsx
speedPendingBySession={speedPendingBySession}
onSetTranscriptionSpeed={setSessionTranscriptionSpeed}
```

- [ ] **Step 5: Add CSS**

In `src/index.css`, add near session action button styles:

```css
.session-speed-button {
  color: gray;
}

.session-speed-button svg {
  display: block;
}

.session-speed-menu-item {
  display: grid;
  grid-template-columns: 18px minmax(48px, 1fr) 14px;
  align-items: center;
  gap: 8px;
  min-width: 112px;
}

.session-speed-check-slot,
.session-speed-dot-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.session-speed-available-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success, #27ae60);
}
```

- [ ] **Step 6: Run UI tests**

Run:

```bash
npx vitest run --exclude '.worktrees/**' src/components/sessions/SessionCard.test.tsx -t "speed dropdown"
```

Expected: PASS.

- [ ] **Step 7: Commit UI dropdown**

Run:

```bash
git add src/components/sessions/SessionCard.tsx src/components/sessions/SessionList.tsx src/pages/MainPage/index.tsx src/index.css src/components/sessions/SessionCard.test.tsx
git commit -m "feat: add session speed dropdown"
```

## Task 5: End-to-End Verification

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test set_session_transcription_audio_speed list_sessions_exposes_available_audio_speed_multipliers --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: all selected Rust tests PASS.

- [ ] **Step 2: Run focused frontend tests**

Run:

```bash
npx vitest run --exclude '.worktrees/**' src/hooks/useSessions.test.tsx src/components/sessions/SessionCard.test.tsx
```

Expected: selected Vitest files PASS without `.worktrees` duplicate React failures.

- [ ] **Step 3: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: Vite build exits 0.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --stat main...HEAD
```

Expected: committed changes contain only the planned speed-dropdown files. If `src-tauri/src/audio/opus_writer.rs` remains unstaged, leave it unstaged during this feature and handle it in a separate cleanup commit or restore step after this plan is complete.
