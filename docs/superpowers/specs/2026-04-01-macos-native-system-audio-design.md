# Native macOS System Audio Capture Design

## Summary

BigEcho should record the entire system audio on macOS without requiring BlackHole, Soundflower, Loopback, or any other virtual audio device. The macOS build will switch from the current "pick a second input device" model to a native system-audio backend based on ScreenCaptureKit, while keeping the existing microphone capture path and downstream transcription/summary pipeline intact.

This design reflects the approved product constraints:

- Capture the entire system audio output.
- Do not require BlackHole or any manual virtual-driver setup.
- Do not keep the current BlackHole path as a fallback on macOS.
- Support macOS 13+ only for this native system-audio path.
- It is acceptable to require macOS system permission for screen and system audio recording.

## Problem Statement

The current macOS implementation models "system audio" as a normal input device. In practice this means BigEcho only captures system audio when the user separately installs a virtual loopback driver and chooses it in settings. The code in [`src-tauri/src/audio/capture.rs`](/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/src/audio/capture.rs) explicitly searches input devices and scores names such as `BlackHole`, `Soundflower`, and `Loopback Audio` as preferred macOS system sources.

That approach creates avoidable setup friction and does not match the expected UX for a meeting recorder. Comparable apps on modern macOS can capture system audio through native OS APIs and a one-time permission grant instead of an out-of-band audio driver install.

## Goals

- Record the entire macOS system audio natively.
- Preserve microphone capture in the same recording session.
- Reuse the existing raw-audio, encoding, session, transcription, and summary pipeline wherever possible.
- Replace device-selection UX on macOS with permission/status UX.
- Support this native path on macOS 13+.
- Keep non-macOS platforms on the current capture implementation.

## Non-Goals

- Supporting macOS versions earlier than 13.
- Capturing audio from only one application or one meeting window.
- Keeping a virtual-device fallback on macOS.
- Rewriting the full audio subsystem for all platforms.
- Changing the transcript/summary pipeline format or session storage layout.

## Approaches Considered

### 1. ScreenCaptureKit for system audio plus current microphone capture

This approach adds a macOS-only native backend that captures system audio through ScreenCaptureKit and continues to capture the microphone through the existing `cpal` path.

Pros:

- Matches the desired "works out of the box" UX.
- Uses modern Apple-supported APIs and the native permission model.
- Minimizes blast radius by leaving the existing microphone and post-processing pipeline mostly unchanged.

Cons:

- Requires a native macOS bridge from Rust/Tauri into Apple APIs.
- Requires explicit handling for system permission state and related UX.

### 2. Core Audio taps

This approach uses lower-level Core Audio system taps to capture output audio.

Pros:

- Also avoids virtual audio drivers.
- Potentially powerful for future routing use cases.

Cons:

- More complex and lower-level than necessary for the current product goal.
- Higher implementation and maintenance risk in this codebase.
- Worse fit for a first native macOS capture backend.

### 3. Full Swift rewrite of macOS recording

This approach moves microphone capture, system capture, and recording lifecycle entirely into Swift for macOS.

Pros:

- Very native implementation model.

Cons:

- Far too large a scope increase for the current goal.
- Replaces stable existing code without clear product benefit.

## Decision

Implement approach 1: use ScreenCaptureKit for macOS system audio capture, keep `cpal` for microphone capture, and preserve the current recording/encoding pipeline after capture.

## Architecture

### Capture Model

The recording session will continue to produce two raw streams:

- microphone PCM
- system-audio PCM

The microphone stream continues to be produced by the existing `cpal`-based code. The system stream becomes a macOS-only native stream produced by ScreenCaptureKit. Both streams must be normalized to the same PCM contract already expected by the file writer stage:

- signed 16-bit PCM
- mono/stereo handling consistent with the current writer
- explicit sample-rate metadata returned to Rust

The existing artifact writer and post-recording encoding logic remain the integration point for both streams. This keeps recording output, session metadata, and pipeline behavior stable.

### Backend Boundary

Introduce an explicit backend boundary for system-audio capture on macOS. The boundary should be small and operational:

- `start(output_path) -> handle`
- `stop(handle) -> capture_artifacts`
- `permission_status() -> enum`
- `open_system_settings() -> Result<(), String>`

The recommended implementation is a thin Swift shim exposed to Rust via a small C-compatible interface. The Swift side owns the ScreenCaptureKit objects, writes PCM directly to the output path provided by Rust, and reports stop/failure state back to Rust. Rust remains the orchestration layer for session lifecycle, temp paths, file cleanup, and error propagation.

This design deliberately avoids streaming per-buffer audio frames across the Rust/Swift boundary. Writing raw PCM in the native layer keeps the bridge narrow and reduces real-time cross-language complexity.

### Recording Lifecycle

On macOS, `start_recording` should follow this sequence:

1. Validate microphone availability as today.
2. Check macOS system-audio permission status.
3. If permission is missing or denied, fail with a user-facing error that clearly says BigEcho needs `Screen & System Audio Recording`.
4. Start microphone capture.
5. Start ScreenCaptureKit system-audio capture.
6. Register both capture handles in shared app state.

If system-audio startup fails after microphone capture has already started, the microphone capture must be stopped immediately and temporary files cleaned up before returning an error. Start must be atomic from the user's perspective.

On stop:

1. Stop the microphone capture.
2. Stop the ScreenCaptureKit capture.
3. Flush both raw files.
4. Pass the resulting artifacts into the existing encoding pipeline.

If system capture fails mid-session, stop the recording, preserve any captured artifacts that are still usable, and surface a clear error in session history/state.

