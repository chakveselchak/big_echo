# Named Summary Prompts Design

## Context

Big Echo currently supports a per-session custom summary prompt through
`custom_summary_prompt` in session metadata. The session list opens
`SummaryPromptModal`, lets the user edit prompt text, and saves that text back
through `update_session_details`. Summary generation then passes the persisted
text as a custom prompt override.

The new behavior changes custom prompts from one-off per-session text into a
reusable named prompt library. A prompt name is the identifier. If the prompt
text stored under a name changes, every session using that name should use the
new text on future summary runs.

## Goals

- Let users create, name, edit, choose, and reuse summary prompts.
- Store named prompts in the existing SQLite database.
- Let a session bind to a named prompt by name.
- Resolve the current prompt text by name when summary generation runs.
- Handle existing sessions that only have legacy `custom_summary_prompt` text.
- Keep the current per-session summary prompt entry point from session cards.

## Non-Goals

- Version prompt text over time.
- Snapshot prompt text into sessions after selection.
- Add prompt categories, search, import, or export.
- Migrate all legacy prompt text automatically.

## Data Model

Add a SQLite table for named summary prompts:

```sql
CREATE TABLE IF NOT EXISTS summary_prompts (
    name TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    created_at_iso TEXT NOT NULL,
    updated_at_iso TEXT NOT NULL
);
```

Add `custom_summary_prompt_name` to session metadata and public session views.
The existing `custom_summary_prompt` remains for legacy sessions and backwards
compatibility.

Session prompt resolution order:

1. If `custom_summary_prompt_name` is non-empty, load the named prompt from
   SQLite and use its current text.
2. Otherwise, if legacy `custom_summary_prompt` is non-empty, use that text.
3. Otherwise, use the global `summary_prompt` setting.

If a session points to a missing prompt name, summary generation should fail
with a clear error instead of silently falling back. Silent fallback would hide
data integrity problems and produce summaries with the wrong prompt.

## Backend API

Add Tauri commands:

- `list_summary_prompts() -> Vec<SummaryPromptView>`
- `upsert_summary_prompt(payload: { name, prompt }) -> SummaryPromptView`
- `delete_summary_prompt(name: String) -> String`

Extend `update_session_details` with optional `custom_summary_prompt_name`.
When this field is set, persist the name in session metadata. If a user binds a
session to a named prompt, clear the legacy freeform prompt text for that
session.

`delete_summary_prompt` should reject deletion while any session metadata uses
that prompt name. This keeps session behavior explicit and avoids broken prompt
links. A later force-delete flow can be added if needed.

## Frontend UX

Reuse the existing summary prompt button on each session card.

The modal becomes a two-column editor:

- Left column: list of saved prompt names.
- Right column top: editable prompt name input.
- Right column below: prompt textarea.
- Footer: Cancel and OK.

Selecting a name in the left column loads that named prompt into the right
column. Editing the textarea while a named prompt is selected edits the shared
named prompt, not only the current session. Pressing OK saves the named prompt
and binds the current session to that name.

For a legacy session with `custom_summary_prompt` but no name, open the modal
with that legacy text in the textarea and no selected saved prompt. The user
can either:

- enter a new name and press OK, which creates that named prompt and binds the
  session to it;
- select an existing prompt from the left column, which replaces the legacy
  text for this session with the selected named prompt binding.

For a session without custom prompt data, open with the global default prompt
text as the initial textarea draft and no selected name, so creating a reusable
prompt from the default remains quick.

## Data Flow

Opening the modal:

1. Load session metadata as today.
2. Load the prompt list from SQLite.
3. If the session has `custom_summary_prompt_name`, select that prompt.
4. Else if the session has legacy text, show it as an unsaved named prompt
   draft.
5. Else show the global default prompt as an unsaved named prompt draft.

Confirming the modal:

1. Validate that the name and prompt text are non-empty after trimming.
2. Upsert the named prompt in SQLite.
3. Save session details with `custom_summary_prompt_name` set to the trimmed
   name and legacy `custom_summary_prompt` cleared.
4. Close the modal after both writes succeed.

Running summary:

1. Frontend can call `run_summary({ sessionId })` without passing prompt text.
2. Backend loads session metadata.
3. Backend resolves the named prompt by `custom_summary_prompt_name`, then
   legacy text, then settings default.

Keeping resolution on the backend prevents stale frontend state from choosing
the wrong prompt text.

## Error Handling

- Empty prompt name: show validation feedback in the modal and do not save.
- Empty prompt text: show validation feedback in the modal and do not save.
- Duplicate prompt name: upsert updates the existing prompt intentionally.
- Missing prompt name during summary generation: return a clear backend error.
- Delete prompt in use: return a clear backend error.
- SQLite failures: surface the existing `error: ...` status pattern.

## Testing

Backend tests:

- `summary_prompts` table is created by opening the SQLite connection.
- Upserting a prompt creates and then updates by name.
- Listing prompts returns saved prompts in stable name order.
- Deleting an unused prompt removes it.
- Deleting a prompt used by a session is rejected.
- Summary prompt resolution prefers `custom_summary_prompt_name` over legacy
  text and settings default.
- Missing named prompt returns an error during summary generation.

Frontend tests:

- Modal lists saved prompt names and loads selected prompt text.
- Pressing OK upserts the named prompt and saves the session prompt name.
- Legacy freeform text opens as a draft and can be saved under a new name.
- Selecting an existing prompt for a legacy session binds the session to that
  prompt and clears legacy text.
- Session prompt indicator remains active when either prompt name or legacy
  prompt text is present.

## Open Decisions

No open product decisions remain for this scope. The chosen behavior is that
prompt names are identifiers and prompt text changes propagate to all sessions
bound to the same name.
