# Floating Minitray Overlay (NSPanel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Zoom-style floating panel (top-center, on top of all windows) that appears during recording when a new General setting is enabled. The panel shows the BigEcho icon, a combined audio level meter, and a stop button. Implemented natively as `NSPanel` via a new Swift bridge package; gracefully no-op on non-macOS.

**Architecture:** New Swift package `MinitrayBridge` (sibling to existing `SystemAudioBridge`) exposes `bigecho_minitray_show/hide/update_level/set_callbacks` C-ABI functions. New Rust module `services/minitray` owns visibility state, throttles level updates to ~30 Hz, and runs a tokio poller that snapshots `SharedLevels` while the panel is visible. Recording start/stop/error and settings-save sites call into the module. Non-macOS targets compile to no-op stubs.

**Tech Stack:** Rust 1.x, Tauri 2, Swift 5.9 + AppKit (`NSPanel`, `NSVisualEffectView`), `swift-rs` 1.0.7 (existing), React 18 + Ant Design 5 (existing).

**Reference spec:** [docs/superpowers/specs/2026-05-05-minitray-overlay-design.md](../specs/2026-05-05-minitray-overlay-design.md)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src-tauri/macos/MinitrayBridge/Package.swift` | Create | Swift package manifest, mirrors `SystemAudioBridge/Package.swift` |
| `src-tauri/macos/MinitrayBridge/Sources/MinitrayBridge/Minitray.swift` | Create | NSPanel UI + 4 `@_cdecl` exports + callback storage |
| `src-tauri/src/services/minitray.rs` | Create | Public API (`show_if_enabled`, `hide`, `update_level`, `install_callbacks`, `is_visible`), throttle, level poller |
| `src-tauri/build.rs` | Modify (`build_apple_speech_sidecar` neighbour) | Link the new Swift package via `swift_rs::SwiftLinker` |
| `src-tauri/src/services/mod.rs` | Modify | `pub mod minitray;` |
| `src-tauri/src/settings/public_settings.rs` | Modify | Add `show_minitray_overlay: bool` field + default |
| `src-tauri/src/commands/recording.rs` | Modify | After capture spawn → `minitray::show_if_enabled`; in stop path → `minitray::hide` |
| `src-tauri/src/commands/settings.rs` | Modify | After `save_settings`, if a recording is active and the toggle changed → show or hide |
| `src-tauri/src/services/pipeline_runner.rs` | Modify | Recording-error path → `minitray::hide` |
| `src-tauri/src/main.rs` | Modify | Call `minitray::install_callbacks(app.handle())` once at boot |
| `src/types/index.ts` | Modify | `show_minitray_overlay: boolean` on `PublicSettings` |
| `src/components/settings/GeneralSettings.tsx` | Modify | New `Checkbox` row labelled "Show minitray on top of all windows" |
| `src/App.main.test.tsx` / `src/App.tray.test.tsx` / `src/hooks/useRecordingController.test.ts` | Modify | Existing tests that pin full `PublicSettings` shape add the new field |

---

## Task 1: Add `show_minitray_overlay` to `PublicSettings` (Rust)

**Files:**
- Modify: `src-tauri/src/settings/public_settings.rs`
- Test: `src-tauri/src/settings/public_settings.rs` (existing `mod tests`)

- [ ] **Step 1: Write the failing test**

Append to the `#[cfg(test)] mod tests { ... }` block at the bottom of `src-tauri/src/settings/public_settings.rs`:

```rust
#[test]
fn show_minitray_overlay_defaults_to_false_when_field_is_absent() {
    let json = serde_json::json!({
        "transcription_provider": "nexara",
        "transcription_url": "",
        "transcription_task": "transcribe",
        "transcription_diarization_setting": "general",
    });
    let parsed: PublicSettings =
        serde_json::from_value(json).expect("legacy settings without show_minitray_overlay");
    assert!(!parsed.show_minitray_overlay);
}

#[test]
fn show_minitray_overlay_round_trips_through_serde() {
    let mut settings = PublicSettings::default();
    settings.show_minitray_overlay = true;
    let raw = serde_json::to_string(&settings).expect("serialize");
    let restored: PublicSettings = serde_json::from_str(&raw).expect("deserialize");
    assert!(restored.show_minitray_overlay);
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib show_minitray_overlay
```

Expected: both fail with "no field `show_minitray_overlay` on type `PublicSettings`".

- [ ] **Step 3: Add the field and default**

In `src-tauri/src/settings/public_settings.rs`, inside the `pub struct PublicSettings` declaration, add at the end (just before the closing brace):

```rust
    pub show_minitray_overlay: bool,
```

In `impl Default for PublicSettings { fn default() -> Self { Self { ... } } }`, add at the end of the field initializers:

```rust
            show_minitray_overlay: false,
```

The struct already has `#[serde(default)]` at the top, so the missing-field test passes via container-level default plus per-field `Default for bool` (= `false`).

- [ ] **Step 4: Run tests to verify they pass**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib show_minitray_overlay
```

Expected: both pass.

- [ ] **Step 5: Run the full backend lib test suite**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: all previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/settings/public_settings.rs
git commit -m "feat(settings): add show_minitray_overlay field"
```

---

## Task 2: Add field to frontend `PublicSettings` type and patch existing tests

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/App.main.test.tsx`
- Modify: `src/App.tray.test.tsx`
- Modify: `src/App.settings.test.tsx`
- Modify: `src/components/settings/YandexSyncSettings.test.tsx`
- Modify: `src/hooks/useRecordingController.test.ts` (only if it pins full PublicSettings — verify in step 1)

- [ ] **Step 1: Inventory existing pinned `PublicSettings` literals**

```bash
grep -nR "transcription_provider:\s*\"nexara\"" src/ | grep -v node_modules
```

Expected: a list of test files that construct full settings objects. Each one needs `show_minitray_overlay: false` added.

- [ ] **Step 2: Update `src/types/index.ts`**

In the `PublicSettings` type alias, add after `yandex_sync_remote_folder: string;`:

```ts
  show_minitray_overlay: boolean;
