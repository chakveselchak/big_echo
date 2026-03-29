# Transcription Provider Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add user-selectable transcription providers so AudioToText can use either existing Nexara Whisper-compatible transcription or SalutSpeech async transcription.

**Architecture:** Keep Nexara behavior as the default and introduce a provider enum in shared settings. Frontend settings render provider-specific fields and secrets, while the Rust pipeline dispatches to either the existing Nexara multipart flow or a new SalutSpeech async flow with token exchange, file upload, task polling, and result download.

**Tech Stack:** React, TypeScript, Vitest, Tauri, Rust, reqwest, serde

---

### Task 1: Shared Settings Shape

**Files:**
- Modify: `src/appTypes.ts`
- Modify: `src/lib/validation.ts`
- Modify: `src-tauri/src/settings/public_settings.rs`

**Step 1: Add failing tests for missing provider/config fields**

Run: `cargo test settings::public_settings:: --manifest-path src-tauri/Cargo.toml`
Expected: existing tests pass; new SalutSpeech settings tests fail until fields/defaults are added.

**Step 2: Add provider and SalutSpeech config fields**

Add:
- `transcription_provider`
- `salute_speech_scope`
- `salute_speech_model`
- `salute_speech_language`
- `salute_speech_sample_rate`
- `salute_speech_channels_count`

Keep Nexara defaults backward compatible.

**Step 3: Validate provider-specific settings**

Rules:
- provider must be `nexara` or `salute_speech`
- SalutSpeech sample rate > 0
- SalutSpeech channels count > 0
- existing Nexara URL validation unchanged

**Step 4: Re-run settings tests**

Run: `cargo test settings::public_settings:: --manifest-path src-tauri/Cargo.toml`
Expected: PASS

### Task 2: Frontend Provider Selection

**Files:**
- Modify: `src/features/settings/useSettingsForm.ts`
- Modify: `src/features/settings/useSettingsForm.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.settings.test.tsx`
- Modify: `src/App.main.test.tsx`

**Step 1: Write failing UI tests**

Cover:
- provider select renders in AudioToText
- Nexara shows current fields
- SalutSpeech hides Nexara fields and shows provider-specific fields
- saving SalutSpeech stores public settings and secret under a dedicated secret name

**Step 2: Update form state for new secret**

Add secret state/input for SalutSpeech authorization key without breaking current OpenAI + Nexara save flow.

**Step 3: Render provider-specific UI**

Nexara:
- keep existing transcription block unchanged

SalutSpeech:
- show auth key input
- show scope, model, language, sample rate, channels count
- keep summary section unchanged

**Step 4: Re-run frontend tests**

Run: `npm test -- --runInBand src/App.settings.test.tsx src/features/settings/useSettingsForm.test.tsx src/App.main.test.tsx`
Expected: PASS

### Task 3: Rust SalutSpeech Pipeline

**Files:**
- Modify: `src-tauri/src/pipeline/mod.rs`
- Modify: `src-tauri/src/services/pipeline_runner.rs`

**Step 1: Write failing pipeline tests**

Cover:
- token request to `https://ngw.devices.sberbank.ru:9443/api/v2/oauth`-style endpoint with Basic auth, `RqUID`, and `scope`
- upload request to `data:upload`
- async recognition request to `speech:async_recognize`
- polling `task:get` until `DONE`
- download `data:download`
- transcript extraction from downloaded JSON

**Step 2: Add provider dispatch**

Keep current Nexara logic under a provider-specific path and add SalutSpeech path.

**Step 3: Implement SalutSpeech async client**

Implement minimal helpers for:
- access token exchange
- audio upload
- task creation
- polling with bounded retries/delay
- result download and JSON text extraction

**Step 4: Improve error surfacing**

Attach provider name and missing-secret context to make failures debuggable.

**Step 5: Re-run pipeline tests**

Run: `cargo test pipeline:: --manifest-path src-tauri/Cargo.toml`
Expected: PASS

### Task 4: Verification

**Files:**
- Modify only if tests expose regressions

**Step 1: Run targeted frontend and backend verification**

Run: `npm test -- --runInBand src/App.settings.test.tsx src/features/settings/useSettingsForm.test.tsx src/App.main.test.tsx`
Expected: PASS

Run: `cargo test pipeline:: --manifest-path src-tauri/Cargo.toml`
Expected: PASS

Run: `cargo test settings::public_settings:: --manifest-path src-tauri/Cargo.toml`
Expected: PASS

**Step 2: Run broader relevant suite**

Run: `npm test -- --runInBand`
Expected: PASS or identify unrelated failures

**Step 3: Summarize outcome**

Report provider behavior, saved secrets, docs assumptions, and any remaining limitations.
