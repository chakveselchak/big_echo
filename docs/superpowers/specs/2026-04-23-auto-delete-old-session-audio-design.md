# Auto-delete old session audio — design

## Goal

Add a setting that automatically removes audio files from sessions older than a configurable number of days. Cleanup runs once at app startup and is silent — affected session cards simply lose their audio player and audio-related controls after the next session list refresh.

## User-facing behavior

- New control in **Settings → Generals**, placed immediately after the "Artifact opener app" select:
  - Checkbox: **«Автоматически удалять аудио-файлы для сессий, старше»**
  - Number input: **N дней** (disabled when checkbox is off; min 1, max 3650, default 30)
  - Tooltip icon **(?)** with text **«Проверка выполняется при запуске приложения»**
- Cleanup trigger: **only once at app launch**, when `MainPage` mounts. No periodic sweep, no manual button.
- Cleanup is **silent**: no toast, no notification, no status line. The user sees the result only as audio players disappearing from old session cards once the list refreshes.
- Sessions themselves and their transcripts/summaries are untouched — only the audio file is deleted, and `audio_file` in `meta.json` is cleared (same path as the existing manual `delete_session_audio`).

## Non-goals

- No periodic background scheduler.
- No "Очистить сейчас" / "Run cleanup now" button.
- No notification or status line about what was deleted.
- No deletion of session metadata, transcripts, summaries, or session directories.
- Setting changes do **not** retrigger cleanup mid-session — the user must restart the app (the tooltip communicates this).

## Section 1 — Backend (Rust)

### `PublicSettings` additions (`src-tauri/src/settings/public_settings.rs`)

```rust
pub struct PublicSettings {
    // …existing fields…
    pub auto_delete_audio_enabled: bool,
    pub auto_delete_audio_days: u32,
}
```

`impl Default for PublicSettings` sets `auto_delete_audio_enabled: false, auto_delete_audio_days: 30`. The struct already carries `#[serde(default)]`, so existing settings.json files without these fields deserialize with the defaults — no migration needed.

### New Tauri command `auto_delete_old_session_audio`

Returns:

```rust
#[derive(Serialize)]
pub struct AutoDeleteSummary {
    pub deleted: u32,
    pub scanned: u32,
}
```

Algorithm:

1. Read `PublicSettings`. If `!enabled`, return `{ deleted: 0, scanned: 0 }`.
2. Compute cutoff: `Utc::now() - Duration::days(days as i64)`.
3. Iterate over `list_sessions(&app_data_dir)`.
4. For each session, increment `scanned`. **Skip** when:
   - `status == SessionStatus::Recording`
   - `meta.audio_file.is_empty()`
   - `meta.ended_at_iso` is `None` or fails `DateTime::parse_from_rfc3339`
   - `ended_at >= cutoff`
5. Otherwise: invoke a new private helper `wipe_session_audio_file(...)` extracted from the existing `delete_session_audio` command (the file-removal + meta-mutation path, minus the Tauri-state plumbing). Increment `deleted`.
6. Per-session errors (e.g., audio file already missing on disk, meta write failure) are logged via `eprintln!("auto_delete: failed for {}: {}", session_id, err)` and **do not abort** the sweep. Loop continues.
7. Return `{ deleted, scanned }`.

Register the command in `src-tauri/src/main.rs` alongside `delete_session_audio` (in both the production `tauri::generate_handler!` invocations).

### Tests (Rust)

Add to `src-tauri/src/commands/sessions.rs` (or matching `tests` module):

- `auto_delete_skips_recording_session` — Recording status with old `ended_at` is skipped; counters: scanned=1, deleted=0.
- `auto_delete_skips_session_without_audio` — `audio_file: ""` skipped; no panic.
- `auto_delete_skips_session_with_invalid_ended_at` — missing or unparseable `ended_at_iso` skipped.
- `auto_delete_removes_only_old_audio` — two sessions, one older than cutoff, one fresher; only the older one's audio is removed; meta updated; counters: scanned=2, deleted=1.
- `auto_delete_disabled_returns_zero` — `enabled: false` short-circuits; nothing on disk is touched.
- `auto_delete_individual_failure_does_not_abort_sweep` — one session has a read-only / missing audio file but the next session still gets processed.

Plus on `PublicSettings`:
- `default_auto_delete_settings` — `Default::default()` returns `enabled: false, days: 30`.
- `serde_default_loads_missing_fields` — deserializing a JSON object that omits both new fields yields the same defaults.