```

- [ ] **Step 3: Run tsc and tests; capture failures**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: TypeScript fails on every test file in step 1's list (missing required property `show_minitray_overlay`).

- [ ] **Step 4: Patch each pinned literal**

For every match found in step 1, add `show_minitray_overlay: false,` next to the other boolean fields. Example for `App.main.test.tsx` line ~31:

```ts
        transcription_provider: "nexara",
        // ...
        yandex_sync_remote_folder: "BigEcho",
        show_minitray_overlay: false,
      } satisfies PublicSettings,
```

(Only add `satisfies` if the existing literal already uses it — otherwise just add the field.)

- [ ] **Step 5: Re-run tsc and tests**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: tsc clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/App.main.test.tsx src/App.tray.test.tsx src/App.settings.test.tsx src/components/settings/YandexSyncSettings.test.tsx
# Plus useRecordingController.test.ts if step 1 included it
git commit -m "feat(types): add show_minitray_overlay to PublicSettings"
```

---

## Task 3: Render checkbox in General settings

**Files:**
- Modify: `src/components/settings/GeneralSettings.tsx`

- [ ] **Step 1: Write a failing test**

Append to `src/App.settings.test.tsx` inside the existing `describe("Settings page", () => { ... })` block:

```ts
it("toggles show_minitray_overlay via checkbox in Generals", async () => {
  const user = userEvent.setup();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") {
      return { ...defaultSettings, show_minitray_overlay: false };
    }
    if (cmd === "save_public_settings") {
      return "ok";
    }
    return null;
  });

  render(<App />);
  await user.click(await screen.findByRole("tab", { name: "Settings" }));
  await user.click(await screen.findByRole("tab", { name: "Generals" }));

  const checkbox = await screen.findByLabelText("Show minitray on top of all windows");
  expect(checkbox).not.toBeChecked();

  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith(
      "save_public_settings",
      expect.objectContaining({
        payload: expect.objectContaining({ show_minitray_overlay: true }),
      })
    );
  });
});
```

If `defaultSettings` is not a top-level helper in that file, copy the literal you used in Task 2 step 4 instead.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/App.settings.test.tsx -t "show_minitray_overlay"
```

Expected: fails — checkbox with that label not in the DOM.

- [ ] **Step 3: Add the checkbox to GeneralSettings**

In `src/components/settings/GeneralSettings.tsx`, add a new `<Form.Item>` immediately after the `api_call_logging_enabled` form item (currently the last `<Form.Item>` in the file, around line 178-189):

```tsx
      <Form.Item>
        <Checkbox
          id="show_minitray_overlay"
          aria-label="Show minitray on top of all windows"
          checked={Boolean(settings.show_minitray_overlay)}
          onChange={(event) =>
            setSettings({ ...settings, show_minitray_overlay: event.target.checked })
          }
        >
          Show minitray on top of all windows{isDirty("show_minitray_overlay") && dirtyDot}
        </Checkbox>
      </Form.Item>
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/App.settings.test.tsx -t "show_minitray_overlay"
```

Expected: passes.

- [ ] **Step 5: Run the full vitest suite + tsc**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/GeneralSettings.tsx src/App.settings.test.tsx
git commit -m "feat(settings-ui): add 'Show minitray' checkbox in Generals"
```

---

## Task 4: Create the Rust `services::minitray` module (no-op stubs + state)

This task lays down the public API used by all later tasks. The macOS side has FFI declarations but the Swift symbols don't exist yet — we'll provide them as link-time stubs in Task 8 before any code calls into them. To keep this task self-contained and unblockable, we route all FFI calls through a function-pointer indirection (`SINK`) so tests (and the bootstrap path before the Swift bridge is wired) never touch real FFI.

**Files:**
- Create: `src-tauri/src/services/minitray.rs`
- Modify: `src-tauri/src/services/mod.rs`

- [ ] **Step 1: Declare the new module**

In `src-tauri/src/services/mod.rs`, add (in alphabetical order with the existing `pub mod` lines):

```rust
pub mod minitray;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/services/minitray.rs` with the test module first (before the implementation):

```rust
//! Floating minitray overlay (NSPanel on macOS; no-op elsewhere).
//!
//! Public API:
//!   - `install_sinks(stop, icon, level)` — wire the FFI/event sinks at boot.
//!   - `show_if_enabled(settings)` — show panel iff setting is on and not visible.
//!   - `hide()` — hide panel if visible.
//!   - `update_level(level)` — push current level to panel (throttled to ~30 Hz).
//!   - `is_visible()` — current state.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use crate::settings::public_settings::PublicSettings;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    fn reset_state_for_test() {
        VISIBLE.store(false, Ordering::SeqCst);
        LAST_PUSH_NANOS.store(0, Ordering::SeqCst);
    }

    #[test]
    fn show_if_enabled_is_noop_when_setting_is_off() {
        reset_state_for_test();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_sink = Arc::clone(&calls);
        install_show_sink_for_test(Box::new(move || {
            calls_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = false;
        show_if_enabled(&settings);

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!is_visible());
    }

    #[test]
    fn show_if_enabled_calls_sink_when_setting_is_on() {
        reset_state_for_test();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_sink = Arc::clone(&calls);
        install_show_sink_for_test(Box::new(move || {
            calls_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings);

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(is_visible());
    }

    #[test]
    fn show_if_enabled_is_idempotent() {
        reset_state_for_test();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_sink = Arc::clone(&calls);
        install_show_sink_for_test(Box::new(move || {
            calls_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings);
        show_if_enabled(&settings);
        show_if_enabled(&settings);

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hide_resets_visibility_and_calls_sink_once() {
        reset_state_for_test();
        let show_calls = Arc::new(AtomicUsize::new(0));
        let show_for_sink = Arc::clone(&show_calls);
        install_show_sink_for_test(Box::new(move || {
            show_for_sink.fetch_add(1, Ordering::SeqCst);
        }));
        let hide_calls = Arc::new(AtomicUsize::new(0));
        let hide_for_sink = Arc::clone(&hide_calls);
        install_hide_sink_for_test(Box::new(move || {
            hide_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings);
        assert!(is_visible());

        hide();
        assert!(!is_visible());
        assert_eq!(hide_calls.load(Ordering::SeqCst), 1);

        // Subsequent hide while not visible: no extra FFI call.
        hide();
        assert_eq!(hide_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn update_level_throttles_high_frequency_pushes() {
        reset_state_for_test();
        let pushes = Arc::new(AtomicUsize::new(0));
        let pushes_for_sink = Arc::clone(&pushes);
        install_show_sink_for_test(Box::new(|| {}));
        install_level_sink_for_test(Box::new(move |_| {
            pushes_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings);

        // Drive 1000 quick updates back-to-back.
        for _ in 0..1000 {
            update_level(0.5);
        }

        let n = pushes.load(Ordering::SeqCst);
        // First call always passes; subsequent calls within 33ms are throttled.
        // Loose upper bound — we expect 1 if the loop runs faster than 33ms,
        // but allow up to 5 in case the test runs slowly.
        assert!(n >= 1 && n <= 5, "pushes was {}", n);
    }

    #[test]
    fn update_level_is_noop_when_not_visible() {
        reset_state_for_test();
        let pushes = Arc::new(AtomicUsize::new(0));
        let pushes_for_sink = Arc::clone(&pushes);
        install_level_sink_for_test(Box::new(move |_| {
            pushes_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        update_level(0.5);
        assert_eq!(pushes.load(Ordering::SeqCst), 0);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib services::minitray
```