### Permission and UX Model

The macOS build no longer exposes a "system source device" selector. On macOS, the relevant UX becomes:

- microphone permission status
- system audio permission status
- guidance for granting permission

The settings screen should show that macOS system audio uses a native backend and does not require BlackHole. If permission is missing, the UI should provide a clear action to open the relevant system settings page or explain the exact manual path.

The recording button must not begin a partial "mic-only" session when the approved product behavior requires full system-audio capture. Missing permission is a blocking state.

### Settings and Compatibility

The existing `system_device_name` field can remain in stored settings for compatibility with existing serialized settings, but it becomes ignored on macOS. The UI should stop rendering that control on macOS to avoid confusing users.

No session-format migration is required for audio capture itself. Existing recordings remain readable because session storage, transcript generation, and summary generation do not depend on how the audio was captured.

## Proposed File-Level Changes

### Rust backend

- Modify [`src-tauri/src/audio/capture.rs`](/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/src/audio/capture.rs)
  - Keep the cross-platform orchestration entry points.
  - Route macOS system capture through the new native backend instead of device name matching.
  - Remove macOS-specific scoring/detection behavior for BlackHole-style devices.
- Create `src-tauri/src/audio/macos_system_audio.rs`
  - Define the Rust-facing wrapper around the native bridge.
  - Convert native stop results into existing `CaptureArtifacts`-compatible data.
- Modify [`src-tauri/src/commands/recording.rs`](/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/src/commands/recording.rs)
  - Gate start on macOS system-audio permission.
  - Treat failure to start system capture as a full start failure.
- Modify [`src-tauri/src/commands/settings.rs`](/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/src/commands/settings.rs)
  - Replace `detect_system_source_device`-style macOS behavior with permission/status commands.
  - Add a command for opening the relevant macOS privacy settings when helpful.
- Modify [`src-tauri/src/app_state.rs`](/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/src/app_state.rs)
  - Store the additional native system-capture handle if the current state object cannot already hold it cleanly.

### Native macOS bridge

- Create `src-tauri/macos/SystemAudioCapture.swift`
  - Own the ScreenCaptureKit capture objects.
  - Write system-audio PCM to a file path supplied by Rust.
  - Surface permission checks and start/stop lifecycle.
- Add any required build wiring so the Swift file is compiled into the macOS app target.

### Frontend

- Modify [`src/features/settings/useSettingsForm.ts`](/Users/andrejkuznecov/Documents/github/big_echo/src/features/settings/useSettingsForm.ts)
  - Read and display the new permission/status commands on macOS.
  - Remove macOS dependence on system-device auto-detection.
- Modify [`src/App.tsx`](/Users/andrejkuznecov/Documents/github/big_echo/src/App.tsx)
  - Update settings UI copy and conditional rendering for macOS.
  - Surface blocking permission errors during recording start.
- Update related tests in:
  - [`src/App.settings.test.tsx`](/Users/andrejkuznecov/Documents/github/big_echo/src/App.settings.test.tsx)
  - [`src/features/settings/useSettingsForm.test.tsx`](/Users/andrejkuznecov/Documents/github/big_echo/src/features/settings/useSettingsForm.test.tsx)
  - relevant Rust command/audio tests under `src-tauri/src`

### App metadata

- Modify [`src-tauri/Info.plist`](/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/Info.plist)
  - Update permission-facing descriptions to match the native capture model.
- Update Tauri/macOS bundle configuration if additional native bridge or entitlement wiring is required.

## Error Handling

- Permission missing: return a dedicated error that the frontend can present without guessing.
- Permission revoked during runtime: stop capture, preserve partial data when possible, and mark the session as failed with a clear reason.
- Native backend start failure: abort the entire recording start and clean up microphone capture plus temp files.
- Native backend stop failure: preserve any raw files already flushed and mark finalization failure explicitly.
- No usable display or stream target available for ScreenCaptureKit initialization: treat as an actionable startup error.

## Testing Strategy

### Automated tests

- Unit-test backend selection so macOS no longer relies on `BlackHole` device detection.
- Unit-test permission-state mapping and the start-recording gating behavior.
- Unit-test cleanup logic when microphone capture starts successfully but system capture fails to start.
- Update frontend tests so macOS settings render native-permission status instead of system-device selection.

### Manual QA

Manual QA is required on a real macOS machine because ScreenCaptureKit and TCC permissions cannot be fully validated in headless test environments.

Required manual cases:

- First launch with no permission granted.
- Grant permission and start recording successfully.
- Deny permission and verify recording is blocked with clear guidance.
- Revoke permission after prior approval and verify the app recovers with actionable messaging.
- Capture microphone plus system audio from a real meeting and confirm both are present in the final file.

## Rollout Notes

- This is a macOS-only behavioral change.
- Existing macOS users will no longer configure a system source device.
- Documentation and onboarding copy should be updated to remove BlackHole setup steps for supported macOS versions.

## Risks

- The Swift bridge and Rust lifecycle must remain tightly synchronized to avoid orphaned native capture sessions.
- macOS permission UX can easily become confusing if the app returns generic errors.
- Real-time audio capture across two backends increases the chance of partial-start and partial-stop edge cases; these need explicit tests and cleanup rules.

## References

- Apple Support: Screen and system audio recording permission on macOS
- Apple ScreenCaptureKit documentation and WWDC guidance
- Current BigEcho capture implementation in [`src-tauri/src/audio/capture.rs`](/Users/andrejkuznecov/Documents/github/big_echo/src-tauri/src/audio/capture.rs)
