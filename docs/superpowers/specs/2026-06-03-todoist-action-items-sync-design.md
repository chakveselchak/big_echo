# Todoist Action Items Sync Design

## Summary

BigEcho should let the user export action items from a generated meeting summary into Todoist. The first version is explicitly user-confirmed: after a summary is available, BigEcho previews extracted tasks in a modal and only syncs the selected tasks after the user confirms. The architecture must also include a settings flag for future automatic task creation.

The LLM must never call Todoist directly. LLM output is treated only as structured or semi-structured summary content. BigEcho owns extraction, normalization, queuing, retry status, user confirmation, and Todoist API calls.

## Goals

- Extract action items from `summary.json` when present, with fallback extraction from `summary.md`.
- Show a Todoist export modal where the user can select tasks before syncing.
- Store Todoist API token in the existing BigEcho secret store.
- Create Todoist tasks in the user's Inbox by default.
- Use SQLite as the source of truth for task sync state and idempotency.
- Write a session-local `tasks_sync.json` audit snapshot beside the summary artifacts.
- Add settings for Todoist sync and future auto-add behavior.

## Non-Goals

- Todoist project or section selection.
- Todoist OAuth flow. The first version uses a user-provided API token.
- Assigning Todoist tasks to Todoist users.
- Automatic sync by default.
- Recurring dates, reminders, labels, durations, or deadlines.
- Letting the LLM or summary provider perform external side effects.

## Current Project Context

BigEcho is a Tauri app with a React frontend and Rust backend. Session metadata is stored in `meta.json`, session artifacts are Markdown files, and `src-tauri/src/storage/sqlite_repo.rs` already maintains a SQLite index plus retry-related tables. Summary generation currently writes `summary.md` from `src-tauri/src/services/pipeline_runner.rs` using `write_markdown_artifact`, with YAML frontmatter handled by `src-tauri/src/storage/markdown_artifact.rs`.

This design follows the existing pattern: Rust owns durable state and external API integration; React asks Tauri commands for previews, settings, and sync status.

## Architecture

```text
pipeline_runner
  -> summary.md
  -> optional summary.json
  -> ActionItemsExtractor
  -> TaskNormalizer
  -> tasks_sync.json audit snapshot
  -> UI Todoist export modal
  -> TaskSyncQueue SQLite
  -> TodoistSyncWorker
  -> TodoistProvider
```

`task_sync_queue` is the source of truth for sync state. `tasks_sync.json` is a readable session-local snapshot for audit and portability, but it does not drive retry behavior.

The Todoist provider uses the Todoist API v1 task creation endpoint:

```text
POST https://api.todoist.com/api/v1/tasks
Authorization: Bearer <token>
Content-Type: application/json
```

BigEcho omits `project_id`, so Todoist places tasks in the user's Inbox.

## Backend Modules

Add a new Rust domain under `src-tauri/src/task_sync/`.

### `task_sync/mod.rs`

Public facade for preview, enqueue, sync, and status operations. Tauri commands call this module instead of reaching into extractor, queue, or provider internals.

### `task_sync/model.rs`

Defines:

- `TaskProvider`, initially only `Todoist`.
- `ExtractedActionItem`, representing raw extracted data from `summary.json` or Markdown.
- `ActionItem`, the normalized BigEcho task model.
- `TaskSyncStatus`: `new`, `queued`, `synced`, `failed`, `skipped`.
- Request and response DTOs for Tauri commands.

Internal normalized shape:

```ts
type ActionItem = {
  id: string;
  provider: "todoist";
  title: string;
  description?: string;
  due?: string;
  priority?: 1 | 2 | 3 | 4;
  assignee?: string;
  context?: string;
  sourceSessionId: string;
  sourceFilePath: string;
  status: "new" | "queued" | "synced" | "failed" | "skipped";
};
```

### `task_sync/extractor.rs`

Extraction order:

1. Look for `summary.json` beside `summary.md`.
2. If `summary.json` exists and contains `actionItems`, parse it.
3. If it is missing or invalid, read `summary.md`, strip YAML frontmatter, and use a conservative Markdown fallback.