Expected: compile errors — `VISIBLE`, `LAST_PUSH_NANOS`, `show_if_enabled`, `hide`, `update_level`, `is_visible`, `install_show_sink_for_test`, `install_hide_sink_for_test`, `install_level_sink_for_test` are not defined.

- [ ] **Step 4: Implement the module**

Above the `#[cfg(test)] mod tests` block in the same file, add:

```rust
type ShowSink = Box<dyn Fn() + Send + Sync>;
type HideSink = Box<dyn Fn() + Send + Sync>;
type LevelSink = Box<dyn Fn(f32) + Send + Sync>;

static VISIBLE: AtomicBool = AtomicBool::new(false);
static LAST_PUSH_NANOS: AtomicU64 = AtomicU64::new(0);
static EPOCH: OnceLock<Instant> = OnceLock::new();

static SHOW_SINK: OnceLock<ShowSink> = OnceLock::new();
static HIDE_SINK: OnceLock<HideSink> = OnceLock::new();
static LEVEL_SINK: OnceLock<LevelSink> = OnceLock::new();

const MIN_PUSH_INTERVAL_NS: u64 = 33_000_000; // ~30 Hz

fn now_nanos() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

/// Wire the production sinks. Call once at app boot.
/// On macOS the sinks invoke `bigecho_minitray_*` FFI; on other platforms
/// they're no-ops. Test code calls `install_*_sink_for_test` instead.
pub fn install_production_sinks() {
    #[cfg(target_os = "macos")]
    {
        let _ = SHOW_SINK.set(Box::new(|| unsafe { bigecho_minitray_show() }));
        let _ = HIDE_SINK.set(Box::new(|| unsafe { bigecho_minitray_hide() }));
        let _ = LEVEL_SINK.set(Box::new(|level| unsafe {
            bigecho_minitray_update_level(level)
        }));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = SHOW_SINK.set(Box::new(|| {}));
        let _ = HIDE_SINK.set(Box::new(|| {}));
        let _ = LEVEL_SINK.set(Box::new(|_| {}));
    }
}

pub fn show_if_enabled(settings: &PublicSettings) {
    if !settings.show_minitray_overlay {
        return;
    }
    if VISIBLE.swap(true, Ordering::SeqCst) {
        // Already visible; nothing to do.
        return;
    }
    if let Some(sink) = SHOW_SINK.get() {
        sink();
    }
}

pub fn hide() {
    if !VISIBLE.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(sink) = HIDE_SINK.get() {
        sink();
    }
}

pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::SeqCst)
}

pub fn update_level(level: f32) {
    if !VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    let now = now_nanos();
    let last = LAST_PUSH_NANOS.load(Ordering::SeqCst);
    if now.saturating_sub(last) < MIN_PUSH_INTERVAL_NS {
        return;
    }
    if LAST_PUSH_NANOS
        .compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // Another thread won the race.
    }
    if let Some(sink) = LEVEL_SINK.get() {
        sink(level);
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn bigecho_minitray_show();
    fn bigecho_minitray_hide();
    fn bigecho_minitray_update_level(level: f32);
}

// Test-only sink installers. `OnceLock` would block re-installation between
// tests, so the test variants use `Mutex<Option<...>>` and a parallel sink
// resolver. To keep production code lean we just shadow `SHOW_SINK` etc.
// with mutex-backed cells under `#[cfg(test)]`.
#[cfg(test)]
mod test_sinks {
    use super::*;
    use std::sync::Mutex;

    pub static TEST_SHOW: Mutex<Option<ShowSink>> = Mutex::new(None);
    pub static TEST_HIDE: Mutex<Option<HideSink>> = Mutex::new(None);
    pub static TEST_LEVEL: Mutex<Option<LevelSink>> = Mutex::new(None);
}

#[cfg(test)]
pub(crate) fn install_show_sink_for_test(sink: ShowSink) {
    *test_sinks::TEST_SHOW.lock().unwrap() = Some(sink);
}

#[cfg(test)]
pub(crate) fn install_hide_sink_for_test(sink: HideSink) {
    *test_sinks::TEST_HIDE.lock().unwrap() = Some(sink);
}

#[cfg(test)]
pub(crate) fn install_level_sink_for_test(sink: LevelSink) {
    *test_sinks::TEST_LEVEL.lock().unwrap() = Some(sink);
}
```

The above won't actually wire the test sinks into `show_if_enabled` etc. yet — we have two parallel storage locations. Refactor: thread the test sinks into the production code paths.

Replace the `if let Some(sink) = SHOW_SINK.get() { sink(); }` line in `show_if_enabled` with a helper that consults the test sink first when in test mode:

```rust
fn call_show_sink() {
    #[cfg(test)]
    {
        if let Some(sink) = test_sinks::TEST_SHOW.lock().unwrap().as_ref() {
            sink();
            return;
        }
    }
    if let Some(sink) = SHOW_SINK.get() {
        sink();
    }
}

fn call_hide_sink() {
    #[cfg(test)]
    {
        if let Some(sink) = test_sinks::TEST_HIDE.lock().unwrap().as_ref() {
            sink();
            return;
        }
    }
    if let Some(sink) = HIDE_SINK.get() {
        sink();
    }
}