## Section 2 — Frontend (TypeScript / React)

### Type addition (`src/types/index.ts` or wherever `PublicSettings` lives on TS)

```ts
type PublicSettings = {
  // …existing…
  auto_delete_audio_enabled: boolean;
  auto_delete_audio_days: number;
};
```

### `GeneralSettings.tsx`

Insert the following `Form.Item` immediately **after** the "Artifact opener app" `Form.Item` and **before** the "Auto-run pipeline on Stop" checkbox:

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

Imports to add: `InputNumber` from `antd`, `QuestionCircleOutlined` from `@ant-design/icons`.

### `SettingsPage/index.tsx`

Extend `dirtyByTab.generals`:

```ts
generals:
  isDirty("recording_root") ||
  isDirty("artifact_open_app") ||
  isDirty("auto_run_pipeline_on_stop") ||
  isDirty("api_call_logging_enabled") ||
  isDirty("auto_delete_audio_enabled") ||
  isDirty("auto_delete_audio_days"),
```

### Trigger in `MainPage/index.tsx`

Add a one-shot effect *before* the existing `loadSessionsRef.current?.()` effect that runs when `mainTab === "sessions"`:

```ts
const autoDeleteDoneRef = useRef(false);
useEffect(() => {
  if (autoDeleteDoneRef.current) return;
  autoDeleteDoneRef.current = true;
  void tauriInvoke<{ deleted: number; scanned: number }>(
    "auto_delete_old_session_audio"
  )
    .catch(() => undefined) // silent: errors are not surfaced
    .finally(() => {
      void loadSessionsRef.current?.();
    });
}, []);
```

The ref-flag guard ensures cleanup runs **once per app launch**, regardless of any future re-mounts. The post-cleanup `loadSessions()` is what causes affected `SessionCard`s to re-render with empty `audio_file` → existing rendering rules in `SessionCard` hide `AudioPlayer` and audio-related buttons (same path the manual delete already exercises today).

### Frontend tests

- In `App.main.test.tsx`: extend the `defaultInvokeImpl` mock so `auto_delete_old_session_audio` returns `{ deleted: 0, scanned: 0 }`. Add a test that asserts the IPC is invoked **exactly once** during app mount, and that `list_sessions` is called after it.
- (Optional) Settings-form snapshot — verify the checkbox toggles `auto_delete_audio_enabled` and the InputNumber commits `auto_delete_audio_days`. Skip if it duplicates AntD-controlled-input testing already covered elsewhere.

## Section 3 — Files touched

| File | Change |
|---|---|
| `src-tauri/src/settings/public_settings.rs` | Add `auto_delete_audio_enabled: bool` and `auto_delete_audio_days: u32`; update `impl Default`. |
| `src-tauri/src/commands/sessions.rs` | Extract `wipe_session_audio_file` helper from `delete_session_audio`; add `auto_delete_old_session_audio` command and `AutoDeleteSummary` struct. |
| `src-tauri/src/main.rs` | Register `auto_delete_old_session_audio` in the Tauri `generate_handler!` macros. |
| `src/types/index.ts` (or actual location) | Mirror new fields on TS `PublicSettings`. |
| `src/components/settings/GeneralSettings.tsx` | Add the checkbox + InputNumber + tooltip block after Artifact opener. |
| `src/pages/SettingsPage/index.tsx` | Add new fields to `dirtyByTab.generals`. |
| `src/pages/MainPage/index.tsx` | One-shot useEffect to call cleanup IPC and refresh sessions. |
| `src/App.main.test.tsx` | Mock the new IPC; assert it's called once at startup. |

## Verification

Manual flow after implementation:
1. Open Settings → Generals. New row visible after "Artifact opener app". Tooltip on hover shows the startup-only note. Checkbox + InputNumber wire-up works (number disabled when checkbox off; both contribute the dirty dot when changed).
2. With several sessions present, set `enabled: true, days: 7`, save settings, restart the app.
3. After restart, audio players and audio-related controls disappear from session cards whose `ended_at_iso` is older than 7 days; younger sessions and recording sessions are untouched.
4. Disable the setting and restart — no audio is deleted on next launch.

Automated:
- Rust: `cargo test` covers the cleanup logic + settings defaults.
- Frontend: `npm test` covers the IPC trigger contract and existing 121 tests stay green.
