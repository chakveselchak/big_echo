# Obsidian Tags, Notes, and Ant Design Migration Design

## Purpose

BigEcho session artifacts should become useful Obsidian notes. The app will store session relationships as real tags, store free-form notes separately, write YAML frontmatter into generated Markdown artifacts, and migrate the frontend to Ant Design components with the glass theme while preserving the existing layout.

## Goals

- Replace the old `custom tag` concept with `notes`.
- Remove `participants` from the domain, backend commands, frontend state, and UI without legacy compatibility.
- Store user relationship tags in `meta.tags`.
- Store `source` as a separate metadata field and include it in YAML frontmatter.
- Generate both transcript and summary artifacts as Markdown files.
- Add YAML frontmatter to transcript and summary artifacts when their content is actually generated.
- Provide fast tag autocomplete from an in-memory backend tag index.
- Move frontend components to Ant Design and `glassTheme`.
- Preserve the existing component placement, grids, and information architecture.

## Non-Goals

- No backward compatibility layer for `participants`.
- No two-phase migration where UI labels change but data still writes to old fields.
- No new persistent `known_tags` database table in this iteration.
- No layout redesign. The existing app grid and component positions remain the contract.
- No duplication of notes as a visible Markdown body section.

## Domain Model

The public session metadata view becomes:

```ts
type SessionMetaView = {
  session_id: string;
  source: string;
  notes: string;
  topic: string;
  tags: string[];
  custom_summary_prompt?: string;
};
```

The Rust `SessionMeta` stores the same domain concepts:

```rust
pub struct SessionMeta {
    pub session_id: String,
    pub created_at_iso: String,
    pub started_at_iso: String,
    pub ended_at_iso: Option<String>,
    pub display_date_ru: String,
    pub source: String,
    pub tags: Vec<String>,
    pub notes: String,
    pub topic: String,
    pub custom_summary_prompt: String,
    pub status: SessionStatus,
    pub artifacts: SessionArtifacts,
    pub errors: Vec<String>,
}
```

`source` is no longer derived from the first tag. `tags` contains only user-defined relationship tags such as `project/acme`, `person/ivan`, `call/sales`, or `decision/pending`.

`participants` is removed entirely. Existing sessions that still have `participants` in `meta.json` are not migrated in this design. The app will no longer expose or preserve that data.

## Tag Autocomplete

The backend owns an in-memory tag index in `AppState`:

```rust
pub struct AppState {
    // existing fields...
    pub known_tags: Mutex<BTreeSet<String>>,
    pub known_tags_hydrated: Mutex<bool>,
}
```

The session metadata on disk remains the source of truth. The in-memory index is only a fast autocomplete cache.

The new Tauri command `list_known_tags` works as follows:

1. If the index is not hydrated, scan indexed sessions, load their `meta.json`, normalize every `meta.tags` value, and populate `known_tags`.
2. Return the sorted tag list.
3. If the index is already hydrated, return the in-memory list without scanning files.

The index updates when session metadata changes:

- `start_recording` adds the new session's tags to the index.
- `update_session_details` writes `meta.tags` and adds the saved tags to the index.
- `import_audio_session` leaves the index unchanged unless tags are added later through `update_session_details`.
- `delete_session` rebuilds the index from remaining session metadata, so deleted-only tags do not keep appearing in autocomplete.

If users edit `meta.json` by hand while the app is running, the index may not see those external changes until app restart or a future explicit refresh command. That is acceptable for this iteration.

The frontend uses Ant Design `Select` with `mode="tags"` and options from `list_known_tags`. New typed tags are allowed; once saved, they are added to the backend index and become suggestions for future edits.

## Markdown Artifacts

Both transcript and summary are Markdown artifacts:

- `transcript_DD.MM.YYYY.md`
- `summary_DD.MM.YYYY.md`

The default `SessionArtifacts.transcript_file` changes from `transcript.txt` to `transcript.md`.

Placeholder files created at session start or import may be empty. YAML frontmatter is written only when real artifact content is written:

- After successful transcription, write `transcript_*.md` with YAML frontmatter plus transcript body.
- After successful summary generation, write `summary_*.md` with YAML frontmatter plus summary body.

The frontmatter shape is:

```md
---
source: zoom
tags:
  - project/acme
  - call/sales
notes: "важный созвон, проверить договор"
topic: Renewal sync
---
```

For multiline notes, use a YAML block scalar:

```md
---
source: zoom
tags:
  - project/acme
notes: |
  Проверить договор.
  Отдельно спросить про сроки.
topic: Renewal sync
---
```

Notes are not duplicated as a visible section in the Markdown body.

When summary generation reads a Markdown transcript, it must strip YAML frontmatter and send only the transcript body to the summary API.

When session details change after artifacts already exist, artifact frontmatter should be refreshed without rewriting the body. This keeps Obsidian metadata aligned with the session card.