fn call_level_sink(level: f32) {
    #[cfg(test)]
    {
        if let Some(sink) = test_sinks::TEST_LEVEL.lock().unwrap().as_ref() {
            sink(level);
            return;
        }
    }
    if let Some(sink) = LEVEL_SINK.get() {
        sink(level);
    }
}
```

Then `show_if_enabled` calls `call_show_sink()`, `hide` calls `call_hide_sink()`, `update_level` calls `call_level_sink(level)`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib services::minitray
```

Expected: 6 tests pass.

Note: tests share global state (`VISIBLE`, `LAST_PUSH_NANOS`, test sinks). Each test calls `reset_state_for_test()` first; cargo runs tests in this module concurrently by default, which can race. If you see flakes, add `--test-threads=1` for this module or guard with a `static TEST_LOCK: Mutex<()>`.

If flaking, add at the top of `mod tests`:

```rust
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
```

And take the lock at the start of each test:

```rust
let _guard = TEST_LOCK.lock().unwrap();
```

- [ ] **Step 6: Run full lib tests to confirm nothing else broke**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/services/minitray.rs src-tauri/src/services/mod.rs
git commit -m "feat(minitray): rust module skeleton with throttle + test sinks"
```

---

## Task 5: Hook minitray show/hide into recording start/stop

**Files:**
- Modify: `src-tauri/src/commands/recording.rs`

- [ ] **Step 1: Read the current start/stop functions**

Open `src-tauri/src/commands/recording.rs`. Locate `fn start_recording_impl(...)` (around line 102) and `pub fn stop_recording(...)` (around line 230). Identify the success-paths just before each function returns `Ok(...)`.

- [ ] **Step 2: Write a failing test**

Append to the existing `#[cfg(test)] mod tests` block in `recording.rs`:

```rust
#[test]
fn start_recording_shows_minitray_when_setting_is_on() {
    use crate::services::minitray;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let show_calls = Arc::new(AtomicUsize::new(0));
    let show_for_sink = Arc::clone(&show_calls);
    minitray::install_show_sink_for_test(Box::new(move || {
        show_for_sink.fetch_add(1, Ordering::SeqCst);
    }));

    // Construct a minimal AppState + AppDirs in a tempdir, save settings
    // with show_minitray_overlay = true, then call start_recording_impl.
    // Use the existing test scaffolding pattern: see other tests in this
    // file (e.g. `start_recording_*`) for the full setup.
    let (state, dirs, _tmp) = make_test_app_state_with_settings(|s| {
        s.show_minitray_overlay = true;
    });

    let resp = start_recording_impl(
        &state,
        &dirs,
        StartRecordingRequest {
            source: "slack".into(),
            topic: "".into(),
            tags: vec![],
            notes: "".into(),
        },
    )
    .expect("start_recording_impl");

    assert!(!resp.session_id.is_empty());
    assert!(minitray::is_visible());
    assert_eq!(show_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn stop_recording_hides_minitray() {
    use crate::services::minitray;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let hide_calls = Arc::new(AtomicUsize::new(0));
    let hide_for_sink = Arc::clone(&hide_calls);
    minitray::install_hide_sink_for_test(Box::new(move || {
        hide_for_sink.fetch_add(1, Ordering::SeqCst);
    }));
    minitray::install_show_sink_for_test(Box::new(|| {}));

    let (state, dirs, _tmp) = make_test_app_state_with_settings(|s| {
        s.show_minitray_overlay = true;
    });

    let resp = start_recording_impl(
        &state,
        &dirs,
        StartRecordingRequest {
            source: "slack".into(),
            topic: "".into(),
            tags: vec![],
            notes: "".into(),
        },
    )
    .expect("start_recording_impl");

    stop_recording_impl(&state, &dirs, resp.session_id).expect("stop_recording_impl");

    assert!(!minitray::is_visible());
    assert_eq!(hide_calls.load(Ordering::SeqCst), 1);
}
```

If `make_test_app_state_with_settings` doesn't already exist as a helper in the test module, create it next to the other helpers. Inspect the existing `start_recording` tests (around lines 380-480) to copy their `tempdir + AppState::default + save_settings` setup; wrap that into a helper with a closure that lets each test mutate settings before save. Example sketch:

```rust
fn make_test_app_state_with_settings(
    mutate: impl FnOnce(&mut PublicSettings),
) -> (AppState, AppDirs, tempfile::TempDir) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dirs = AppDirs { app_data_dir: tmp.path().to_path_buf() };
    let mut settings = PublicSettings::default();
    settings.recording_root = tmp.path().join("recordings").to_string_lossy().to_string();
    mutate(&mut settings);
    save_settings(&dirs.app_data_dir, &settings).expect("save settings");
    let state = AppState::default();
    (state, dirs, tmp)
}
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib commands::recording::tests::start_recording_shows_minitray_when_setting_is_on commands::recording::tests::stop_recording_hides_minitray
```

Expected: fail — `start_recording_impl` doesn't currently call `minitray::show_if_enabled`, `stop_recording_impl` doesn't call `minitray::hide`.

- [ ] **Step 4: Wire show into start_recording_impl**

In `src-tauri/src/commands/recording.rs`, immediately before the existing `Ok(StartRecordingResponse { ... })` at the end of `start_recording_impl`, add:

```rust
    // Show floating minitray overlay if the user opted in.
    crate::services::minitray::show_if_enabled(&settings);
```

