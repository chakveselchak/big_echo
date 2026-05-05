# Floating Minitray Overlay (NSPanel) — Design

**Date:** 2026-05-05
**Status:** Approved (design phase)
**Platform:** macOS only (gracefully degraded elsewhere)

## Problem

While recording, the user has no persistent, lightweight UI to monitor the
recording without keeping the BigEcho main window or tray popover open. The
existing tray window is a popover anchored to the menu-bar icon: hiding the
menu-bar or losing focus dismisses it.

The user wants a Zoom-style "floating minitray" — a small rounded rectangle
pinned to the top center of the screen, on top of all windows, showing:

- BigEcho icon (clickable → opens the existing tray window)
- Combined audio level meter (mic + system)
- Stop button (clickable → stops recording AND hides the minitray)

This is opt-in via a checkbox in General settings:
**"Show minitray on top of all windows"**.

## Goals

- Visible across all spaces and full-screen apps (`canJoinAllSpaces`).
- Lightweight: do not spawn an extra WebView (~50–80 MB) just for a 200×36 panel.
- Reuses existing recording state, level streaming, and stop-recording IPC.
- macOS-first via native `NSPanel`; gracefully no-op on Windows/Linux.

## Non-Goals (YAGNI)

- Not draggable (fixed at top center).
- No mute button (only stop).
- No pause/resume.
- No custom show/hide animations.
- No multi-window minitray (one panel at a time).

## Approach

### Decision summary

| Question | Choice | Rationale |
|---|---|---|
| Implementation | Native `NSPanel` via Swift bridge | Approach 2 chosen — true system overlay, ~no memory overhead |
| Stop button | Stops recording AND hides minitray | One click does both (option C) |
| Multi-monitor positioning | Screen under cursor at recording start | Option B — natural for the user; does not jump if cursor moves |
| Theme | Follows system (vibrant `NSVisualEffectView`) | Matches Zoom-style HUD chrome |
| Draggable | No | Simpler; can add later if asked |

### Architecture

```
Rust (Tauri)                        Swift (MinitrayBridge)
─────────────────────────────       ───────────────────────────
services/minitray.rs                Sources/MinitrayBridge/
  show_if_enabled(settings) ───┐    Minitray.swift
  hide()                        │    NSPanel + NSVisualEffectView
  update_level(level: f32)      │    NSStackView { icon | meter | stop }
                                │
                                └─FFI (swift-rs)
                                  bigecho_minitray_show()
                                  bigecho_minitray_hide()
                                  bigecho_minitray_update_level()
                                  set_callbacks(on_stop, on_icon)

audio::capture (existing)            ↑
  level tap (~30 Hz throttle)        │
       │                             │
       └────► minitray::update_level()

recording_controller (existing)
  on start  ──► minitray::show_if_enabled()
  on stop   ──► minitray::hide()
  on error  ──► minitray::hide()

Swift NSButton (stop) ──callback──► Rust on_stop_clicked()
                                     emits "tray:stop" event (existing channel)
                                     → recording_controller stops recording

Swift NSImageView (icon) ──callback──► Rust on_icon_clicked()
                                        window_manager::open_tray_window_internal(app)
```

### File layout

New files:

```
src-tauri/macos/MinitrayBridge/
  Package.swift
  Sources/MinitrayBridge/Minitray.swift

src-tauri/src/services/minitray.rs    (new module, gated on cfg(target_os = "macos"))
```

Modified files:

```
src-tauri/build.rs                              (link the new Swift package)
src-tauri/src/services/mod.rs                   (declare new module)
src-tauri/src/settings/public_settings.rs       (add show_minitray_overlay: bool)
src-tauri/src/commands/recording.rs             (start_recording_impl → show; stop_recording → hide)
src-tauri/src/commands/settings.rs              (save_public_settings → show/hide if active recording)
src-tauri/src/services/pipeline_runner.rs       (recording-error path → hide)
src-tauri/src/audio/capture.rs                  (level tap → minitray::update_level)
src-tauri/src/main.rs                           (install_callbacks at boot)
src/types/index.ts                              (add show_minitray_overlay)
src/components/settings/GeneralSettings.tsx     (add the checkbox)
src/hooks/useSettingsForm.ts                    (default value, validation)
```

### Swift bridge — public ABI

```swift
// MinitrayBridge/Sources/MinitrayBridge/Minitray.swift
import AppKit
import SwiftRs

@_cdecl("bigecho_minitray_show")
public func minitray_show() {
    DispatchQueue.main.async { MinitrayController.shared.show() }
}

@_cdecl("bigecho_minitray_hide")
public func minitray_hide() {
    DispatchQueue.main.async { MinitrayController.shared.hide() }
}

@_cdecl("bigecho_minitray_update_level")
public func minitray_update_level(_ level: Float) {
    DispatchQueue.main.async { MinitrayController.shared.updateLevel(level) }
}

@_cdecl("bigecho_minitray_set_callbacks")
public func minitray_set_callbacks(
    onStop: @convention(c) () -> Void,
    onIcon: @convention(c) () -> Void
) {
    MinitrayController.shared.onStop = onStop
    MinitrayController.shared.onIcon = onIcon
}
```

