# Tray Audio Lottie + Mute Design

## Goal

Refresh the tray recorder so it no longer shows legacy level bars. Instead, the tray should show compact animated SVG activity indicators powered by Lottie for microphone and system audio, plus per-channel mute controls that work during an active recording without stopping the session.

## Current Context

The current tray UI in [`src/App.tsx`](/Users/andrejkuznecov/Documents/github/big_echo/src/App.tsx) renders live audio state as horizontal fill bars driven by `LiveInputLevels`. That implementation has two important limitations for the requested UX:

1. The tray visuals are level bars rather than an animated icon treatment.
2. On macOS, microphone live level is updated in Rust, but native system audio capture currently does not feed a live system-audio level back to the tray, so a second activity animation for system audio would not behave correctly without backend work.

The app already supports:

- tray-specific polling of `get_live_input_levels`
- independent microphone and system capture paths
- native macOS system audio capture through ScreenCaptureKit
- tray start/stop controls with synchronized recording state

## User-Approved Decisions

- The microphone level indicator and its rendering logic should be removed from the tray.
- The tray should render compact SVG animation instead of bars.
- One Lottie asset may be reused for both channels, but each channel must behave independently.
- The tray must show separate activity indication for microphone and system audio.
- The tray must provide a microphone mute button and a system-audio mute button.
- Mute affects the current recording only.
- Both mute states reset after `Stop` and on the next `Rec`.
- Muted channels show a crossed-out icon.

## Approaches Considered

### 1. Frontend-only animation swap

Replace the bars with a Lottie component in the tray and keep the existing backend contracts unchanged.

Pros:

- Smallest UI-only change.
- Fastest initial implementation.

Cons:

- Does not solve missing macOS native system-audio live levels.
- Cannot implement trustworthy play/pause behavior for the system-audio animation on macOS.
- Does not address mute behavior inside the capture pipeline.

Rejected because it would only partially satisfy the request and would make the system-audio row misleading.

### 2. Two explicit channel rows with shared Lottie asset and backend mute support

Keep the tray compact, but render two explicit rows: `Mic` and `System`. Reuse one Lottie asset twice, with one independent player instance per row. Add channel-specific mute state in the active recording pipeline and add live system-audio metering support for macOS native capture.

Pros:

- Matches the approved tray layout.
- Keeps channel state obvious in a very small window.
- Supports honest play/pause logic per channel.
- Lets mute work without interrupting the session.

Cons:

- Requires coordinated frontend, Rust, and macOS bridge changes.

Chosen approach.

### 3. Single shared animation panel for both channels

Render one shared animated panel and treat `Mic` and `System` as small status rows under it.

Pros:

- Most compact visually.

Cons:

- Makes it less obvious which channel is active.
- Makes mute state less discoverable in a tiny layout.
- Adds ambiguity when one source is active and the other is muted or silent.

Rejected because the approved direction favored explicit per-channel rows.

## Chosen Design

### Tray Layout

The tray window keeps its existing high-level structure:

- top status line and optional `Open System Settings` shortcut
- `Source` and `Topic` fields
- audio activity block
- `Rec` and `Stop` buttons

The audio activity block changes to two compact rows:

1. `Mic`
2. `System`

Each row contains:

- a short text label
- a compact Lottie-based SVG activity indicator
- a mute button with channel-specific icon

The old level-track and fill-bar elements are removed from the tray branch entirely.

### Animation Behavior

The tray uses the provided `wave.lottie` asset as the canonical activity animation.

Implementation-level design constraints:

- Convert or extract the animation JSON from the `.lottie` archive and keep it as a frontend asset.
- Render with `lottie-web` in SVG mode so the output is actual SVG animation.
- Create two independent player instances from the same source asset.
- Do not attempt to drive the animation by frame-scrubbing on every meter update.
- Instead, use the live level as a play/pause signal:
  - play when the channel is not muted and the live level is above a small threshold
  - pause when the channel is muted or the live level falls below the threshold

The threshold should be explicit and shared by both rows so the behavior is stable and testable.

### Mute Interaction

Mute is scoped to the active recording only.

Behavior:

- A fresh recording starts with `micMuted = false` and `systemMuted = false`.
- Stopping a recording resets both states to `false`.
- If the tray is idle, both mute buttons remain visible but disabled.
- If the tray is recording, each mute button toggles its own channel immediately.
- A muted channel shows a crossed-out icon.
- A muted channel's Lottie animation is paused even if incoming audio exists.

