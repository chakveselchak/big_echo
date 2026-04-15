# Obsidian Tags, Notes, and Ant Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert BigEcho sessions into Obsidian-friendly Markdown notes with real tags, notes, YAML frontmatter, backend tag autocomplete, and Ant Design glass-themed components without moving the existing UI layout.

**Architecture:** The backend source of truth is `meta.json`; it stores `source`, `tags`, `notes`, `topic`, and artifact names. Markdown frontmatter is rendered by a focused helper module, the summary pipeline strips frontmatter before calling the summary API, and `AppState` owns an in-memory `known_tags` cache hydrated from session metadata. The frontend keeps the current grids and component placement while replacing native controls with Ant Design components wrapped by `ConfigProvider` and `useGlassTheme`.

**Tech Stack:** Rust/Tauri 2, React 18, TypeScript, Vite, Vitest, Testing Library, Ant Design 5, CSS modules, SQLite session index, Markdown/YAML frontmatter helpers.

---

## File Structure

Create:
- `src-tauri/src/storage/markdown_artifact.rs` renders YAML frontmatter, writes Markdown artifacts, strips frontmatter, and refreshes frontmatter while preserving body text.
- `src-tauri/src/storage/tag_index.rs` hydrates and rebuilds sorted unique known tags from session metadata.
- `src/AppRoot.tsx` wraps `App` in Ant Design providers.
- `src/theme/useGlassTheme.ts` returns typed Ant Design `ConfigProviderProps`.
- `src/theme/glassTheme.module.css` contains glass surface classes used by the theme config.

Modify:
- `package.json` and `package-lock.json` add `antd` and `clsx`.
- `src/main.tsx` imports Ant Design reset CSS and wraps `App` in `ConfigProvider` and AntD `App`.
- `src/appTypes.ts` replaces `custom_tag` and `participants` with `notes` and `tags`.
- `src/lib/appUtils.ts` replaces participant splitting with tag normalization helpers.
- `src/features/recording/useRecordingController.ts` sends `source`, `topic`, `tags`, and `notes`.
- `src/features/sessions/useSessions.ts` persists and searches `notes` and `tags`, calls `list_known_tags`, and exposes known tags.
- `src/App.tsx` swaps controls to Ant Design components while preserving layout wrappers.
- `src/App.css` keeps layout and audio CSS, removes custom component skinning that Ant Design owns.
- `src-tauri/src/domain/session.rs` changes `SessionMeta` to store `source`, `tags`, and `notes`; removes `participants`; changes default transcript artifact to Markdown.
- `src-tauri/src/app_state.rs` changes Tauri request/view types and adds the tag cache to `AppState`.
- `src-tauri/src/command_core.rs` removes participant validation.
- `src-tauri/src/storage/fs_layout.rs` returns `transcript_DD.MM.YYYY.md`.
- `src-tauri/src/storage/mod.rs` exports new storage modules.
- `src-tauri/src/storage/sqlite_repo.rs` enriches session list metadata with `source`, `notes`, and `tags`.
- `src-tauri/src/commands/recording.rs` writes new metadata shape and Markdown artifact names.
- `src-tauri/src/commands/sessions.rs` updates metadata commands, search, known-tag command, deletion tag rebuild, and artifact frontmatter refresh.
- `src-tauri/src/services/pipeline_runner.rs` writes Markdown artifacts and strips transcript frontmatter before summary.
- `src-tauri/src/main.rs` command registration and tests use the new contracts.
- Existing frontend and backend tests are updated to the new field names and Ant Design behavior.

---

### Task 1: Dependencies and Ant Design Root Theme

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/main.tsx`
- Create: `src/AppRoot.tsx`
- Create: `src/theme/useGlassTheme.ts`
- Create: `src/theme/glassTheme.module.css`
- Test: `src/AppRoot.test.tsx`

- [ ] **Step 1: Write the failing root wrapper test**

Create `src/AppRoot.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type InvokeMock = (cmd: string, args?: unknown) => Promise<unknown>;

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<InvokeMock>(async (cmd: string) => {
    if (cmd === "get_ui_sync_state") {
      return { source: "slack", topic: "", is_recording: false, active_session_id: null };
    }
    if (cmd === "set_ui_sync_state") return "updated";
    if (cmd === "list_sessions") return [];
    return null;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (filePath: string) => `asset://${filePath}`,
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", hide: vi.fn(async () => undefined) }),
}));

