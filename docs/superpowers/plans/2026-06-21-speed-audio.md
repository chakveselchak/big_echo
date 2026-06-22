# Speed Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional post-recording audio speed-up at 1.25x, 1.5x, 1.75x, or 2x while preserving the original recording.

**Architecture:** Persist the selected speed in public settings and persist generated speed-adjusted audio in session metadata. Consumers that need playable/transcribable audio use an effective-audio helper that prefers the generated file when it exists.

**Tech Stack:** Rust/Tauri backend, serde JSON settings and session metadata, ffmpeg `atempo`, React/TypeScript UI, Vitest and Cargo tests.

---

### Task 1: Settings And Metadata Shape

**Files:**
- Modify: `src-tauri/src/settings/public_settings.rs`
- Modify: `src-tauri/src/domain/session.rs`
- Modify: `src/types/index.ts`

- [ ] Add optional `audio_speed_multiplier` setting with validation for `1.25`, `1.5`, `1.75`, `2.0`.
- [ ] Add `speed_adjusted_audio_file` and `audio_speed_multiplier` defaults to session artifacts.
- [ ] Add matching frontend fields to `PublicSettings` and `SessionListItem`.
- [ ] Verify with focused Rust tests for default, validation, and legacy JSON deserialization.

### Task 2: Audio Speed Generation

**Files:**
- Modify: `src-tauri/src/audio/file_writer.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] Write failing tests for generated filename `audio_1.5x.opus` and speed label formatting.
- [ ] Implement speed-adjusted filename helpers and ffmpeg generation with `atempo=<speed>`.
- [ ] Call generation after recording finalization succeeds.
- [ ] Persist generated file metadata and add a non-fatal event/error if speed generation fails.

### Task 3: Effective Audio Consumers

**Files:**
- Modify: `src-tauri/src/storage/sqlite_repo.rs`
- Modify: `src-tauri/src/services/pipeline_runner.rs`
- Modify: `src/lib/appUtils.tsx`

- [ ] Add backend helper to choose speed-adjusted audio when metadata points to an existing file.
- [ ] Update list sessions to expose speed-adjusted fields.
- [ ] Update transcription pipeline to use the effective audio path.
- [ ] Update frontend audio path resolution to prefer the speed-adjusted file.

### Task 4: UI Controls And Badge

**Files:**
- Modify: `src/components/settings/AudioSettings.tsx`
- Modify: `src/pages/SettingsPage/index.tsx`
- Modify: `src/components/sessions/SessionCard.tsx`

- [ ] Add single-select speed buttons in the Audio settings tab.
- [ ] Mark the Audio tab dirty when speed changes.
- [ ] Show a compact speed label beside the session date when a speed-adjusted file exists.
- [ ] Verify with focused React tests where existing test coverage is available.

### Task 5: Final Verification

**Files:**
- Run only commands needed to prove the touched behavior.

- [ ] Run targeted Rust tests for settings, metadata, list sessions, and pipeline audio selection.
- [ ] Run targeted frontend tests for path resolution and UI rendering.
- [ ] Run type/build check if touched TypeScript changes need compile verification.