This design avoids silent no-op clicks in idle state while still keeping the tray layout stable.

### Recording Pipeline Semantics

Mute must not remove a channel from the session or stop its capture path. Instead, muting replaces outgoing samples with silence while preserving timing.

That applies to both channels:

- microphone mute writes silence to the mic recording stream
- system-audio mute writes silence to the system recording stream

This preserves downstream synchronization and avoids changing the file layout or stop logic.

### Backend Ownership

The active recording pipeline owns the authoritative mute state.

The frontend tray mirrors that state for immediate UI updates, but mute is enforced in the backend. The minimum required backend contract is:

- a command to set channel mute state during recording
- reset of both mute flags on recording start
- reset of both mute flags on recording stop and cleanup

No persistence is required in saved settings or future sessions.

### macOS Native System-Audio Metering

The native macOS system-audio path must expose a real live activity signal, otherwise the system-audio animation cannot be truthful.

Chosen design:

- the ScreenCaptureKit bridge computes a lightweight live level from the captured PCM samples
- the native layer stores the latest system-audio level for the current capture session
- the Tauri-side live-level path reads that system level and exposes it to the tray alongside the microphone level
- when native system capture is not running, the system level resolves to `0`

This keeps the tray polling contract intact while avoiding fake or inferred system activity.

### Permission and Unsupported States

The existing macOS permission UX stays intact.

Rules:

- If permission status is loading, keep the current loading message instead of rendering a fake system animation.
- If permission lookup fails, keep the existing error message and settings shortcut.
- If macOS system audio is unsupported and the app is using legacy device-based system capture, the system row still renders as an animated activity row plus the existing system-device selector.
- If native macOS permission is pending review or denied, do not render a misleading active system animation.

This design preserves the current permission guidance and only upgrades the visual/audio-control portion.

## Component and State Boundaries

The tray audio block should not expand the `App` tray branch further than necessary.

Preferred decomposition:

- a focused tray-audio-row component for label, animation, mute button, and optional device selector
- controller state for:
  - current live levels
  - tray-local mute UI state
  - status-based reset behavior
- backend recording state for:
  - active mute flags
  - live system level for native macOS capture

The settings model remains unchanged because mute is not a persistent preference.

## Testing Strategy

### Frontend Tests

Update tray UI tests to verify:

- legacy level bars are no longer rendered
- tray renders separate `Mic` and `System` activity rows
- mute buttons are present and channel-specific
- muted state applies a crossed-out icon treatment
- mute buttons are disabled while idle and enabled while recording
- macOS permission/loading/error states still render their existing messaging

### Controller Tests

Add tests for:

- toggling microphone mute during recording
- toggling system mute during recording
- mute reset on stop
- mute reset when a new recording begins
- tray animation state derived from `(muted, liveLevel)`

### Backend Tests

Add tests for:

- recording mute state resets on start/stop
- muting writes silence instead of real samples
- unmuted capture preserves existing behavior
- macOS system live level resolves to zero when capture is inactive

Where direct native validation is hard to unit-test, cover the Rust-facing wrapper logic and keep one manual verification pass.

### Manual Verification

Run one manual tray recording on macOS with both microphone and system audio active:

1. Start recording from the tray.
2. Confirm both activity animations play when signal is present.
3. Mute microphone and confirm mic animation pauses and mic audio is absent from the result.
4. Unmute microphone and confirm animation resumes on signal.
5. Mute system audio and confirm system animation pauses and system audio is absent from the result.
6. Stop recording.
7. Start a new recording and confirm both mute states reset.

## Non-Goals

- No redesign of the main window recording UI.
- No persistent mute preferences in settings.
- No change to the tray icon in the macOS menu bar.
- No new waveform or scrubber UI in the tray.

## Risks and Mitigations

### Risk: native system-audio live level is noisy or unstable

Mitigation:

- use a small explicit threshold for animation play/pause
- reuse the same smoothing philosophy already applied to mic levels where helpful

### Risk: mute implementation accidentally drops or desynchronizes a channel

Mitigation:

- enforce silence substitution instead of stopping the capture path
- add stop/start reset tests

### Risk: tray code grows harder to maintain

Mitigation:

- extract a focused tray channel row component
- keep permission-state rendering separate from animation/mute behavior