Internally `MinitrayController` is a singleton owning the `NSPanel`, lazily
created on first `show()`. The panel uses:

- `styleMask: [.nonactivatingPanel, .borderless]`
- `level: .statusBar`
- `collectionBehavior: [.canJoinAllSpaces, .stationary, .ignoresCycle]`
- `isMovable: false`, `isMovableByWindowBackground: false`
- `hasShadow: true`, content background = `NSVisualEffectView(material: .hudWindow)`
- Corner radius 12 via `contentView.layer.cornerRadius`.

Layout (`NSStackView`, horizontal, spacing 8, edge insets 8):

1. `NSImageView` 22×22 — `NSApp.applicationIconImage` (with `NSTrackingArea` for click)
2. Custom `LevelMeterView` 100×16 — 12 vertical bars; `level: Float` setter triggers `needsDisplay = true`; bar `i` lit when `level >= i / 12`.
3. `NSButton` 22×22 — `image: NSImage(systemSymbolName: "stop.fill")`, `bezelStyle: .accessoryBar`, target/action calls `onStop`.

Position computed at `show()`:

```swift
let mouseScreen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }
                ?? NSScreen.main!
let frame = panel.frame
let x = mouseScreen.frame.midX - frame.width / 2
let y = mouseScreen.frame.maxY - frame.height - 8
panel.setFrameOrigin(NSPoint(x: x, y: y))
panel.orderFrontRegardless()
```

### Rust module — public API

```rust
// src-tauri/src/services/minitray.rs

#[cfg(target_os = "macos")]
mod imp {
    use crate::settings::public_settings::PublicSettings;
    use std::sync::Mutex;

    static VISIBLE: Mutex<bool> = Mutex::new(false);

    extern "C" {
        fn bigecho_minitray_show();
        fn bigecho_minitray_hide();
        fn bigecho_minitray_update_level(level: f32);
        fn bigecho_minitray_set_callbacks(
            on_stop: extern "C" fn(),
            on_icon: extern "C" fn(),
        );
    }

    /// Stash `app` in a `OnceCell` and call `bigecho_minitray_set_callbacks`
    /// with two `extern "C" fn` trampolines that read the cell and dispatch
    /// (`tray:stop` event for stop, `open_tray_window_internal` for icon).
    pub fn install_callbacks(app: tauri::AppHandle);

    /// If `settings.show_minitray_overlay` and host is macOS and not already
    /// visible, set `VISIBLE = true` and call `bigecho_minitray_show()`.
    pub fn show_if_enabled(settings: &PublicSettings);

    /// If visible, set `VISIBLE = false` and call `bigecho_minitray_hide()`.
    pub fn hide();

    /// Throttled to ~30 Hz. No-op when not visible.
    pub fn update_level(level: f32);
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::settings::public_settings::PublicSettings;
    pub fn install_callbacks(_: tauri::AppHandle) {}
    pub fn show_if_enabled(_: &PublicSettings) {}
    pub fn hide() {}
    pub fn update_level(_: f32) {}
}

pub use imp::*;
```

`install_callbacks` is called once at app boot (in `main.rs::run`). It stashes
the `AppHandle` in a `OnceCell` so the C callbacks (which run on the main
thread from Swift) can:

- `on_stop()` → `app.emit("tray:stop", ())` (existing channel) so the
  recording controller stops; then call `minitray::hide()`.
- `on_icon()` → `window_manager::open_tray_window_internal(&app)`.

### Level throttling

Audio capture ticks at the audio buffer rate (~10 ms). Driving NSPanel redraw
at 100 Hz is wasteful. Rust-side throttle:

```rust
static LAST_PUSH_NANOS: AtomicU64 = AtomicU64::new(0);
const MIN_INTERVAL_NS: u64 = 33_000_000; // ~30 Hz

pub fn update_level(level: f32) {
    let now = monotonic_now_ns();
    let last = LAST_PUSH_NANOS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < MIN_INTERVAL_NS { return; }
    if LAST_PUSH_NANOS.compare_exchange(last, now, ...).is_ok() {
        unsafe { bigecho_minitray_update_level(level); }
    }
}
```

Combined level: `combined = level.mic.max(level.system)` (peak of the two
channels — matches what the user "hears"; loudest source dominates the meter).
Average is rejected because silence on one channel would dim the bar even when
the other is loud.

### Settings persistence

```rust
// src-tauri/src/settings/public_settings.rs
pub struct PublicSettings {
    // … existing fields …
    #[serde(default)]
    pub show_minitray_overlay: bool,
}
```

`#[serde(default)]` keeps old `settings.json` files loadable. UI defaults the
checkbox off; user opts in.

```ts
// src/types/index.ts
export type PublicSettings = {
  // … existing …
  show_minitray_overlay: boolean;
};
```