For the first implementation, Markdown fallback should avoid a second LLM call. It should recognize explicit action-item sections and common checkbox/list formats. Empty, missing, or malformed inputs return an empty list plus warnings rather than failing the session pipeline.

Expected machine summary shape:

```json
{
  "summary": "...",
  "decisions": [],
  "actionItems": [
    {
      "title": "Согласовать SAP_ID с безопасниками",
      "assignee": "Андрей",
      "due": "2026-06-05",
      "priority": 3,
      "source": "meeting_2026-06-03_14-00",
      "context": "Обсуждали пилот с баннерами"
    }
  ]
}
```

### `task_sync/normalizer.rs`

Responsibilities:

- Trim title and collapse internal whitespace.
- Drop items with an empty title.
- Clamp or default priority to Todoist-compatible `1..4`; default is `1`.
- Accept only ISO dates in `YYYY-MM-DD` for `due`.
- Preserve non-ISO due text in the description instead of sending it to Todoist.
- Preserve `assignee` in the description because Inbox tasks are not shared project tasks.
- Compute deterministic IDs.

ID format:

```text
sha256(provider + "\n" + sourceSessionId + "\n" + normalizedTitle + "\n" + dueOrEmpty)
```

This prevents duplicate Todoist tasks when the user previews or exports the same summary repeatedly.

### `task_sync/queue.rs`

Owns SQLite persistence for syncable tasks. It should live as a focused `task_sync/queue.rs` module that reuses the same BigEcho database path as `storage/sqlite_repo.rs`, while keeping task-sync queries separate from the session-list repository.

Table:

```sql
CREATE TABLE IF NOT EXISTS task_sync_queue (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due TEXT,
  priority INTEGER,
  assignee TEXT,
  context TEXT,
  source_session_id TEXT NOT NULL,
  source_file_path TEXT NOT NULL,
  external_task_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  queued_at TEXT,
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_sync_queue_session_provider
ON task_sync_queue(source_session_id, provider);
```

Queue behavior:

- `upsert_new_tasks` inserts new deterministic IDs.
- Existing `synced` rows are never reset to `queued`.
- Existing `failed` rows may be requeued by explicit retry.
- Selected preview items become `queued`.
- Skipped items become `skipped`.

### `task_sync/todoist.rs`

Small HTTP provider that only knows Todoist's task API. Request body mapping:

```text
title       -> content
context     -> description
due         -> due_date
priority    -> priority
assignee    -> description only
source path -> description
```

Description template:

```text
Источник: BigEcho
Встреча: <session_id>
Файл: <summary_path>

Исполнитель: <assignee>

Контекст:
<context>
```

Todoist response `id` is saved as `external_task_id`.

### `task_sync/worker.rs`

The worker reads queued rows and calls `TodoistProvider`.

For the first version, it can run immediately after the user enqueues selected tasks. The same worker can later support automatic sync after summary generation.

## Tauri Commands

Add focused commands instead of overloading existing session commands:

```text
preview_todoist_tasks(session_id) -> TodoistTaskPreview
enqueue_todoist_tasks(session_id, task_ids) -> TaskSyncResult
sync_todoist_tasks(session_id?) -> TaskSyncResult
get_todoist_sync_status(session_id) -> TodoistSyncStatus
```

`preview_todoist_tasks` extracts and normalizes tasks, merges them with SQLite status, and refreshes `tasks_sync.json`.

`enqueue_todoist_tasks` validates the Todoist token exists before queueing selected tasks. If no token exists, it returns a typed `missing_token` error so the frontend can send the user to settings.

`sync_todoist_tasks` processes queued tasks. When `session_id` is provided, it limits sync to that session; otherwise it can process all queued Todoist tasks.

## Session Artifacts

Add `tasks_sync_file` to `SessionArtifacts`:

```rust
#[serde(default = "default_tasks_sync_file")]
pub tasks_sync_file: String
```

Default:

```text
tasks_sync.json
```

This must be serde-defaulted so existing `meta.json` files remain readable.

`summary.json` is not required in `SessionArtifacts` for the first version. The extractor simply looks for `summary.json` beside `summary.md`. A later summary pipeline change can add it as a first-class artifact.

