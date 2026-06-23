# Session Transcription Speed Dropdown Design

## Goal

Add a per-session speed selector to the session card actions. The selector controls which audio speed will be used the next time the user manually clicks `Get text` for that session.

Existing transcripts and summaries are not changed when the selected speed changes.

## User Behavior

- Each session card gets a speed icon button in the existing icon action block.
- Clicking the icon opens a dropdown with `1x`, `1.25x`, `1.5x`, `1.75x`, and `2x`.
- The selected speed has a checkmark on the left.
- A green dot on the right means the corresponding audio file already exists.
- `1x` is always available because it uses the original session audio.
- Choosing `1x` selects the original audio for future manual transcription.
- Choosing a speed above `1x` creates the speed-adjusted file if it does not exist, then selects it for future manual transcription.

## Scope

In scope:

- Per-session selected speed for future manual transcription.
- On-demand speed-adjusted audio generation from the session card.
- UI availability indicators for existing speed files.
- Backend persistence in `meta.json`.
- Session list payload updates so the UI can render current selection and availability.

Out of scope:

- Deleting or invalidating existing transcript and summary files.
- Automatically re-running transcription after speed selection.
- Generating all speed files proactively.
- Changing post-recording auto-transcription behavior.

## Data Model

Keep the existing artifact fields:

- `audio_file`
- `speed_adjusted_audio_file`
- `audio_speed_multiplier`

Interpret `speed_adjusted_audio_file` and `audio_speed_multiplier` as the currently selected non-`1x` effective audio for future transcription. When `1x` is selected, both fields are cleared and the original `audio_file` is used.

Expose speed availability in the session list payload as a map or list of available speed multipliers. `1x` is always included when original audio exists. Non-`1x` values are included when their expected generated file exists in the session directory.

## Backend Flow

Add a Tauri command such as `set_session_transcription_audio_speed(session_id, speed)`.

For `speed == 1.0`:

- Load session metadata.
- Clear `speed_adjusted_audio_file`.
- Clear `audio_speed_multiplier`.
- Save metadata and update the session index.
- Add a session event for auditability.

For `speed > 1.0`:

- Validate speed is one of `1.25`, `1.5`, `1.75`, `2.0`.
- Load session metadata and locate the original audio file.
- Build the expected speed file name using the existing filename helper.
- If the speed file is missing, generate it with the existing `ffmpeg atempo` path.
- Save `speed_adjusted_audio_file` and `audio_speed_multiplier` in metadata.
- Update the session index and add a session event.

`run_transcription` and pipeline retry continue using the existing effective-audio helper, so the selected speed controls manual transcription without changing the frontend transcription command.

Post-recording auto-transcription continues to use the global Audio settings. The stop-recording path may still create/select the global speed-adjusted audio before the automatic pipeline runs.

## Frontend Flow

Add a session-card speed button in the current header icon action group.

Use the provided speedometer SVG as a local React icon or inline SVG component. It should be styled like the other gray action icons and fit the existing circular action button dimensions.

The dropdown items render:

- Left: checkmark when this is the selected speed.
- Center: speed label.
- Right: green availability dot when that speed file exists.

On selection:

- Disable or show loading state for the speed button while the command runs.
- Call the new Tauri command.
- Refresh sessions after success so selected speed, availability, badge, and audio player source update from backend state.
- Show an error status if generation fails.

## Error Handling

- If original audio is missing, return a user-visible error and leave the previous selected speed unchanged.
- If speed generation fails, keep metadata unchanged and record a failure event.
- If a generated file already exists, selecting that speed should be fast and not rewrite the file.
- If the selected generated file is later deleted, the effective-audio helper falls back to original audio; the next session list refresh should not show that speed as available.

## Tests

Backend:

- `1x` clears selected speed metadata.
- Selecting `1.5x` reuses an existing generated file and persists selection.
- Selecting `1.5x` generates the file when missing and persists selection.
- Unsupported speeds are rejected.
- Session list exposes available speed multipliers.
- Effective audio used by transcription follows the selected speed.

Frontend:

- Dropdown renders all speeds.
- Checkmark appears on selected speed.
- Green dot appears for available speeds.
- Selecting a speed calls the Tauri command and refreshes sessions.
- `Get text` remains the only trigger for manual transcription.