```tsx
// src/components/settings/GeneralSettings.tsx (new row, near Apple-Speech etc.)
<Checkbox
  checked={settings.show_minitray_overlay}
  onChange={(e) => setSettings({ ...settings, show_minitray_overlay: e.target.checked })}
  disabled={!isMacOs}
>
  Show minitray on top of all windows
</Checkbox>
{!isMacOs && <span className="hint">Available on macOS only</span>}
```

`isMacOs` derived from `navigator.platform` or a `tauri::os` command.

### Lifecycle hooks

The recording controller (Rust) already has obvious points where recording
starts/stops successfully or fails. Inject:

| Point | Call |
|---|---|
| `start_recording` (after capture spawn ok) | `minitray::show_if_enabled(&settings)` |
| `stop_recording` (any path) | `minitray::hide()` |
| Capture loop error → cleanup | `minitray::hide()` |
| App shutdown | `minitray::hide()` |
| `save_public_settings` toggles `show_minitray_overlay`: <br>• ON during active recording | `minitray::show_if_enabled(&settings)` |
| `save_public_settings` toggles `show_minitray_overlay`: <br>• OFF during active recording | `minitray::hide()` |

"Currently recording?" is read from `AppState.active_session` (existing).

## Edge cases

| Scenario | Behavior |
|---|---|
| Recording starts, setting OFF | Minitray not shown |
| Setting ON, no active recording | Minitray not shown |
| Multi-screen, cursor moves during recording | Minitray stays on the screen where it appeared |
| User clicks icon multiple times | Tray window shown idempotently (existing logic) |
| User closes tray window via its own close affordance | Minitray unaffected |
| Recording fails mid-stream | Minitray hidden via error path |
| App quits while recording | Minitray hidden in shutdown hook |
| User in full-screen app (e.g., Safari) | Minitray visible (`canJoinAllSpaces`) |
| Non-macOS host | Checkbox shown disabled with hint; Rust functions no-op |
| Two recordings in quick succession | `show_if_enabled` is idempotent — second call is a no-op if already visible |

## Testing strategy

**Rust unit tests** (`src-tauri/src/services/minitray.rs`):

- `show_if_enabled` is a no-op when `show_minitray_overlay = false`.
- `show_if_enabled` is a no-op when `cfg(not(target_os = "macos"))` (compile-time).
- `update_level` throttling: when called 100 times in 100 ms, FFI invoked
  ~3 times (mock FFI counter via `#[cfg(test)]` trait swap or atomic counter).
- `install_callbacks` → `on_stop()` emits the `tray:stop` event on the stored
  `AppHandle` (test with a `MockRuntime`).

**Existing tests** must continue to pass:

- `recording_controller` start/stop/error tests — mock `minitray` module to
  count `show_if_enabled` / `hide` calls.
- `App.main.test.tsx` autosave — adding `show_minitray_overlay: false` to
  default `PublicSettings` shouldn't break payload-shape assertions; update
  any that pin the full settings object.

**Manual QA** (Swift UI):

- Visual: panel appears at top center on the cursor's screen.
- Visual: meter animates with audio.
- Visual: dark mode and light mode both look right (vibrancy).
- Click stop → recording stops, minitray disappears.
- Click icon → tray popover opens, minitray stays.
- Toggle setting OFF mid-recording → minitray disappears.
- Toggle setting ON mid-recording → minitray appears.
- Full-screen app → minitray still visible.
- Two displays → minitray on the screen where the cursor was.

## Build & packaging

`build.rs` extension:

```rust
#[cfg(target_os = "macos")]
swift_rs::SwiftLinker::new("13.0")
    .with_package("SystemAudioBridge", "macos/SystemAudioBridge")
    .with_package("MinitrayBridge", "macos/MinitrayBridge")
    .link();
```

`MinitrayBridge/Package.swift` mirrors `SystemAudioBridge/Package.swift`:
- `swift-tools-version: 5.9`
- `platforms: [.macOS(.v13)]` (AppKit-only, no macOS 26 SDK requirement)
- depends on `swift-rs`

No additional bundling — the static library links directly into the Tauri
binary, just like `SystemAudioBridge` does today.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `swift-rs` callback ABI mismatch (Swift `@convention(c)` ↔ Rust `extern "C" fn`) | Match existing `SystemAudioBridge` callback pattern; smoke-test in a small unit before wiring full UI |
| NSPanel flickers on creation (transparent background race) | Build the panel fully off-screen, set `alphaValue = 0`, then `orderFrontRegardless` + animate to 1 |
| Level meter feels laggy at 30 Hz | Bump to 60 Hz; the throttle is a constant, easy to tune |
| `cfg(target_os = "macos")` divergence breaks Linux/Windows CI | Stub module returns no-ops; existing CI compiles cleanly today |
| Stale `LAST_PUSH_NANOS` after a long pause | Acceptable — meter just snaps back to current level on next call |