(`settings` is the local variable holding the loaded `PublicSettings` — reuse whatever name it already has in this function. If `settings` isn't loaded yet at that point, hoist the existing `load_settings(...)` call earlier or pass through.)

- [ ] **Step 5: Wire hide into the stop path**

Locate every place where the recording successfully ends. In `stop_recording_impl` (find the function body just below `pub fn stop_recording`), add immediately before the function returns `Ok(...)`:

```rust
    crate::services::minitray::hide();
```

Also add the same `hide()` call in the early-error path inside `stop_recording_impl` if it already cleans up state (search for `*active = None` or similar).

- [ ] **Step 6: Run the tests to verify they pass**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib commands::recording::tests::start_recording_shows_minitray_when_setting_is_on commands::recording::tests::stop_recording_hides_minitray
```

Expected: both pass.

- [ ] **Step 7: Run full lib tests**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands/recording.rs
git commit -m "feat(minitray): show on recording start, hide on stop"
```

---

## Task 6: Hide minitray on pipeline error path

**Files:**
- Modify: `src-tauri/src/services/pipeline_runner.rs`

- [ ] **Step 1: Locate the error-cleanup branches**

```bash
grep -n "mark_pipeline_audio_missing\|mark_pipeline_transcription_failed" src-tauri/src/services/pipeline_runner.rs | head -10
```

These mark the failure points. The recording lifecycle is split: capture failure happens during `start_recording_impl` (already covered by Task 5's success-path bookkeeping — capture failure means we never reach `show_if_enabled`). Pipeline failure happens *after* recording stopped, so by then `minitray::hide` was already called by `stop_recording_impl`. **Confirm this is true:** trace whether `pipeline_runner` is invoked while recording is still going. If yes, add `minitray::hide()` to its error paths. If no, this task collapses to a no-op (skip the file modification, just commit a note).

- [ ] **Step 2: Decide and document**

If no pipeline failure can occur while recording is still active (the common case), append a one-line rustdoc comment on `pub fn run_pipeline_core` in `pipeline_runner.rs`:

```rust
/// Runs after `stop_recording`, so the minitray (if shown) was already hidden
/// by `stop_recording_impl`. No additional `minitray::hide()` calls needed here.
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/services/pipeline_runner.rs
git commit -m "docs(pipeline): note minitray cleanup happens in stop_recording"
```

If the trace in step 1 *did* find an active-recording error path, replace step 2 with the actual `minitray::hide()` insertion and a regression test mirroring Task 5 step 2.

---

## Task 7: Hook settings save for mid-recording toggle

**Files:**
- Modify: `src-tauri/src/commands/settings.rs`

- [ ] **Step 1: Read the current save command**

```bash
sed -n '1,80p' src-tauri/src/commands/settings.rs
```

Identify `pub fn save_public_settings(...)` — note where it returns `Ok` after persisting.

- [ ] **Step 2: Write a failing test**

Append to the existing `#[cfg(test)] mod tests` block in `settings.rs` (or create one if missing):

```rust
#[test]
fn save_public_settings_shows_minitray_when_toggled_on_during_active_recording() {
    use crate::services::minitray;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let show_calls = Arc::new(AtomicUsize::new(0));
    let show_for_sink = Arc::clone(&show_calls);
    minitray::install_show_sink_for_test(Box::new(move || {
        show_for_sink.fetch_add(1, Ordering::SeqCst);
    }));
    minitray::install_hide_sink_for_test(Box::new(|| {}));

    let tmp = tempfile::tempdir().expect("tempdir");
    let dirs = AppDirs { app_data_dir: tmp.path().to_path_buf() };
    let state = AppState::default();
    *state.active_session.lock().unwrap() = Some(SessionMeta::new(
        "s-1".into(), "slack".into(), vec![], "topic".into(), "".into(),
    ));

    let mut payload = PublicSettings::default();
    payload.show_minitray_overlay = true;
    save_public_settings_impl(&dirs, &state, payload).expect("save");

    assert!(minitray::is_visible());
    assert_eq!(show_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn save_public_settings_hides_minitray_when_toggled_off_during_active_recording() {
    use crate::services::minitray;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let hide_calls = Arc::new(AtomicUsize::new(0));
    let hide_for_sink = Arc::clone(&hide_calls);
    minitray::install_show_sink_for_test(Box::new(|| {}));
    minitray::install_hide_sink_for_test(Box::new(move || {
        hide_for_sink.fetch_add(1, Ordering::SeqCst);
    }));

    let tmp = tempfile::tempdir().expect("tempdir");
    let dirs = AppDirs { app_data_dir: tmp.path().to_path_buf() };
    let state = AppState::default();
    *state.active_session.lock().unwrap() = Some(SessionMeta::new(
        "s-2".into(), "slack".into(), vec![], "topic".into(), "".into(),
    ));

    // Pretend it was visible before:
    let mut on_payload = PublicSettings::default();
    on_payload.show_minitray_overlay = true;
    save_public_settings_impl(&dirs, &state, on_payload).expect("first save");

    let mut off_payload = PublicSettings::default();
    off_payload.show_minitray_overlay = false;
    save_public_settings_impl(&dirs, &state, off_payload).expect("second save");

    assert!(!minitray::is_visible());
    assert_eq!(hide_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn save_public_settings_does_not_show_minitray_without_active_recording() {
    use crate::services::minitray;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let show_calls = Arc::new(AtomicUsize::new(0));
    let show_for_sink = Arc::clone(&show_calls);
    minitray::install_show_sink_for_test(Box::new(move || {
        show_for_sink.fetch_add(1, Ordering::SeqCst);
    }));

    let tmp = tempfile::tempdir().expect("tempdir");
    let dirs = AppDirs { app_data_dir: tmp.path().to_path_buf() };
    let state = AppState::default();
    // No active_session set → no recording in progress.

    let mut payload = PublicSettings::default();
    payload.show_minitray_overlay = true;
    save_public_settings_impl(&dirs, &state, payload).expect("save");

    assert_eq!(show_calls.load(Ordering::SeqCst), 0);
}
```

If `save_public_settings_impl` doesn't currently exist (the public function takes Tauri `State<'_, _>` directly), extract a thin `_impl` that takes `&AppDirs` and `&AppState` so it's testable. Mirror the pattern used in `commands/sessions.rs::update_session_details_impl` (we did this earlier in the project for the same reason).

- [ ] **Step 3: Run the tests to verify they fail**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib commands::settings::tests::save_public_settings_shows_minitray commands::settings::tests::save_public_settings_hides_minitray commands::settings::tests::save_public_settings_does_not_show_minitray
```

Expected: fail.

- [ ] **Step 4: Implement the toggle handler**

In `save_public_settings_impl` (extract or modify), after persisting settings to disk, before returning `Ok(...)`, add:

```rust
    let recording_active = state
        .active_session
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);
    if recording_active {
        if payload.show_minitray_overlay {
            crate::services::minitray::show_if_enabled(&payload);
        } else {
            crate::services::minitray::hide();
        }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib commands::settings::tests
```

Expected: pass.

- [ ] **Step 6: Run full lib + bin tests**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib --bins
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/settings.rs
git commit -m "feat(minitray): show/hide on settings toggle during recording"
```

---

## Task 8: Pump levels via tokio poller while panel is visible

**Files:**
- Modify: `src-tauri/src/services/minitray.rs`
- Modify: `src-tauri/src/commands/recording.rs` (pass `SharedLevels` into `show_if_enabled`)

- [ ] **Step 1: Decide the API**

Change `show_if_enabled` to accept the levels handle:

```rust
pub fn show_if_enabled(settings: &PublicSettings, levels: &SharedLevels);
```

Inside, after the visibility flip, spawn a tokio task that polls every 33 ms:

```rust
loop {
    if !is_visible() { break; }
    let snap = levels.snapshot();
    let combined = snap.mic.max(snap.system);
    update_level(combined);
    tokio::time::sleep(std::time::Duration::from_millis(33)).await;
}
```

Store the `JoinHandle` in a `Mutex<Option<tokio::task::JoinHandle<()>>>` so `hide()` can abort it.

- [ ] **Step 2: Write a failing test**

Append to `services::minitray::tests`:

```rust
#[tokio::test]
async fn show_pumps_levels_until_hide() {
    use crate::audio::capture::SharedLevels;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let _guard = TEST_LOCK.lock().unwrap();
    reset_state_for_test();

    let pushes = Arc::new(AtomicUsize::new(0));
    let pushes_for_sink = Arc::clone(&pushes);
    install_show_sink_for_test(Box::new(|| {}));
    install_hide_sink_for_test(Box::new(|| {}));
    install_level_sink_for_test(Box::new(move |_| {
        pushes_for_sink.fetch_add(1, Ordering::SeqCst);
    }));

    let levels = SharedLevels::new();
    levels.set_mic(0.4);
    levels.set_system(0.7);

    let mut settings = PublicSettings::default();
    settings.show_minitray_overlay = true;
    show_if_enabled(&settings, &levels);

    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    let n = pushes.load(Ordering::SeqCst);
    assert!(n >= 2, "expected at least 2 level pushes within 120ms, got {}", n);

    hide();
    let after_hide = pushes.load(Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let final_count = pushes.load(Ordering::SeqCst);
    assert_eq!(final_count, after_hide, "poller should stop after hide()");
}
```

- [ ] **Step 3: Run the test (should fail to compile — `show_if_enabled` signature)**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib services::minitray::tests::show_pumps_levels_until_hide
```

Expected: compile error.

- [ ] **Step 4: Update the API and add the poller**

In `services/minitray.rs`:

```rust
use crate::audio::capture::SharedLevels;
use std::sync::Mutex;

static POLLER: Mutex<Option<tokio::task::JoinHandle<()>>> = Mutex::new(None);

pub fn show_if_enabled(settings: &PublicSettings, levels: &SharedLevels) {
    if !settings.show_minitray_overlay { return; }
    if VISIBLE.swap(true, Ordering::SeqCst) { return; }
    call_show_sink();

    let levels = levels.clone();
    let handle = tokio::spawn(async move {
        loop {
            if !VISIBLE.load(Ordering::SeqCst) { break; }
            let snap = levels.snapshot();
            let combined = snap.mic.max(snap.system);
            update_level(combined);
            tokio::time::sleep(std::time::Duration::from_millis(33)).await;
        }
    });
    *POLLER.lock().unwrap() = Some(handle);
}

pub fn hide() {
    if !VISIBLE.swap(false, Ordering::SeqCst) { return; }
    if let Some(handle) = POLLER.lock().unwrap().take() {
        handle.abort();
    }
    call_hide_sink();
}
```

Update existing show-only tests in Task 4 to pass `&SharedLevels::new()` as the second argument.

- [ ] **Step 5: Update Task 5 callsites**

In `start_recording_impl`, pass `&state.live_levels`:

```rust
crate::services::minitray::show_if_enabled(&settings, &state.live_levels);
```

In `save_public_settings_impl` (Task 7), pass `&state.live_levels`:

```rust
crate::services::minitray::show_if_enabled(&payload, &state.live_levels);
```

- [ ] **Step 6: Run the tests**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib services::minitray
```

Expected: all minitray tests pass, including the new poller test.

- [ ] **Step 7: Run full lib + bin tests**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib --bins
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/services/minitray.rs src-tauri/src/commands/recording.rs src-tauri/src/commands/settings.rs
git commit -m "feat(minitray): poll SharedLevels every 33ms while visible"
```

---

## Task 9: Create MinitrayBridge Swift package (link-time stubs only)

This task gets the Swift package compiling and linked into the Rust binary with empty function bodies, so the cross-language wiring is exercised without real UI yet. Real UI lands in Task 10.

**Files:**
- Create: `src-tauri/macos/MinitrayBridge/Package.swift`
- Create: `src-tauri/macos/MinitrayBridge/Sources/MinitrayBridge/Minitray.swift`
- Modify: `src-tauri/build.rs`

- [ ] **Step 1: Create Package.swift**

Write `src-tauri/macos/MinitrayBridge/Package.swift`:

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MinitrayBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "MinitrayBridge", type: .static, targets: ["MinitrayBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.7"),
    ],
    targets: [
        .target(
            name: "MinitrayBridge",
            dependencies: [
                .product(name: "SwiftRs", package: "swift-rs"),
            ]
        ),
    ]
)
```

- [ ] **Step 2: Create Minitray.swift with empty exports**

Write `src-tauri/macos/MinitrayBridge/Sources/MinitrayBridge/Minitray.swift`:

```swift
import AppKit
import SwiftRs

// Stubs — real UI lands in the next task.
@_cdecl("bigecho_minitray_show")
public func bigecho_minitray_show() {
    // TODO: implement in Task 10
}

@_cdecl("bigecho_minitray_hide")
public func bigecho_minitray_hide() {
    // TODO: implement in Task 10
}

@_cdecl("bigecho_minitray_update_level")
public func bigecho_minitray_update_level(_ level: Float) {
    _ = level  // suppress unused warning in stub
    // TODO: implement in Task 10
}

@_cdecl("bigecho_minitray_set_callbacks")
public func bigecho_minitray_set_callbacks(
    onStop: @convention(c) () -> Void,
    onIcon: @convention(c) () -> Void
) {
    _ = onStop
    _ = onIcon
    // TODO: implement in Task 10
}
```

(The `TODO`s here are scoped within Task 10, not stand-alone — Task 10 fully implements them.)

- [ ] **Step 3: Wire build.rs to link the new package**

Open `src-tauri/build.rs`. The current macOS path (lines 4-6) is:

```rust
swift_rs::SwiftLinker::new("13.0")
    .with_package("SystemAudioBridge", "macos/SystemAudioBridge")
    .link();
```

Replace with:

```rust
swift_rs::SwiftLinker::new("13.0")
    .with_package("SystemAudioBridge", "macos/SystemAudioBridge")
    .with_package("MinitrayBridge", "macos/MinitrayBridge")
    .link();
```

- [ ] **Step 4: Wire the production sinks at boot**

In `src-tauri/src/main.rs`, locate the Tauri setup hook (around line 339 where `prewarm_tray_window` is called). Add immediately after it:

```rust
crate::services::minitray::install_production_sinks();
```

- [ ] **Step 5: Build and verify linking**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: succeeds. If you get "undefined symbol `bigecho_minitray_*`", verify swift-rs picked up the new package (check the target/build/.../out/swift-rs/MinitrayBridge directory exists).

- [ ] **Step 6: Run full lib + bin tests**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib --bins
```

Expected: all pass. The Swift stubs are linked in but unused by tests (tests use injected sinks).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/macos/MinitrayBridge src-tauri/build.rs src-tauri/src/main.rs
git commit -m "build(minitray): link MinitrayBridge swift package with stub exports"
```

---

## Task 10: Implement the Swift NSPanel UI and Rust→Swift callbacks

This task is largely manual-QA-validated because we can't unit-test AppKit drawing cheaply.

**Files:**
- Modify: `src-tauri/macos/MinitrayBridge/Sources/MinitrayBridge/Minitray.swift`
- Modify: `src-tauri/src/services/minitray.rs` (callbacks)
- Modify: `src-tauri/src/main.rs` (pass app handle into install)

- [ ] **Step 1: Implement Minitray.swift**

Replace the entire file with:

```swift
import AppKit
import SwiftRs

private final class LevelMeterView: NSView {
    private let barCount = 12
    private var level: Float = 0

    func setLevel(_ value: Float) {
        let clamped = max(0, min(1, value))
        if abs(clamped - level) < 0.005 { return }
        level = clamped
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let barWidth: CGFloat = 4
        let gap: CGFloat = 3
        let totalWidth = CGFloat(barCount) * barWidth + CGFloat(barCount - 1) * gap
        let startX = (bounds.width - totalWidth) / 2
        let activeBars = Int(round(Float(barCount) * level))
        let active = NSColor.controlAccentColor.cgColor
        let dim = NSColor.tertiaryLabelColor.cgColor
        for i in 0..<barCount {
            let x = startX + CGFloat(i) * (barWidth + gap)
            let rect = CGRect(x: x, y: bounds.midY - 6, width: barWidth, height: 12)
            ctx.setFillColor(i < activeBars ? active : dim)
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: 1, cornerHeight: 1, transform: nil))
            ctx.fillPath()
        }
    }
}