## Backend Commands

`StartRecordingRequest` becomes:

```rust
pub struct StartRecordingRequest {
    pub source: String,
    pub topic: String,
    pub tags: Vec<String>,
    pub notes: String,
}
```

`UpdateSessionDetailsRequest` becomes:

```rust
pub struct UpdateSessionDetailsRequest {
    pub session_id: String,
    pub source: String,
    pub notes: String,
    pub custom_summary_prompt: String,
    pub topic: String,
    pub tags: Vec<String>,
}
```

`SessionMetaView` mirrors the frontend metadata shape:

```rust
pub struct SessionMetaView {
    pub session_id: String,
    pub source: String,
    pub notes: String,
    pub custom_summary_prompt: String,
    pub topic: String,
    pub tags: Vec<String>,
}
```

`list_sessions` includes the updated metadata view in each item when metadata is available.

Search should match source, notes, topic, tags, path, status, date, transcript text, and summary text.

## Frontend UI

The frontend moves to Ant Design as the component system and future UI paradigm. The migration is not a layout redesign.

The root wraps the app with:

```tsx
<ConfigProvider {...useGlassTheme()}>
  <AntdApp>
    <App />
  </AntdApp>
</ConfigProvider>
```

`useGlassTheme` is implemented locally from the provided glass theme pattern:

- `theme.defaultAlgorithm`
- radius tokens set to `12`
- faster motion duration tokens
- app/card/modal/button/dropdown/select/input/inputNumber/popover/switch/radio/segmented/progress component classes
- glass CSS module classes for translucent surfaces and borders

The implementation will use the installed Ant Design version's typed component config. If a copied semantic `classNames` key differs from that version, the implementation adapts to the official type surface while preserving the visual contract.

Component replacements preserve existing placement:

- Native buttons become Ant Design `Button`.
- Native inputs become `Input`.
- Native textarea becomes `Input.TextArea`.
- Native selects become `Select`.
- The current `Participants` position becomes `Tags` using `Select mode="tags"`.
- The current `Custom tag` position becomes `Notes` using `Input.TextArea`.
- Search becomes `Input.Search`.
- Dialogs become `Modal`.
- Context menu becomes `Dropdown` or `Menu`.
- Status chips and artifact labels use Ant Design `Tag`.
- Loading indicators use Ant Design `Spin` or `Button` loading states.

Existing layout classes remain as structural wrappers where needed:

- `.session-edit-grid`
- `.session-card-footer`
- `.settings-tab-grid`
- `.tray-meta-grid`
- audio player layout classes

Old custom component classes such as `.primary-button`, `.secondary-button`, `.field`, and `.panel` are removed or reduced once their responsibilities move to Ant Design.

## Tray UI

The tray mini-window keeps its current compact arrangement. It uses Ant Design controls where practical, but it must preserve the current grid and density. `source` remains editable from the tray. Tags and notes are not added to the tray in this design.

## Testing

The implementation should be test-driven.

Backend tests cover:

- `participants` removed from request/view types.
- `SessionMeta::new` stores `source`, `tags`, and `notes` independently.
- `transcript_name` returns `.md`.
- Generated transcript Markdown contains YAML frontmatter and body.
- Generated summary Markdown contains YAML frontmatter and body only after summary content is available.
- Summary generation strips transcript frontmatter before calling the summary API.
- `list_known_tags` hydrates from session metadata and returns sorted unique tags.
- `update_session_details` updates `known_tags`.
- `delete_session` rebuilds `known_tags`.
- `update_session_details` refreshes existing artifact frontmatter without changing body content.

Frontend tests cover:

- Session cards render `Tags` and `Notes`, not `Participants` and `Custom tag`.
- Editing tags uses Ant Design `Select mode="tags"` behavior and saves `tags`.
- Editing notes saves `notes`.
- Search matches tags and notes.
- `list_known_tags` populates tag autocomplete options.
- Start recording sends `source`, `topic`, `tags`, and `notes`.
- Existing layout-sensitive tests are updated to assert placement is preserved while components are Ant Design.

## Risks

- Removing `participants` without migration means older participant data is intentionally discarded from the active app model.
- Ant Design semantic component config varies by version. The implementation must pin or adapt to the installed version's TypeScript types.
- Markdown frontmatter requires careful escaping for quotes, colons, multiline notes, and backslashes.
- Existing tests likely rely on native roles and class names. They should be updated to assert user-visible behavior and layout contract rather than old custom component internals.

## Decisions

- Use a clean one-pass migration.
- Store tags in `meta.tags`.
- Store notes in `meta.notes`.
- Store source separately and include it in YAML frontmatter.
- Use backend in-memory `known_tags` with hydration from session metadata.
- Generate transcript as Markdown.
- Add YAML only when transcript or summary content is generated.
- Preserve frontend layout while migrating components and styles to Ant Design.