`tasks_sync.json` shape:

```json
{
  "sourceSessionId": "meeting_2026-06-03_14-00",
  "provider": "todoist",
  "updatedAt": "2026-06-03T14:30:00+03:00",
  "items": []
}
```

The snapshot is updated after preview, enqueue, skip, and sync.

## Settings

Public settings:

```text
todoist_sync_enabled: boolean
todoist_auto_add: boolean
```

Secret store:

```text
todoist_api_token
```

Defaults:

```text
todoist_sync_enabled = false
todoist_auto_add = false
```

`todoist_auto_add` is available in Settings from the first version but does not become the default behavior. If enabled in a future iteration, the pipeline can enqueue and sync tasks after summary generation without opening the modal.

## Frontend UX

After summary generation, a session card can expose a Todoist export action when summary text exists and action items can be previewed.

Manual flow:

1. User clicks Todoist export on a summarized session.
2. Frontend calls `preview_todoist_tasks(session_id)`.
3. Modal lists tasks with checkboxes.
4. Each row shows title, context, due date, priority, source, and current sync status.
5. User chooses `Add selected`, `Add all`, or `Skip`.
6. Selected tasks are enqueued.
7. Worker syncs to Todoist.
8. UI shows `Synced`, `Failed`, or retry action.

If the token is missing, the export action should not silently disappear. It should show a clear setup path to Settings.

Settings UI adds a `Todoist sync` section:

- Enable Todoist sync.
- API token password field.
- Auto-add action items checkbox, disabled when sync is disabled or the token is missing.

## Error Handling

Typed error classes:

- `missing_token`: no Todoist token is configured.
- `invalid_token`: Todoist returns 401.
- `rate_limit`: Todoist returns 429.
- `server`: Todoist returns 5xx.
- `bad_request`: Todoist returns 400.
- `network`: request failed before a Todoist response.

Retry behavior:

- `rate_limit`, `server`, and `network` are retryable.
- `bad_request` is not retryable until the task data changes.
- `invalid_token` should fail pending tasks with a clear settings-related message.
- Explicit `Retry failed` can requeue retryable failed rows.

The worker stores the latest error string in SQLite and refreshes `tasks_sync.json`.

## Normalization Rules

Due dates:

- Send only ISO `YYYY-MM-DD` as `due_date`.
- Do not send natural language such as `завтра` or `next Friday` to Todoist in v1.
- Preserve unsupported due text in the description.

Priority:

- BigEcho `1..4` maps directly to Todoist `1..4`.
- Missing or invalid priority defaults to `1`.

Assignee:

- Do not send to Todoist.
- Preserve as text in the description.

Title:

- Trim.
- Collapse whitespace.
- Drop empty titles.

## Testing

Backend unit tests:

- Normalizer produces stable deterministic IDs.
- Normalizer trims and collapses title whitespace.
- Priority defaults and clamps correctly.
- Due accepts only `YYYY-MM-DD`.
- Extractor prefers valid `summary.json`.
- Extractor falls back to `summary.md`.
- Extractor returns an empty list plus warning for empty or malformed files.
- Queue inserts deterministic IDs without duplicates.
- Queue does not reset `synced` rows back to `queued`.
- Queue supports `failed -> retry -> synced`.
- Todoist provider creates request bodies without `project_id`.
- Todoist provider maps 401, 429, 5xx, 400, and network errors.

Backend integration tests:

- `summary.md -> preview -> enqueue -> mocked sync -> status`.
- Old `meta.json` without `tasks_sync_file` loads with the default.
- Repeated export does not create duplicate queue rows or Todoist tasks.

Frontend tests:

- Settings saves public flags and token through the correct commands.
- Session card shows export action when summary exists.
- Modal handles selected, all, skip, already synced, and failed states.

Verification commands:

```text
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

## Open Implementation Notes

The first implementation should keep extraction conservative. If BigEcho later changes summary generation to produce reliable `summary.json`, the extractor can become mostly a structured JSON reader and the Markdown fallback can remain for old sessions.

Automatic add should be implemented as a small policy switch around the same preview, enqueue, and worker pipeline. It should not introduce a second sync path.