private final class IconHitView: NSImageView {
    var onClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
    override var acceptsFirstResponder: Bool { true }
}

@MainActor
final class MinitrayController {
    static let shared = MinitrayController()

    private var panel: NSPanel?
    private var meterView: LevelMeterView?
    fileprivate var onStop: (@convention(c) () -> Void)?
    fileprivate var onIcon: (@convention(c) () -> Void)?

    func show() {
        if panel == nil {
            buildPanel()
        }
        positionAtTopCenter()
        panel?.alphaValue = 1
        panel?.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    func updateLevel(_ level: Float) {
        meterView?.setLevel(level)
    }

    private func buildPanel() {
        let width: CGFloat = 200
        let height: CGFloat = 36
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear

        let blur = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 12
        blur.layer?.masksToBounds = true

        let icon = IconHitView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.onClick = { [weak self] in self?.onIcon?() }

        let meter = LevelMeterView()
        meter.translatesAutoresizingMaskIntoConstraints = false
        meterView = meter

        let stop = NSButton()
        stop.bezelStyle = .accessoryBar
        stop.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: "Stop recording")
        stop.imagePosition = .imageOnly
        stop.target = self
        stop.action = #selector(stopClicked)
        stop.translatesAutoresizingMaskIntoConstraints = false

        blur.addSubview(icon)
        blur.addSubview(meter)
        blur.addSubview(stop)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 8),
            icon.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 22),
            icon.heightAnchor.constraint(equalToConstant: 22),

            meter.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            meter.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            meter.heightAnchor.constraint(equalToConstant: 16),
            meter.trailingAnchor.constraint(equalTo: stop.leadingAnchor, constant: -8),

            stop.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -8),
            stop.centerYAnchor.constraint(equalTo: blur.centerYAnchor),
            stop.widthAnchor.constraint(equalToConstant: 22),
            stop.heightAnchor.constraint(equalToConstant: 22),
        ])

        panel.contentView = blur
        self.panel = panel
    }

    private func positionAtTopCenter() {
        guard let panel = panel else { return }
        let cursorScreen = NSScreen.screens.first { NSPointInRect(NSEvent.mouseLocation, $0.frame) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen = cursorScreen else { return }
        let frame = panel.frame
        let x = screen.frame.midX - frame.width / 2
        let y = screen.frame.maxY - frame.height - 8
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    @objc private func stopClicked() {
        onStop?()
    }
}

@_cdecl("bigecho_minitray_show")
public func bigecho_minitray_show() {
    DispatchQueue.main.async { MinitrayController.shared.show() }
}

@_cdecl("bigecho_minitray_hide")
public func bigecho_minitray_hide() {
    DispatchQueue.main.async { MinitrayController.shared.hide() }
}

@_cdecl("bigecho_minitray_update_level")
public func bigecho_minitray_update_level(_ level: Float) {
    DispatchQueue.main.async { MinitrayController.shared.updateLevel(level) }
}

@_cdecl("bigecho_minitray_set_callbacks")
public func bigecho_minitray_set_callbacks(
    onStop: @convention(c) () -> Void,
    onIcon: @convention(c) () -> Void
) {
    DispatchQueue.main.async {
        MinitrayController.shared.onStop = onStop
        MinitrayController.shared.onIcon = onIcon
    }
}
```

- [ ] **Step 2: Wire the Rust callbacks**

In `src-tauri/src/services/minitray.rs`, declare the callbacks-FFI and add `install_callbacks`:

```rust
#[cfg(target_os = "macos")]
extern "C" {
    fn bigecho_minitray_set_callbacks(
        on_stop: extern "C" fn(),
        on_icon: extern "C" fn(),
    );
}

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

extern "C" fn on_stop_clicked() {
    if let Some(app) = APP_HANDLE.get() {
        // Reuse the existing channel that the recording controller already
        // listens to. This stops the recording, which in turn calls hide().
        let _ = tauri::Emitter::emit(app, "tray:stop", ());
    }
}

extern "C" fn on_icon_clicked() {
    if let Some(app) = APP_HANDLE.get() {
        let _ = crate::window_manager::open_tray_window_internal(app);
    }
}

pub fn install_callbacks(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
    #[cfg(target_os = "macos")]
    unsafe {
        bigecho_minitray_set_callbacks(on_stop_clicked, on_icon_clicked);
    }
}
```

- [ ] **Step 3: Call `install_callbacks` from main.rs**

In `src-tauri/src/main.rs`, replace the `install_production_sinks()` call from Task 9 step 4 with the combined boot sequence:

```rust
crate::services::minitray::install_production_sinks();
crate::services::minitray::install_callbacks(app.handle().clone());
```

- [ ] **Step 4: Build**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: clean.

- [ ] **Step 5: Run full lib + bin tests**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib --bins
```

Expected: all pass. (No new tests in this task — UI is manual.)

- [ ] **Step 6: Manual QA in `tauri dev`**

Run the app:

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 npm run tauri -- dev
```

Verify:

1. Open Settings → Generals. Toggle "Show minitray on top of all windows" ON. Save.
2. Start a recording. The minitray appears centred at the top of the screen where the cursor is.
3. The level meter animates while you speak / play system audio.
4. Click the BigEcho icon in the minitray → existing tray popover opens; minitray stays.
5. Click the stop button → recording stops AND minitray disappears.
6. Restart a recording, then toggle the setting OFF in Settings → minitray disappears immediately.
7. Toggle ON during recording → minitray reappears.
8. Switch to a full-screen Safari window → minitray still visible.
9. Drag a window to a second monitor (if available), move cursor there, start recording → minitray appears on that monitor.
10. Stop recording from the main window's Stop button → minitray also disappears.

If anything misbehaves, fix in Minitray.swift / minitray.rs before committing.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/macos/MinitrayBridge src-tauri/src/services/minitray.rs src-tauri/src/main.rs
git commit -m "feat(minitray): NSPanel UI + stop/icon callbacks"
```

---

## Task 11: Final verification pass

- [ ] **Step 1: Run all backend tests**

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib --bins
```

Expected: all pass.

- [ ] **Step 2: Run all frontend tests + tsc**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: clean / all pass.

- [ ] **Step 3: Smoke-test `tauri build`**

```bash
rm -rf src-tauri/target/release/bundle
CMAKE_POLICY_VERSION_MINIMUM=3.5 npm run tauri -- build
```

Expected: bundle written to `src-tauri/target/release/bundle/macos/BigEcho.app/`.

- [ ] **Step 4: Verify the bundle**

```bash
ls -la src-tauri/target/release/bundle/macos/BigEcho.app/Contents/MacOS/
```

Expected: `bigecho` is present. (No new external binary — MinitrayBridge is statically linked into `bigecho`.)

- [ ] **Step 5: Run the bundled app and re-check the manual QA list from Task 10 step 6**

Open the `.app` from Finder. Repeat checks 1–10. Pay special attention to:

- macOS displays the panel correctly outside `tauri dev`
- The icon and stop button are clickable
- No console crashes (`Console.app` filtered to BigEcho)

- [ ] **Step 6: Final commit (if any small fixups landed during QA)**

```bash
git status
git add -A
git commit -m "chore(minitray): final QA polish"  # only if there are changes
```

---

## Self-Review

### Spec coverage check

| Spec section | Implementing task |
|---|---|
| New Swift package `MinitrayBridge` | Task 9 (skeleton) + Task 10 (UI) |
| Rust module `services::minitray` | Task 4 (skeleton + tests) + Task 8 (poller) + Task 10 (callbacks) |
| `show_minitray_overlay` setting | Task 1 (Rust) + Task 2 (TS types) + Task 3 (UI) |
| Recording-start show, stop hide | Task 5 |
| Pipeline-error hide | Task 6 (verified not needed; documented) |
| Mid-recording settings toggle | Task 7 |
| Level pump (~30 Hz) | Task 4 (throttle) + Task 8 (poller) |
| Stop callback → tray:stop event | Task 10 step 2 |
| Icon callback → open tray window | Task 10 step 2 |
| Multi-monitor (cursor screen) | Task 10 step 1 (`positionAtTopCenter`) |
| `cfg(target_os = "macos")` gating + non-macOS no-op | Task 4 (sinks default to no-op on other OS) + Task 9 (build.rs gates Swift link) |
| Manual QA list | Task 10 step 6 + Task 11 step 5 |

No spec gaps.

### Placeholder scan

- The `TODO: implement in Task 10` comments inside the Task 9 Swift stubs are acceptable because they're explicitly scoped: Task 10 step 1 replaces the entire file. They are not unresolved engineering debt at plan completion.
- Task 6 has a conditional branch ("if no active-recording error path exists, document it; if yes, add `hide()` + test"). Both branches are concrete and either is acceptable to commit.
- No "TBD", "fill in", "appropriate error handling", or untyped "similar to" references remain.

### Type / signature consistency

- `show_if_enabled(settings: &PublicSettings, levels: &SharedLevels)` introduced in Task 8; Task 5 originally calls the single-argument version, then Task 8 step 5 explicitly updates the call site. Task 7's call site is also updated in Task 8 step 5. Consistent.
- `install_production_sinks()`, `install_callbacks(AppHandle)`, `install_show_sink_for_test`, `install_hide_sink_for_test`, `install_level_sink_for_test` all referenced consistently across tasks.
- `bigecho_minitray_show/hide/update_level/set_callbacks` symbols match between `Minitray.swift` (Task 10) and `extern "C"` blocks in `minitray.rs` (Task 4 + Task 10 step 2).
- `call_show_sink/call_hide_sink/call_level_sink` helpers introduced in Task 4 step 4 and used consistently.

No inconsistencies.