import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  it("wraps the app with Ant Design glass theme classes", async () => {
    render(<AppRoot />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(document.querySelector(".ant-app")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test -- src/AppRoot.test.tsx
```

Expected: FAIL because `src/AppRoot.tsx` does not exist.

- [ ] **Step 3: Install dependencies**

Run:

```bash
npm install antd clsx
```

Expected: `package.json` includes `antd` and `clsx`; `package-lock.json` changes.

- [ ] **Step 4: Add glass theme CSS module**

Create `src/theme/glassTheme.module.css`:

```css
.app {
  min-height: 100vh;
  color: var(--text);
}

.glassBox {
  background: rgba(255, 255, 255, 0.62);
  border: 1px solid rgba(140, 151, 165, 0.26);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.72),
    0 18px 42px rgba(18, 24, 34, 0.1);
  backdrop-filter: blur(18px) saturate(1.16);
  -webkit-backdrop-filter: blur(18px) saturate(1.16);
}

.notBackdropFilter {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.glassBorder {
  border: 1px solid rgba(140, 151, 165, 0.28);
}

.cardRoot {
  background: rgba(255, 255, 255, 0.72);
  border-color: rgba(140, 151, 165, 0.28);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.72),
    0 14px 34px rgba(18, 24, 34, 0.08);
}

.modalContainer :global(.ant-modal-content) {
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(140, 151, 165, 0.28);
  box-shadow: 0 24px 64px rgba(18, 24, 34, 0.22);
  backdrop-filter: blur(20px) saturate(1.14);
  -webkit-backdrop-filter: blur(20px) saturate(1.14);
}

.buttonRoot {
  box-shadow: none;
}

.buttonRootDefaultColor {
  background: rgba(255, 255, 255, 0.72);
  border-color: rgba(122, 135, 150, 0.36);
}

.dropdownRoot {
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(140, 151, 165, 0.26);
  border-radius: 12px;
  box-shadow: 0 18px 42px rgba(18, 24, 34, 0.14);
  backdrop-filter: blur(18px) saturate(1.14);
  -webkit-backdrop-filter: blur(18px) saturate(1.14);
}

.switchRoot,
.radioButtonRoot,
.segmentedRoot {
  border-radius: 12px;
}
```

- [ ] **Step 5: Add `useGlassTheme`**

Create `src/theme/useGlassTheme.ts`:

```ts
import { useMemo } from "react";
import { theme, type ConfigProviderProps } from "antd";
import clsx from "clsx";
import styles from "./glassTheme.module.css";

export function useGlassTheme(): ConfigProviderProps {
  return useMemo<ConfigProviderProps>(
    () => ({
      theme: {
        algorithm: theme.defaultAlgorithm,
        token: {
          borderRadius: 12,
          borderRadiusLG: 12,
          borderRadiusSM: 12,
          borderRadiusXS: 12,
          motionDurationSlow: "0.2s",
          motionDurationMid: "0.1s",
          motionDurationFast: "0.05s",
        },
      },
      app: {
        className: styles.app,
      },
      card: {
        classNames: {
          root: styles.cardRoot,
        },
      },
      modal: {
        classNames: {
          container: styles.modalContainer,
        },
      },
      button: {
        classNames: ({ props }) => ({
          root: clsx(
            styles.buttonRoot,
            (props.variant !== "solid" || props.color === "default" || props.type === "default") &&
              styles.buttonRootDefaultColor
          ),
        }),
      },
      alert: {
        className: clsx(styles.glassBox, styles.notBackdropFilter),
      },
      dropdown: {
        classNames: {
          root: styles.dropdownRoot,
        },
      },
      select: {
        classNames: {
          root: clsx(styles.glassBox, styles.notBackdropFilter),
          popup: {
            root: styles.glassBox,
          },
        },
      },
      input: {
        classNames: {
          root: clsx(styles.glassBox, styles.notBackdropFilter),
        },
      },
      inputNumber: {
        classNames: {
          root: clsx(styles.glassBox, styles.notBackdropFilter),
        },
      },
      popover: {
        classNames: {
          container: styles.glassBox,
        },
      },
      switch: {
        classNames: {
          root: styles.switchRoot,
        },
      },
      radio: {
        classNames: {
          root: styles.radioButtonRoot,
        },
      },
      segmented: {
        className: styles.segmentedRoot,
      },
      progress: {
        classNames: {
          track: styles.glassBorder,
        },
        styles: {
          track: {
            height: 12,
          },
          rail: {
            height: 12,
          },
        },
      },
    }),
    []
  );
}
```

If TypeScript reports that one semantic key is not accepted by the installed Ant Design version, remove only that key and keep the rest of the typed config. Do not replace the theme with a hand-written CSS-only theme.

- [ ] **Step 6: Wrap the app in Ant Design providers**

Create `src/AppRoot.tsx`:

```tsx
import { App as AntdApp, ConfigProvider } from "antd";
import { App } from "./App";
import { useGlassTheme } from "./theme/useGlassTheme";

export function AppRoot() {
  const configProps = useGlassTheme();

  return (
    <ConfigProvider {...configProps}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}
```

Update `src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import { AppRoot } from "./AppRoot";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
);
```

- [ ] **Step 7: Run the test to verify it passes**

Run:

```bash
npm test -- src/AppRoot.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS. If Ant Design theme typings fail, adjust `src/theme/useGlassTheme.ts` to the installed version's typed component config and rerun.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/main.tsx src/AppRoot.tsx src/theme/useGlassTheme.ts src/theme/glassTheme.module.css src/AppRoot.test.tsx
git commit -m "feat: add ant design glass theme root"
```

---

### Task 2: Backend Session Metadata Contract

**Files:**
- Modify: `src-tauri/src/domain/session.rs`
- Modify: `src-tauri/src/storage/fs_layout.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/command_core.rs`
- Modify: all Rust call sites that construct `SessionMeta` or request/view metadata
- Test: `src-tauri/src/domain/session.rs`
- Test: `src-tauri/src/storage/fs_layout.rs`
- Test: `src-tauri/src/command_core.rs`

- [ ] **Step 1: Write failing domain and layout tests**

In `src-tauri/src/domain/session.rs`, add:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_meta_new_stores_source_tags_and_notes_independently() {
        let meta = SessionMeta::new(
            "s-meta".to_string(),
            "zoom".to_string(),
            vec!["project/acme".to_string(), "call/sales".to_string()],
            "Renewal sync".to_string(),
            "Check contract renewal".to_string(),
        );

        assert_eq!(meta.source, "zoom");
        assert_eq!(
            meta.tags,
            vec!["project/acme".to_string(), "call/sales".to_string()]
        );
        assert_eq!(meta.notes, "Check contract renewal");
        assert_eq!(meta.primary_tag, "zoom");
    }
}
```

In `src-tauri/src/storage/fs_layout.rs`, change the artifact-name test to assert:

```rust
assert_eq!(transcript_name(dt), "transcript_10.03.2026.md");
assert_eq!(summary_name(dt), "summary_10.03.2026.md");
```

In `src-tauri/src/command_core.rs`, replace participant validation tests with:

```rust
#[test]
fn start_validation_allows_empty_topic() {
    let result = validate_start_request("");
    assert_eq!(result, Ok(()));
}

#[test]
fn start_validation_rejects_long_topic() {
    let topic = "x".repeat(201);
    let result = validate_start_request(&topic);
    assert_eq!(result, Err("Topic is too long (max 200 chars)".to_string()));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test session_meta_new_stores_source_tags_and_notes_independently --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because `SessionMeta::new` has the old signature and no `source` or `notes` fields.

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test builds_artifact_names_in_ru_date --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because transcript artifacts still use `.txt`.

- [ ] **Step 3: Change `SessionMeta` and artifacts**

Update `src-tauri/src/domain/session.rs` so the relevant structs and constructor look like this:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArtifacts {
    pub audio_file: String,
    pub transcript_file: String,
    pub summary_file: String,
    pub meta_file: String,
}

impl Default for SessionArtifacts {
    fn default() -> Self {
        Self {
            audio_file: "audio.opus".to_string(),
            transcript_file: "transcript.md".to_string(),
            summary_file: "summary.md".to_string(),
            meta_file: "meta.json".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub session_id: String,
    pub created_at_iso: String,
    pub started_at_iso: String,
    pub ended_at_iso: Option<String>,
    pub display_date_ru: String,
    pub source: String,
    pub primary_tag: String,
    pub tags: Vec<String>,
    pub notes: String,
    pub topic: String,
    #[serde(default)]
    pub custom_summary_prompt: String,
    pub status: SessionStatus,
    pub artifacts: SessionArtifacts,
    pub errors: Vec<String>,
}

impl SessionMeta {
    pub fn new(
        session_id: String,
        source: String,
        tags: Vec<String>,
        topic: String,
        notes: String,
    ) -> Self {
        let now = Local::now();
        let source = source.trim();
        let source = if source.is_empty() { "general" } else { source }.to_string();

        Self {
            session_id,
            created_at_iso: now.to_rfc3339(),
            started_at_iso: now.to_rfc3339(),
            ended_at_iso: None,
            display_date_ru: format_ru_date(now),
            primary_tag: source.clone(),
            source,
            tags,
            notes,
            topic,
            custom_summary_prompt: String::new(),
            status: SessionStatus::Recording,
            artifacts: SessionArtifacts::default(),
            errors: vec![],
        }
    }
}
```

Keep `primary_tag` for the SQLite list column and existing list sorting behavior, but set it from `source`.

- [ ] **Step 4: Change transcript artifact extension**

Update `src-tauri/src/storage/fs_layout.rs`:

```rust
pub fn transcript_name(started_at: DateTime<Local>) -> String {
    format!("transcript_{}.md", started_at.format("%d.%m.%Y"))
}
```

- [ ] **Step 5: Change request and view types**

Update `src-tauri/src/app_state.rs`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct StartRecordingRequest {
    pub source: String,
    pub topic: String,
    pub tags: Vec<String>,
    pub notes: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateSessionDetailsRequest {
    pub session_id: String,
    pub source: String,
    pub notes: String,
    #[serde(default, alias = "customSummaryPrompt")]
    pub custom_summary_prompt: String,
    pub topic: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionMetaView {
    pub session_id: String,
    pub source: String,
    pub notes: String,
    pub custom_summary_prompt: String,
    pub topic: String,
    pub tags: Vec<String>,
}
```

- [ ] **Step 6: Simplify start validation**

Update `src-tauri/src/command_core.rs`:

```rust
pub fn validate_start_request(topic: &str) -> Result<(), String> {
    if topic.chars().count() > 200 {
        return Err("Topic is too long (max 200 chars)".to_string());
    }
    Ok(())
}
```

Remove tests that assert participant count behavior.

- [ ] **Step 7: Update Rust call sites to compile**

Apply these call-site patterns:

In `src-tauri/src/commands/recording.rs`, `start_recording_impl` should call:

```rust
validate_start_request(&payload.topic)?;

let source_from_payload = payload.source.trim();
let source_from_payload = if source_from_payload.is_empty() {
    "zoom".to_string()
} else {
    source_from_payload.to_string()
};
let topic_from_payload = payload.topic.clone();
let meta = SessionMeta::new(
    session_id.clone(),
    source_from_payload.clone(),
    payload.tags,
    payload.topic,
    payload.notes,
);
```

In tests and imports that currently call `SessionMeta::new(session_id, vec![...], topic, vec![])`, use:

```rust
SessionMeta::new(
    "s1".to_string(),
    "slack".to_string(),
    vec!["project/acme".to_string()],
    "Topic".to_string(),
    "Notes".to_string(),
)
```

For imported audio in `src-tauri/src/commands/sessions.rs`, create metadata with:

```rust
let mut meta = SessionMeta::new(
    session_id.clone(),
    "other".to_string(),
    vec![],
    topic,
    String::new(),
);
```

- [ ] **Step 8: Run backend tests**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test session_meta_new_stores_source_tags_and_notes_independently --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test builds_artifact_names_in_ru_date --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo check --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/domain/session.rs src-tauri/src/storage/fs_layout.rs src-tauri/src/app_state.rs src-tauri/src/command_core.rs src-tauri/src/commands/recording.rs src-tauri/src/commands/sessions.rs src-tauri/src/storage/sqlite_repo.rs src-tauri/src/main.rs
git commit -m "feat: replace participants with source tags notes metadata"
```

---

### Task 3: Markdown Artifact Frontmatter Helpers

**Files:**
- Create: `src-tauri/src/storage/markdown_artifact.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Test: `src-tauri/src/storage/markdown_artifact.rs`

- [ ] **Step 1: Write failing helper tests**

Create `src-tauri/src/storage/markdown_artifact.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::SessionMeta;
    use tempfile::tempdir;

    fn meta_with_notes(notes: &str) -> SessionMeta {
        SessionMeta::new(
            "s-md".to_string(),
            "zoom".to_string(),
            vec!["project/acme".to_string(), "call/sales".to_string()],
            "Renewal sync".to_string(),
            notes.to_string(),
        )
    }

    #[test]
    fn render_frontmatter_uses_inline_notes_for_single_line_text() {
        let meta = meta_with_notes("важный созвон, проверить договор");

        let frontmatter = render_frontmatter(&meta);

        assert!(frontmatter.starts_with("---\n"));
        assert!(frontmatter.contains("source: \"zoom\"\n"));
        assert!(frontmatter.contains("  - \"project/acme\"\n"));
        assert!(frontmatter.contains("notes: \"важный созвон, проверить договор\"\n"));
        assert!(frontmatter.contains("topic: \"Renewal sync\"\n"));
        assert!(frontmatter.ends_with("---\n\n"));
    }

    #[test]
    fn render_frontmatter_uses_block_scalar_for_multiline_notes() {
        let meta = meta_with_notes("Проверить договор.\nОтдельно спросить про сроки.");

        let frontmatter = render_frontmatter(&meta);

        assert!(frontmatter.contains("notes: |\n"));
        assert!(frontmatter.contains("  Проверить договор.\n"));
        assert!(frontmatter.contains("  Отдельно спросить про сроки.\n"));
    }

    #[test]
    fn strip_frontmatter_returns_body_without_yaml_block() {
        let text = "---\nsource: zoom\n---\n\nSpeaker 1: hello\n";

        assert_eq!(strip_frontmatter(text), "Speaker 1: hello\n");
    }

    #[test]
    fn refresh_frontmatter_preserves_existing_body() {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("summary.md");
        std::fs::write(&path, "---\nsource: old\n---\n\n## Summary\nBody").expect("write");
        let meta = meta_with_notes("new note");

        refresh_markdown_frontmatter(&path, &meta).expect("refresh");

        let updated = std::fs::read_to_string(&path).expect("read");
        assert!(updated.contains("source: \"zoom\"\n"));
        assert!(updated.contains("notes: \"new note\"\n"));
        assert!(updated.ends_with("## Summary\nBody"));
    }
}
```

Update `src-tauri/src/storage/mod.rs` so Cargo compiles the new module:

```rust
pub mod fs_layout;
pub mod markdown_artifact;
pub mod session_store;
pub mod sqlite_repo;
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test markdown_artifact --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because `render_frontmatter`, `strip_frontmatter`, and `refresh_markdown_frontmatter` do not exist.

- [ ] **Step 3: Implement Markdown helpers**

Replace `src-tauri/src/storage/markdown_artifact.rs` with:

```rust
use crate::domain::session::SessionMeta;
use std::fs;
use std::path::Path;

fn yaml_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "");
    format!("\"{escaped}\"")
}

fn render_notes(notes: &str) -> String {
    let normalized = notes.replace('\r', "");
    if normalized.trim().is_empty() {
        return "notes: \"\"\n".to_string();
    }
    if !normalized.contains('\n') {
        return format!("notes: {}\n", yaml_quote(normalized.trim()));
    }

    let mut out = String::from("notes: |\n");
    for line in normalized.lines() {
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
    }
    out
}

pub fn render_frontmatter(meta: &SessionMeta) -> String {
    let mut out = String::from("---\n");
    out.push_str("source: ");
    out.push_str(&yaml_quote(meta.source.trim()));
    out.push('\n');
    out.push_str("tags:\n");
    for tag in &meta.tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        out.push_str("  - ");
        out.push_str(&yaml_quote(tag));
        out.push('\n');
    }
    out.push_str(&render_notes(&meta.notes));
    out.push_str("topic: ");
    out.push_str(&yaml_quote(meta.topic.trim()));
    out.push('\n');
    out.push_str("---\n\n");
    out
}

pub fn strip_frontmatter(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("---\n") else {
        return text;
    };
    let Some(end) = rest.find("\n---\n") else {
        return text;
    };
    let body_start = end + "\n---\n".len();
    rest[body_start..].strip_prefix('\n').unwrap_or(&rest[body_start..])
}

pub fn render_markdown_artifact(meta: &SessionMeta, body: &str) -> String {
    let mut out = render_frontmatter(meta);
    out.push_str(body.trim_start_matches('\n'));
    out
}

pub fn write_markdown_artifact(path: &Path, meta: &SessionMeta, body: &str) -> Result<(), String> {
    fs::write(path, render_markdown_artifact(meta, body)).map_err(|e| e.to_string())
}

pub fn refresh_markdown_frontmatter(path: &Path, meta: &SessionMeta) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let current = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if current.trim().is_empty() {
        return Ok(());
    }
    let body = strip_frontmatter(&current).to_string();
    write_markdown_artifact(path, meta, &body)
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test markdown_artifact --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage/mod.rs src-tauri/src/storage/markdown_artifact.rs
git commit -m "feat: add markdown artifact frontmatter helpers"
```

---

### Task 4: Pipeline Markdown Writes and Frontmatter Stripping

**Files:**
- Modify: `src-tauri/src/services/pipeline_runner.rs`
- Modify: tests in `src-tauri/src/services/pipeline_runner.rs`
- Test: `src-tauri/src/services/pipeline_runner.rs`

- [ ] **Step 1: Write failing transcript body helper test**

In `src-tauri/src/services/pipeline_runner.rs` tests, add:

```rust
#[test]
fn transcript_body_for_summary_strips_markdown_frontmatter() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let transcript_path = tmp.path().join("transcript.md");
    std::fs::write(
        &transcript_path,
        "---\nsource: zoom\ntags:\n  - project/acme\n---\n\nSpeaker 1: hello",
    )
    .expect("write transcript");

    let body = read_transcript_body_for_summary(&transcript_path).expect("body");

    assert_eq!(body, "Speaker 1: hello");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test transcript_body_for_summary_strips_markdown_frontmatter --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because `read_transcript_body_for_summary` does not exist.

- [ ] **Step 3: Add transcript reader helper**

In `src-tauri/src/services/pipeline_runner.rs`, add near the existing helper functions:

```rust
fn read_transcript_body_for_summary(transcript_path: &Path) -> Result<String, String> {
    let text = fs::read_to_string(transcript_path)
        .map_err(|_| "Transcript file is missing".to_string())?;
    let body = crate::storage::markdown_artifact::strip_frontmatter(&text);
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Transcript file is empty".to_string());
    }
    Ok(trimmed.to_string())
}
```

- [ ] **Step 4: Write Markdown artifacts in the pipeline**

In the transcription success block, replace raw `fs::write` with:

```rust
crate::storage::markdown_artifact::write_markdown_artifact(
    &session_dir.join(&meta.artifacts.transcript_file),
    &meta,
    &transcribed,
)
.map_err(|e| e.to_string())?;
```

In the summary branch where no new transcript was generated, replace manual `fs::read_to_string` with:

```rust
let transcript_path = session_dir.join(&meta.artifacts.transcript_file);
let transcript_for_summary = read_transcript_body_for_summary(&transcript_path)?;
```

In the summary success block, replace raw `fs::write` with:

```rust
crate::storage::markdown_artifact::write_markdown_artifact(
    &session_dir.join(&meta.artifacts.summary_file),
    &meta,
    &summary,
)
.map_err(|e| e.to_string())?;
```

- [ ] **Step 5: Run pipeline helper test**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test transcript_body_for_summary_strips_markdown_frontmatter --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 6: Run pipeline runner tests**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test pipeline_runner --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/services/pipeline_runner.rs
git commit -m "feat: write pipeline artifacts as markdown notes"
```

---

### Task 5: Backend Known Tags and Session Detail Commands

**Files:**
- Create: `src-tauri/src/storage/tag_index.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/storage/sqlite_repo.rs`
- Test: `src-tauri/src/storage/tag_index.rs`
- Test: `src-tauri/src/commands/sessions.rs`

- [ ] **Step 1: Write failing tag index tests**

Create `src-tauri/src/storage/tag_index.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::SessionMeta;
    use crate::storage::session_store::save_meta;
    use crate::storage::sqlite_repo::upsert_session;
    use tempfile::tempdir;

    #[test]
    fn collect_known_tags_returns_sorted_unique_non_empty_tags() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        std::fs::create_dir_all(&app_data_dir).expect("app data");
        let session_dir = tmp.path().join("s1");
        std::fs::create_dir_all(&session_dir).expect("session dir");
        let meta_path = session_dir.join("meta.json");
        let mut meta = SessionMeta::new(
            "s-tags".to_string(),
            "zoom".to_string(),
            vec![
                "project/acme".to_string(),
                "call/sales".to_string(),
                "project/acme".to_string(),
                " ".to_string(),
            ],
            "Topic".to_string(),
            String::new(),
        );
        save_meta(&meta_path, &meta).expect("save meta");
        upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert");

        meta.session_id = "s-tags-2".to_string();
        meta.tags = vec!["person/ivan".to_string(), "call/sales".to_string()];
        let session_dir_2 = tmp.path().join("s2");
        std::fs::create_dir_all(&session_dir_2).expect("session dir 2");
        let meta_path_2 = session_dir_2.join("meta.json");
        save_meta(&meta_path_2, &meta).expect("save meta 2");
        upsert_session(&app_data_dir, &meta, &session_dir_2, &meta_path_2).expect("upsert 2");

        let tags = collect_known_tags(&app_data_dir).expect("tags");

        assert_eq!(
            tags,
            vec![
                "call/sales".to_string(),
                "person/ivan".to_string(),
                "project/acme".to_string()
            ]
        );
    }
}
```

Update `src-tauri/src/storage/mod.rs` so Cargo compiles the new module:

```rust
pub mod tag_index;
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test collect_known_tags_returns_sorted_unique_non_empty_tags --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: FAIL because `collect_known_tags` does not exist.

- [ ] **Step 3: Implement tag index collection**

Replace `src-tauri/src/storage/tag_index.rs` with:

```rust
use crate::storage::session_store::load_meta;
use crate::storage::sqlite_repo::{get_meta_path, list_sessions};
use std::collections::BTreeSet;
use std::path::Path;

pub fn normalize_tag(value: &str) -> Option<String> {
    let tag = value.trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

pub fn normalize_tags(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for value in values {
        if let Some(tag) = normalize_tag(&value) {
            seen.insert(tag);
        }
    }
    seen.into_iter().collect()
}

pub fn collect_known_tags(app_data_dir: &Path) -> Result<Vec<String>, String> {
    let sessions = list_sessions(app_data_dir)?;
    let mut tags = BTreeSet::new();
    for session in sessions {
        let Some(meta_path) = get_meta_path(app_data_dir, &session.session_id)? else {
            continue;
        };
        let Ok(meta) = load_meta(&meta_path) else {
            continue;
        };
        for tag in meta.tags {
            if let Some(normalized) = normalize_tag(&tag) {
                tags.insert(normalized);
            }
        }
    }
    Ok(tags.into_iter().collect())
}
```

Ensure `src-tauri/src/storage/mod.rs` still exports the tag index module:

```rust
pub mod tag_index;
```

- [ ] **Step 4: Add tag cache fields**

Update `src-tauri/src/app_state.rs` imports and `AppState`:

```rust
use std::collections::BTreeSet;
```

```rust
pub struct AppState {
    pub active_session: Mutex<Option<SessionMeta>>,
    pub active_capture: Mutex<Option<audio::capture::ContinuousCapture>>,
    pub ui_sync: Mutex<UiSyncState>,
    pub live_levels: audio::capture::SharedLevels,
    pub recording_control: audio::capture::SharedRecordingControl,
    pub tray_app: Mutex<Option<AppHandle>>,
    pub known_tags: Mutex<BTreeSet<String>>,
    pub known_tags_hydrated: Mutex<bool>,
}
```

Default:

```rust
known_tags: Mutex::new(BTreeSet::new()),
known_tags_hydrated: Mutex::new(false),
```

- [ ] **Step 5: Write failing command test**

In `src-tauri/src/commands/sessions.rs` tests, add:

```rust
#[test]
fn known_tags_command_hydrates_sorted_tags_from_metadata() {
    let tmp = tempdir().expect("tempdir");
    let app_data_dir = tmp.path().join("app-data");
    fs::create_dir_all(&app_data_dir).expect("app data");
    let session_dir = tmp.path().join("s-known");
    fs::create_dir_all(&session_dir).expect("session dir");
    let meta_path = session_dir.join("meta.json");
    let meta = SessionMeta::new(
        "s-known".to_string(),
        "zoom".to_string(),
        vec!["project/acme".to_string(), "call/sales".to_string()],
        "Topic".to_string(),
        String::new(),
    );
    save_meta(&meta_path, &meta).expect("save meta");
    upsert_session(&app_data_dir, &meta, &session_dir, &meta_path).expect("upsert");
    let state = AppState::default();
    let dirs = AppDirs { app_data_dir };

    let tags = list_known_tags_impl(&dirs, &state).expect("known tags");

    assert_eq!(tags, vec!["call/sales".to_string(), "project/acme".to_string()]);
}
```

- [ ] **Step 6: Implement known-tag command helpers**

In `src-tauri/src/commands/sessions.rs`, add:

```rust
fn add_tags_to_known_index(state: &AppState, tags: &[String]) -> Result<(), String> {
    let mut known = state
        .known_tags
        .lock()
        .map_err(|_| "known tags lock poisoned".to_string())?;
    for tag in tags {
        if let Some(normalized) = crate::storage::tag_index::normalize_tag(tag) {
            known.insert(normalized);
        }
    }
    Ok(())
}

fn rebuild_known_tags(dirs: &AppDirs, state: &AppState) -> Result<(), String> {
    let tags = crate::storage::tag_index::collect_known_tags(&dirs.app_data_dir)?;
    let mut known = state
        .known_tags
        .lock()
        .map_err(|_| "known tags lock poisoned".to_string())?;
    *known = tags.into_iter().collect();
    *state
        .known_tags_hydrated
        .lock()
        .map_err(|_| "known tags hydrated lock poisoned".to_string())? = true;
    Ok(())
}

fn list_known_tags_impl(dirs: &AppDirs, state: &AppState) -> Result<Vec<String>, String> {
    let hydrated = *state
        .known_tags_hydrated
        .lock()
        .map_err(|_| "known tags hydrated lock poisoned".to_string())?;
    if !hydrated {
        rebuild_known_tags(dirs, state)?;
    }
    let known = state
        .known_tags
        .lock()
        .map_err(|_| "known tags lock poisoned".to_string())?;
    Ok(known.iter().cloned().collect())
}

#[tauri::command]
pub fn list_known_tags(
    dirs: tauri::State<AppDirs>,
    state: tauri::State<AppState>,
) -> Result<Vec<String>, String> {
    list_known_tags_impl(dirs.inner(), state.inner())
}
```

Update Tauri command registration in `src-tauri/src/main.rs` and command exports in `src-tauri/src/commands/mod.rs` to include `list_known_tags`.

- [ ] **Step 7: Update session details command**

In `get_session_meta`, return direct fields:

```rust
Ok(SessionMetaView {
    session_id: meta.session_id,
    source: meta.source,
    notes: meta.notes,
    custom_summary_prompt: meta.custom_summary_prompt,
    topic: meta.topic,
    tags: meta.tags,
})
```

In `update_session_details`, normalize tags and refresh frontmatter:

```rust
let source = payload.source.trim();
let source = if source.is_empty() {
    meta.source.clone()
} else {
    source.to_string()
};
let tags = crate::storage::tag_index::normalize_tags(payload.tags);

meta.source = source.clone();
meta.primary_tag = source;
meta.tags = tags;
meta.notes = payload.notes.trim().to_string();
meta.custom_summary_prompt = payload.custom_summary_prompt.trim().to_string();
meta.topic = payload.topic.trim().to_string();

let session_dir = meta_path
    .parent()
    .ok_or_else(|| "Invalid session directory".to_string())?;
save_meta(&meta_path, &meta)?;
upsert_session(&dirs.app_data_dir, &meta, session_dir, &meta_path)?;
crate::storage::markdown_artifact::refresh_markdown_frontmatter(
    &session_dir.join(&meta.artifacts.transcript_file),
    &meta,
)?;
crate::storage::markdown_artifact::refresh_markdown_frontmatter(
    &session_dir.join(&meta.artifacts.summary_file),
    &meta,
)?;
```

Change the command signature to include `state: tauri::State<AppState>` and call:

```rust
add_tags_to_known_index(state.inner(), &meta.tags)?;
```

Update event detail to:

```rust
"Source/topic/tags/notes/summary prompt updated"
```

- [ ] **Step 8: Update deletion tag rebuild**

After successful delete in `delete_session`, call:

```rust
rebuild_known_tags(dirs.inner(), state.inner())?;
```

- [ ] **Step 9: Update list metadata**

In `src-tauri/src/storage/sqlite_repo.rs`, change `SessionListMeta`:

```rust
pub struct SessionListMeta {
    pub session_id: String,
    pub source: String,
    pub notes: String,
    pub topic: String,
    pub tags: Vec<String>,
}
```

When enriching from `meta`, set:

```rust
item.meta = Some(SessionListMeta {
    session_id: meta.session_id.clone(),
    source: meta.source.clone(),
    notes: meta.notes.clone(),
    topic: meta.topic.clone(),
    tags: meta.tags.clone(),
});
```

- [ ] **Step 10: Update start recording to known tags**

In `src-tauri/src/commands/recording.rs`, after `upsert_session` succeeds, add:

```rust
if let Ok(mut known) = state.known_tags.lock() {
    for tag in &meta.tags {
        if let Some(normalized) = crate::storage::tag_index::normalize_tag(tag) {
            known.insert(normalized);
        }
    }
}
```

- [ ] **Step 11: Run tests**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test collect_known_tags_returns_sorted_unique_non_empty_tags --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test known_tags_command_hydrates_sorted_tags_from_metadata --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo check --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src-tauri/src/storage/tag_index.rs src-tauri/src/storage/mod.rs src-tauri/src/app_state.rs src-tauri/src/commands/sessions.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs src-tauri/src/storage/sqlite_repo.rs src-tauri/src/commands/recording.rs
git commit -m "feat: add backend known tags index"
```

---

### Task 6: Frontend Types, Hooks, and Tag Autocomplete Data

**Files:**
- Modify: `src/appTypes.ts`
- Modify: `src/lib/appUtils.ts`
- Modify: `src/features/sessions/useSessions.ts`
- Modify: `src/features/sessions/useSessions.test.tsx`
- Modify: `src/features/recording/useRecordingController.ts`
- Modify: `src/features/recording/useRecordingController.test.tsx`
- Modify: `src/App.main.test.tsx`
- Modify: `src/App.tray.test.tsx`

- [ ] **Step 1: Write failing hook tests for notes and tags**

In `src/features/sessions/useSessions.test.tsx`, update the inline metadata fixture to use:

```ts
meta: {
  session_id: "s-inline",
  source: "slack",
  notes: "Inline note",
  custom_summary_prompt: "Inline summary prompt",
  topic: "Inline topic",
  tags: ["project/acme", "call/sales"],
},
```

Add expectations:

```ts
expect(result.current.sessionDetails["s-inline"]?.notes).toBe("Inline note");
expect(result.current.sessionDetails["s-inline"]?.tags).toEqual(["project/acme", "call/sales"]);
```

Add a new test:

```tsx
it("loads known tags for autocomplete", async () => {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "list_sessions") return [];
    if (cmd === "list_known_tags") return ["call/sales", "project/acme"];
    return null;
  });

  const { result } = renderHook(() =>
    useSessions({ setStatus: vi.fn(), lastSessionId: null, setLastSessionId: vi.fn() })
  );

  await waitFor(() => {
    expect(result.current.knownTags).toEqual(["call/sales", "project/acme"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- src/features/sessions/useSessions.test.tsx
```

Expected: FAIL because `notes`, `tags`, and `knownTags` are not in frontend types and hooks.

- [ ] **Step 3: Update frontend types**

Update `src/appTypes.ts`:

```ts
export type SessionMetaView = {
  session_id: string;
  source: string;
  notes: string;
  custom_summary_prompt?: string;
  topic: string;
  tags: string[];
};
```

- [ ] **Step 4: Add tag helpers**

Update `src/lib/appUtils.ts`:

```ts
export function normalizeTags(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

export function splitTags(value: string): string[] {
  return normalizeTags(value.split(","));
}
```

Do not keep `splitParticipants` after all call sites are migrated.

- [ ] **Step 5: Update `useSessions` metadata flow**

In `src/features/sessions/useSessions.ts`, replace `sameParticipants` with:

```ts
function sameTags(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
```

Update metadata comparison:

```ts
left.notes === right.notes &&
sameTags(left.tags, right.tags)
```

Update signature:

```ts
return `${meta.session_id}\n${meta.source}\n${meta.notes}\n${meta.custom_summary_prompt ?? ""}\n${meta.topic}\n${meta.tags.join("\u001f")}`;
```

Update fallback:

```ts
function fallbackSessionMeta(item: SessionListItem): SessionMetaView {
  return {
    session_id: item.session_id,
    source: item.primary_tag,
    notes: "",
    custom_summary_prompt: "",
    topic: item.topic,
    tags: [],
  };
}
```

Add state:

```ts
const [knownTags, setKnownTags] = useState<string[]>([]);
```

Add loader:

```ts
async function loadKnownTags() {
  const tags = await tauriInvoke<string[]>("list_known_tags");
  setKnownTags(tags ?? []);
}
```

Call it from `loadSessions` after session details are loaded:

```ts
await loadKnownTags().catch(() => undefined);
```

Persist payload:

```ts
payload: {
  session_id: sessionId,
  source: detail.source,
  notes: detail.notes,
  custom_summary_prompt: detail.custom_summary_prompt ?? "",
  topic: detail.topic,
  tags: detail.tags,
},
```

Search:

```ts
const notesValue = (detail?.notes ?? "").toLowerCase();
const tagsValue = (detail?.tags ?? []).join(", ").toLowerCase();
```

Return `knownTags`.

- [ ] **Step 6: Update recording controller contract**

In `src/features/recording/useRecordingController.ts`, replace `participants` with:

```ts
tags: string[];
setTags: Setter<string[]>;
notes: string;
setNotes: Setter<string>;
```

Change `startRecording` payload:

```ts
async function startRecording(payload: {
  source: string;
  topic?: string;
  tags?: string[];
  notes?: string;
  surface?: string;
}) {
  void captureAnalyticsEvent("rec_clicked", {
    source: payload.source,
    surface: payload.surface ?? (isTrayWindow ? "tray" : "main"),
    tags_count: payload.tags?.length ?? 0,
    notes_present: Boolean(payload.notes?.trim()),
    topic_present: Boolean(payload.topic?.trim()),
  });
  const response = await tauriInvoke<StartResponse>("start_recording", {
    payload: {
      source: payload.source,
      topic: payload.topic ?? "",
      tags: payload.tags ?? [],
      notes: payload.notes ?? "",
    },
  });
  setRecordingSession(response.session_id);
  setStatus("recording");
  await loadSessions();
}
```

`start()` sends current `tags` and `notes`; `startFromTray()` sends `tags: []` and `notes: ""`.

- [ ] **Step 7: Update tests and mocks**

In frontend tests, replace all expected `custom_tag` with `notes` and all expected `participants` with `tags`. Example expected payload:

```ts
expect(invokeMock).toHaveBeenCalledWith("update_session_details", {
  payload: {
    session_id: "s2",
    source: "zoom",
    notes: "Edited note",
    custom_summary_prompt: "",
    topic: "Edited topic",
    tags: ["project/acme"],
  },
});
```

Example start recording payload:

```ts
expect(invokeMock).toHaveBeenCalledWith("start_recording", {
  payload: {
    source: "telegram",
    topic: "Q1 planning",
    tags: [],
    notes: "",
  },
});
```

- [ ] **Step 8: Run frontend hook tests**

Run:

```bash
npm test -- src/features/sessions/useSessions.test.tsx src/features/recording/useRecordingController.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/appTypes.ts src/lib/appUtils.ts src/features/sessions/useSessions.ts src/features/sessions/useSessions.test.tsx src/features/recording/useRecordingController.ts src/features/recording/useRecordingController.test.tsx src/App.main.test.tsx src/App.tray.test.tsx
git commit -m "feat: update frontend metadata contract for tags notes"
```

---

### Task 7: Ant Design Component Migration Without Layout Movement

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`
- Modify: `src/App.main.test.tsx`
- Modify: `src/App.settings.test.tsx`
- Modify: `src/App.tray.test.tsx`
- Modify: `src/App.css.test.ts`

- [ ] **Step 1: Write failing UI tests for labels and payloads**

In `src/App.main.test.tsx`, add:

```tsx
it("renders Tags and Notes in the existing session edit grid positions", async () => {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "list_sessions") {
      return [
        {
          session_id: "s-tags-ui",
          status: "recorded",
          primary_tag: "zoom",
          topic: "Renewal sync",
          display_date_ru: "11.03.2026",
          started_at_iso: "2026-03-11T10:00:00+03:00",
          session_dir: "/tmp/s-tags-ui",
          audio_format: "wav",
          audio_duration_hms: "00:20:00",
          has_transcript_text: false,
          has_summary_text: false,
          meta: {
            session_id: "s-tags-ui",
            source: "zoom",
            notes: "Check contract",
            custom_summary_prompt: "",
            topic: "Renewal sync",
            tags: ["project/acme"],
          },
        },
      ];
    }
    if (cmd === "list_known_tags") return ["call/sales", "project/acme"];
    return null;
  });

  render(<App />);

  await waitFor(() => {
    expect(screen.getByText("Tags")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  expect(screen.queryByText("Participants")).not.toBeInTheDocument();
  expect(screen.queryByText("Custom tag")).not.toBeInTheDocument();
  expect(document.querySelector(".session-edit-grid")).toBeInTheDocument();
  expect(document.querySelector(".session-edit-grid .ant-select")).toBeInTheDocument();
  expect(document.querySelector(".session-edit-grid textarea.ant-input")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/App.main.test.tsx -t "renders Tags and Notes in the existing session edit grid positions"
```

Expected: FAIL because the UI still renders old native fields.

- [ ] **Step 3: Import Ant Design components**

At the top of `src/App.tsx`, add:

```tsx
import {
  Alert,
  Button,
  Card,
  Dropdown,
  Flex,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tabs,
  Tooltip,
  Typography,
  type MenuProps,
} from "antd";
```

Keep existing layout class names on wrappers.

- [ ] **Step 4: Add local tag option helper**

Inside `App`, after `knownTags` is available from `useSessions`, add:

```tsx
const knownTagOptions = knownTags.map((tag) => ({ value: tag, label: tag }));
```

- [ ] **Step 5: Replace session edit fields without changing wrapper grid**

In the existing `.session-edit-grid`, preserve the four field slots and replace controls with:

```tsx
<label className={`field${sourceMatch ? " match-hit" : ""}`}>
  Source
  <Select
    value={detail.source}
    options={fixedSources.map((s) => ({ value: s, label: s }))}
    onChange={(value) =>
      setSessionDetails((prev) => ({
        ...prev,
        [item.session_id]: { ...detail, source: value },
      }))
    }
  />
</label>
<label className={`field${topicMatch ? " match-hit" : ""}`}>
  Topic
  <Input
    value={detail.topic}
    onChange={(e) =>
      setSessionDetails((prev) => ({
        ...prev,
        [item.session_id]: { ...detail, topic: e.target.value },
      }))
    }
  />
</label>
<label className={`field${tagsMatch ? " match-hit" : ""}`}>
  Tags
  <Select
    mode="tags"
    value={detail.tags}
    options={knownTagOptions}
    tokenSeparators={[","]}
    onChange={(value) =>
      setSessionDetails((prev) => ({
        ...prev,
        [item.session_id]: { ...detail, tags: value },
      }))
    }
  />
</label>
<label className={`field${notesMatch ? " match-hit" : ""}`}>
  Notes
  <Input.TextArea
    value={detail.notes}
    autoSize={{ minRows: 1, maxRows: 4 }}
    onChange={(e) =>
      setSessionDetails((prev) => ({
        ...prev,
        [item.session_id]: { ...detail, notes: e.target.value },
      }))
    }
  />
</label>
```

Use `notesMatch` and `tagsMatch` calculated from search query. Keep the existing `.session-edit-grid` class and do not move the field block to another location.

- [ ] **Step 6: Replace toolbar controls in place**

Replace search input with:

```tsx
<Input.Search
  id="session-search-input"
  ref={sessionSearchInputRef}
  aria-label="Search sessions"
  value={sessionSearchQuery}
  onChange={(e) => setSessionSearchQuery(e.target.value)}
  allowClear
/>
```

Keep `.session-toolbar`, `.session-toolbar-header`, `.session-toolbar-actions`, and `.session-toolbar-search`.

Replace import and refresh buttons with `Button` in the same containers:

```tsx
<Button type="default" onClick={() => void importAudioSession()}>
  Загрузить аудио
</Button>
```

The refresh button may stay icon-only but should be `Button` with `aria-label="Refresh sessions"`.

- [ ] **Step 7: Replace dialogs with Modal without changing behavior**

For delete confirmation, use:

```tsx
<Modal
  open={Boolean(deleteTarget)}
  title="Подтверждение удаления"
  onCancel={() => setDeleteTarget(null)}
  footer={[
    <Button key="cancel" onClick={() => setDeleteTarget(null)} disabled={deletePendingSessionId !== null}>
      Отмена
    </Button>,
    <Button
      key="delete"
      danger
      onClick={() => void confirmDeleteSession()}
      loading={deletePendingSessionId !== null}
    >
      Удалить
    </Button>,
  ]}
>
  <p>{deleteTarget?.force ? "Сессия помечена как активная. Принудительно удалить сессию и все связанные файлы?" : "Удалить сессию и все связанные файлы?"}</p>
</Modal>
```

For artifact preview and summary prompt, use `Modal` in the same render location currently occupied by overlay JSX. Preserve keyboard behavior via Ant Design `keyboard` defaults and existing state transitions.

- [ ] **Step 8: Replace context menu with Dropdown menu**

Build `MenuProps["items"]` from the existing actions and render it at the same state coordinates:

```tsx
const sessionContextMenuItems: MenuProps["items"] = sessionContextMenuItem
  ? [
      { key: "folder", label: "Открыть папку сессии", onClick: () => void openSessionFolder(sessionContextMenuItem.session_dir) },
      { key: "text", label: "Сгенерировать текст", disabled: sessionContextMenuTextPending || sessionContextMenuSummaryPending, onClick: () => void getText(sessionContextMenuItem.session_id) },
      { key: "summary", label: "Сгенерировать саммари", disabled: !sessionContextMenuItem.has_transcript_text || sessionContextMenuSummaryPending || sessionContextMenuTextPending, onClick: () => void getSummary(sessionContextMenuItem.session_id) },
      { key: "prompt", label: "Настроить промпт саммари", onClick: () => void openSummaryPromptDialogForSession(sessionContextMenuDetail!) },
      { key: "delete", label: "Удалить", danger: true, onClick: () => requestDeleteSession(sessionContextMenuItem.session_id, sessionContextMenuItem.status === "recording") },
    ]
  : [];
```

Keep right-click state handling unchanged. Do not move the context menu trigger logic off the session card.

- [ ] **Step 9: Replace settings fields in place**

Inside `renderSettingsFields`, replace native inputs/selects/buttons with `Input`, `Input.Password`, `Input.TextArea`, `InputNumber`, `Select`, `Button`, `Switch`, `Tabs`, or `Segmented` while preserving:

- `.settings-tabs`
- `.settings-tab-list`
- `.settings-tab-panel`
- `.settings-tab-grid`
- `.settings-subsections`
- `.settings-actions`

Do not reorder settings sections or move fields between tabs.

- [ ] **Step 10: Replace tray controls in place**

In tray UI, replace source select and topic input with Ant Design `Select` and `Input`, preserving `.tray-meta-grid`, `.tray-source-field`, `.tray-topic-field`, `.tray-audio-rows`, and `.button-row`.

Do not add tags or notes to tray.

- [ ] **Step 11: Reduce CSS to layout and special controls**

In `src/App.css`, keep:

- CSS variables.
- app shell and tray shell layout.
- grid classes listed in the spec.
- audio row and audio player CSS.
- search toolbar layout.
- responsive media queries.

Remove or reduce old button/input skin classes only after their JSX is migrated. Keep `.field` as a label layout wrapper:

```css
.field {
  display: grid;
  gap: 5px;
  font-size: 14px;
  color: var(--text-muted);
}

.field .ant-input,
.field .ant-select,
.field .ant-input-number {
  width: 100%;
}
```

- [ ] **Step 12: Run targeted UI test**

Run:

```bash
npm test -- src/App.main.test.tsx -t "renders Tags and Notes in the existing session edit grid positions"
```

Expected: PASS.

- [ ] **Step 13: Run all frontend tests**

Run:

```bash
npm test -- src/App.main.test.tsx src/App.settings.test.tsx src/App.tray.test.tsx src/features/sessions/useSessions.test.tsx src/features/recording/useRecordingController.test.tsx src/App.css.test.ts
```

Expected: PASS.

- [ ] **Step 14: Run frontend build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add src/App.tsx src/App.css src/App.main.test.tsx src/App.settings.test.tsx src/App.tray.test.tsx src/App.css.test.ts
git commit -m "feat: migrate frontend controls to ant design"
```

---

### Task 8: Command Flow Integration and Final Verification

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tests/command_flow_integration.rs`
- Modify: `src-tauri/tests/asset_protocol_config_integration.rs` only if compile errors require metadata fixture updates
- Modify: `docs/implementation-status.md`

- [ ] **Step 1: Update command invocation tests**

In `src-tauri/src/main.rs`, update JSON payloads:

```rust
"payload": {
  "source": "zoom",
  "topic": "",
  "tags": ["project/acme"],
  "notes": "Check renewal"
}
```

Update detail assertions:

```rust
assert_eq!(details["source"], "zoom");
assert_eq!(details["notes"], "Check renewal");
assert_eq!(
    serde_json::from_value::<Vec<String>>(details["tags"].clone()).expect("tags"),
    vec!["project/acme".to_string()]
);
```

- [ ] **Step 2: Update integration fixtures**

In `src-tauri/tests/command_flow_integration.rs`, replace metadata construction with:

```rust
let mut meta = SessionMeta::new(
    session_id.to_string(),
    "zoom".to_string(),
    vec!["project/acme".to_string()],
    "Integration topic".to_string(),
    "Integration note".to_string(),
);
```

Use transcript file names ending in `.md`.

- [ ] **Step 3: Add implementation status note**

Append to `docs/implementation-status.md` under implemented items:

```md
- Obsidian metadata update:
  - `participants` removed from session metadata and UI
  - user tags stored in `meta.tags`
  - notes stored in `meta.notes`
  - transcript and summary artifacts generated as `.md` with YAML frontmatter
  - backend in-memory known-tags index powers tag autocomplete
  - frontend controls migrated to Ant Design with `glassTheme` while preserving layout
```

- [ ] **Step 4: Run full frontend test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Run frontend build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Run Rust checks**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo check --manifest-path src-tauri/Cargo.toml --bin bigecho
```

Expected: PASS.

- [ ] **Step 7: Run Rust tests**

Run:

```bash
env CLANG_MODULE_CACHE_PATH=/tmp/bigecho-clang-cache cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 8: Inspect generated artifact behavior manually through tests or local dev**

Start a local session only if audio permissions and devices are available. If manual recording is not available, use backend tests as the verification source.

Expected generated transcript shape:

```md
---
source: "zoom"
tags:
  - "project/acme"
notes: "Check renewal"
topic: "Renewal sync"
---

Speaker 1: ...
```

Expected generated summary shape:

```md
---
source: "zoom"
tags:
  - "project/acme"
notes: "Check renewal"
topic: "Renewal sync"
---

## Summary
...
```

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/tests/command_flow_integration.rs src-tauri/tests/asset_protocol_config_integration.rs docs/implementation-status.md
git commit -m "test: update command flow for obsidian metadata"
```

---

## Self-Review Checklist

- [ ] `participants` does not appear in production TypeScript or Rust code except historical docs or removed-test diffs.
- [ ] `custom_tag` does not appear in production TypeScript or Rust code.
- [ ] `source` is not stored as the first tag.
- [ ] `tags` autocomplete uses `list_known_tags`.
- [ ] Deleting a session rebuilds known tags.
- [ ] Transcript artifacts use `.md`.
- [ ] Summary generation strips transcript frontmatter.
- [ ] Existing layout wrappers remain in JSX and CSS.
- [ ] Ant Design owns control styling; custom CSS owns layout and Tauri-specific audio UI.
- [ ] `npm test`, `npm run build`, `cargo check`, and `cargo test` pass.
