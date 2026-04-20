# New Version Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when the GitHub repo `chakveselchak/big_echo` has a newer stable release than the installed version, and expose a "New version" tab (right of "Settings" in the main window nav) that shows the release notes and a link to the release.

**Architecture:** A Rust Tauri command fetches the latest release from the GitHub REST API (with a Chrome User-Agent) and returns structured info including a `is_newer` flag derived from a `semver` comparison. The React frontend calls the command once when `MainPage` mounts via a `useVersionCheck` hook. If `is_newer` is true, a third tab appears in `MainPage`; selecting it renders a page with the markdown body (via `react-markdown` + `remark-gfm`) and an external link to the GitHub release.

**Tech Stack:** Rust (Tauri 2, `reqwest`, `serde`, `serde_json`, `semver`), React 18 + TypeScript, Ant Design 5, Vitest + RTL, `@tauri-apps/api`, `react-markdown` + `remark-gfm`.

**Spec:** [docs/superpowers/specs/2026-04-20-check-new-version-design.md](../specs/2026-04-20-check-new-version-design.md)

**Branch:** `claude/check_new_version` (already checked out in worktree).

---

## File Structure

### New files
- `src-tauri/src/commands/updates.rs` — Tauri command `check_for_update`, GitHub client, semver comparison, unit tests.
- `src/hooks/useVersionCheck.ts` — React hook that invokes the command once on mount.
- `src/hooks/useVersionCheck.test.tsx` — unit test for the hook.
- `src/pages/NewVersionPage/index.tsx` — page showing the markdown release body and external link.
- `src/pages/NewVersionPage/index.test.tsx` — unit test for the page.

### Modified files
- `src-tauri/Cargo.toml` — add `semver = "1"` dependency.
- `src-tauri/src/commands/mod.rs` — expose the new `updates` module.
- `src-tauri/src/main.rs` — register `check_for_update` in both the production `invoke_handler` and the test `mock_builder` handler.
- `src/types/index.ts` — add `UpdateInfo` type.
- `src/pages/MainPage/index.tsx` — add the third tab and wire the hook.
- `src/App.main.test.tsx` — add stub responses for `check_for_update` so existing tests don't break; add coverage for the new tab.
- `package.json` — add `react-markdown` and `remark-gfm` to dependencies.

---

## Task 1: Create Rust `updates` module scaffold

**Files:**
- Create: `src-tauri/src/commands/updates.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add `semver` crate**

Open `src-tauri/Cargo.toml` and add the following line inside the `[dependencies]` table (right after the `hostname` line is fine):

```toml
semver = "1"
```

- [ ] **Step 2: Create skeleton `updates.rs` (no logic yet)**

Create `src-tauri/src/commands/updates.rs` with:

```rust
use serde::{Deserialize, Serialize};

const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/chakveselchak/big_echo/releases/latest";

const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub is_newer: bool,
    pub html_url: String,
    pub body: String,
    pub name: String,
    pub published_at: String,
}

/// Strip a leading `v` or `V` from a semver-like tag.
pub(crate) fn normalize_tag(tag: &str) -> &str {
    tag.strip_prefix('v').or_else(|| tag.strip_prefix('V')).unwrap_or(tag)
}

/// Return true if `latest` is strictly greater than `current` per semver.
/// If either string doesn't parse, returns false (no update claimed).
pub(crate) fn is_newer_version(current: &str, latest: &str) -> bool {
    let cur = semver::Version::parse(normalize_tag(current));
    let lat = semver::Version::parse(normalize_tag(latest));
    match (cur, lat) {
        (Ok(c), Ok(l)) => l > c,
        _ => false,
    }
}

/// Build an UpdateInfo from a parsed GitHub release and the app's current version.
pub(crate) fn build_update_info(current: &str, release: GithubRelease) -> UpdateInfo {
    let latest = release.tag_name.clone();
    let is_newer = is_newer_version(current, &latest);
    UpdateInfo {
        current: current.to_string(),
        latest,
        is_newer,
        html_url: release.html_url,
        body: release.body.unwrap_or_default(),
        name: release.name.unwrap_or_else(|| release.tag_name.clone()),
        published_at: release.published_at.unwrap_or_default(),
    }
}
```

- [ ] **Step 3: Expose the new module**

Open `src-tauri/src/commands/mod.rs` and add:

```rust
pub mod recording;
pub mod sessions;
pub mod settings;
pub mod updates;
```

- [ ] **Step 4: Verify the crate still compiles**

Run: `cd src-tauri && cargo build`
Expected: build succeeds with no errors. Warnings about unused items in `updates.rs` are OK at this point.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/mod.rs src-tauri/src/commands/updates.rs
git commit -m "feat(updates): scaffold updates module with version-comparison helpers"
```

---

## Task 2: Unit-test version comparison helpers (TDD)

**Files:**
- Modify: `src-tauri/src/commands/updates.rs` (append a `#[cfg(test)] mod tests` block)

- [ ] **Step 1: Write failing tests**

Append to `src-tauri/src/commands/updates.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_tag_strips_lowercase_v_prefix() {
        assert_eq!(normalize_tag("v2.0.2"), "2.0.2");
    }

    #[test]
    fn normalize_tag_strips_uppercase_v_prefix() {
        assert_eq!(normalize_tag("V2.0.2"), "2.0.2");
    }

    #[test]
    fn normalize_tag_leaves_bare_version_untouched() {
        assert_eq!(normalize_tag("2.0.2"), "2.0.2");
    }

    #[test]
    fn is_newer_true_when_latest_greater() {
        assert!(is_newer_version("2.0.2", "2.1.0"));
    }

    #[test]
    fn is_newer_false_when_equal() {
        assert!(!is_newer_version("2.0.2", "2.0.2"));
    }

    #[test]
    fn is_newer_false_when_latest_lower() {
        assert!(!is_newer_version("2.1.0", "2.0.2"));
    }

    #[test]
    fn is_newer_handles_v_prefix_on_either_side() {
        assert!(is_newer_version("v2.0.2", "v2.1.0"));
    }

    #[test]
    fn is_newer_false_when_unparseable() {
        assert!(!is_newer_version("not-semver", "also-not"));
        assert!(!is_newer_version("2.0.2", "garbage"));
        assert!(!is_newer_version("garbage", "2.0.2"));
    }

    #[test]
    fn build_update_info_fills_defaults_for_missing_fields() {
        let release = GithubRelease {
            tag_name: "2.1.0".to_string(),
            name: None,
            html_url: "https://example.com/r".to_string(),
            body: None,
            published_at: None,
        };
        let info = build_update_info("2.0.2", release);
        assert_eq!(info.current, "2.0.2");
        assert_eq!(info.latest, "2.1.0");
        assert!(info.is_newer);
        assert_eq!(info.body, "");
        assert_eq!(info.name, "2.1.0");
        assert_eq!(info.published_at, "");
        assert_eq!(info.html_url, "https://example.com/r");
    }

    #[test]
    fn build_update_info_reports_not_newer_when_versions_equal() {
        let release = GithubRelease {
            tag_name: "v2.0.2".to_string(),
            name: Some("Release 2.0.2".to_string()),
            html_url: "https://example.com".to_string(),
            body: Some("notes".to_string()),
            published_at: Some("2026-01-01T00:00:00Z".to_string()),
        };
        let info = build_update_info("2.0.2", release);
        assert!(!info.is_newer);
        assert_eq!(info.body, "notes");
        assert_eq!(info.name, "Release 2.0.2");
    }
}
```

- [ ] **Step 2: Run tests (expect them to pass because helpers already exist from Task 1)**

Run: `cd src-tauri && cargo test --lib commands::updates::tests`
Expected: all 10 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/updates.rs
git commit -m "test(updates): cover version parsing and UpdateInfo builder"
```

---

## Task 3: Add the `check_for_update` Tauri command

**Files:**
- Modify: `src-tauri/src/commands/updates.rs`

- [ ] **Step 1: Add the `#[tauri::command]` function and a small reqwest helper**

Append to `src-tauri/src/commands/updates.rs` (before the `#[cfg(test)] mod tests` block):

```rust
async fn fetch_latest_release() -> Result<GithubRelease, String> {
    let client = reqwest::Client::builder()
        .user_agent(CHROME_USER_AGENT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let resp = client
        .get(GITHUB_LATEST_RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub returned status {}", resp.status()));
    }

    resp.json::<GithubRelease>()
        .await
        .map_err(|e| format!("failed to parse GitHub response: {e}"))
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let release = fetch_latest_release().await?;
    Ok(build_update_info(&current, release))
}
```

- [ ] **Step 2: Verify compile**

Run: `cd src-tauri && cargo build`
Expected: builds cleanly. (No new test needed here — HTTP is I/O-bound and we already covered the pure logic.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/updates.rs
git commit -m "feat(updates): add check_for_update tauri command"
```

---

## Task 4: Register `check_for_update` in `main.rs`

**Files:**
- Modify: `src-tauri/src/main.rs:30-35` (imports block)
- Modify: `src-tauri/src/main.rs:436-473` (production invoke_handler)
- Modify: `src-tauri/src/main.rs:629-658` (test mock_builder invoke_handler)

- [ ] **Step 1: Add the import**

Find the `use commands::settings::{ ... }` block near line 30 and add the following line directly below it:

```rust
use commands::updates::check_for_update;
```

- [ ] **Step 2: Register in the production handler**

In the `invoke_handler!` macro invocation near line 436, add `check_for_update` on a new line before the closing `]` (keep trailing commas consistent with surrounding lines):

```rust
            run_transcription,
            run_summary,
            sync_sessions,
            check_for_update
```

(Change the line that was previously `sync_sessions` to end with `,` and append `check_for_update` after it.)

- [ ] **Step 3: Register in the `#[cfg(test)] mock_builder` handler**

Near line 629 there is a second `invoke_handler!` inside a test scaffold. Make the exact same change there — add `check_for_update` to the list so tests that exercise the full handler set keep building.

- [ ] **Step 4: Verify compile + run Rust tests**

Run: `cd src-tauri && cargo build`
Expected: succeeds.

Run: `cd src-tauri && cargo test`
Expected: all existing tests still pass; the 10 new `updates::tests` also pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(updates): register check_for_update command"
```

---

## Task 5: Add npm dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the packages**

Run: `npm install react-markdown remark-gfm`
Expected: `package.json` now lists both packages in `dependencies`, lockfile updated, no errors.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add react-markdown and remark-gfm"
```

---

## Task 6: Add `UpdateInfo` TypeScript type

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Append the type at the end of the file**

Open `src/types/index.ts` and add at the bottom:

```ts
export type UpdateInfo = {
  current: string;
  latest: string;
  is_newer: boolean;
  html_url: string;
  body: string;
  name: string;
  published_at: string;
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add UpdateInfo type"
```

---

## Task 7: `useVersionCheck` hook (TDD)

**Files:**
- Create: `src/hooks/useVersionCheck.ts`
- Create: `src/hooks/useVersionCheck.test.tsx`

- [ ] **Step 1: Write the failing test first**

Create `src/hooks/useVersionCheck.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { UpdateInfo } from "../types";

const invokeMock = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

import { useVersionCheck } from "./useVersionCheck";

const sampleInfo: UpdateInfo = {
  current: "2.0.2",
  latest: "2.1.0",
  is_newer: true,
  html_url: "https://github.com/chakveselchak/big_echo/releases/tag/v2.1.0",
  body: "## Changes\n- Something new",
  name: "v2.1.0",
  published_at: "2026-04-20T00:00:00Z",
};

describe("useVersionCheck", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes check_for_update exactly once on mount", async () => {
    invokeMock.mockResolvedValueOnce(sampleInfo);
    const { result } = renderHook(() => useVersionCheck());
    await waitFor(() => expect(result.current.updateInfo).toEqual(sampleInfo));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("check_for_update");
  });

  it("leaves updateInfo null on error and does not throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() => useVersionCheck());
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(result.current.updateInfo).toBeNull();
    warnSpy.mockRestore();
  });

  it("refresh() re-invokes check_for_update", async () => {
    invokeMock.mockResolvedValueOnce(sampleInfo);
    const { result } = renderHook(() => useVersionCheck());
    await waitFor(() => expect(result.current.updateInfo).toEqual(sampleInfo));

    const refreshed: UpdateInfo = { ...sampleInfo, latest: "2.2.0" };
    invokeMock.mockResolvedValueOnce(refreshed);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.updateInfo).toEqual(refreshed);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/hooks/useVersionCheck.test.tsx`
Expected: fails with "Cannot find module './useVersionCheck'".

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useVersionCheck.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { tauriInvoke } from "../lib/tauri";
import type { UpdateInfo } from "../types";

export function useVersionCheck(): {
  updateInfo: UpdateInfo | null;
  refresh: () => Promise<void>;
} {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const didInitialCheckRef = useRef(false);

  const check = useCallback(async () => {
    try {
      const info = await tauriInvoke<UpdateInfo>("check_for_update");
      setUpdateInfo(info);
    } catch (err) {
      console.warn("check_for_update failed", err);
      setUpdateInfo(null);
    }
  }, []);

  useEffect(() => {
    if (didInitialCheckRef.current) return;
    didInitialCheckRef.current = true;
    void check();
  }, [check]);

  return { updateInfo, refresh: check };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/hooks/useVersionCheck.test.tsx`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useVersionCheck.ts src/hooks/useVersionCheck.test.tsx
git commit -m "feat(hooks): add useVersionCheck"
```

---

## Task 8: `NewVersionPage` component (TDD)

**Files:**
- Create: `src/pages/NewVersionPage/index.tsx`
- Create: `src/pages/NewVersionPage/index.test.tsx`

- [ ] **Step 1: Write the failing test first**

Create `src/pages/NewVersionPage/index.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UpdateInfo } from "../../types";
import { NewVersionPage } from "./index";

const info: UpdateInfo = {
  current: "2.0.2",
  latest: "2.1.0",
  is_newer: true,
  html_url: "https://github.com/chakveselchak/big_echo/releases/tag/v2.1.0",
  body: "## What is new\n\n- Feature A\n- Feature B",
  name: "v2.1.0",
  published_at: "2026-04-20T00:00:00Z",
};

describe("NewVersionPage", () => {
  it("renders headline with latest and current versions", () => {
    render(<NewVersionPage updateInfo={info} />);
    expect(screen.getByText(/New version 2\.1\.0 available/i)).toBeInTheDocument();
    expect(screen.getByText(/You are on 2\.0\.2/i)).toBeInTheDocument();
  });

  it("renders markdown body headings and list items", () => {
    render(<NewVersionPage updateInfo={info} />);
    expect(screen.getByRole("heading", { name: /What is new/i })).toBeInTheDocument();
    expect(screen.getByText(/Feature A/)).toBeInTheDocument();
    expect(screen.getByText(/Feature B/)).toBeInTheDocument();
  });

  it("renders an external link to the release page", () => {
    render(<NewVersionPage updateInfo={info} />);
    const link = screen.getByRole("link", { name: /View on GitHub/i });
    expect(link).toHaveAttribute("href", info.html_url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/pages/NewVersionPage/index.test.tsx`
Expected: fails with "Cannot find module './index'" (or similar).

- [ ] **Step 3: Implement the page**

Create `src/pages/NewVersionPage/index.tsx`:

```tsx
import { Button, Space, Typography } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UpdateInfo } from "../../types";

type Props = {
  updateInfo: UpdateInfo;
};

function formatPublishedAt(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString();
}

export function NewVersionPage({ updateInfo }: Props) {
  const published = formatPublishedAt(updateInfo.published_at);

  return (
    <div style={{ padding: 20, overflowY: "auto" }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        New version {updateInfo.latest} available
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        You are on {updateInfo.current}
        {published ? ` · Released ${published}` : ""}
      </Typography.Paragraph>

      <div className="release-notes">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...rest }) => (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            ),
          }}
        >
          {updateInfo.body || "_No release notes provided._"}
        </ReactMarkdown>
      </div>

      <Space style={{ marginTop: 16 }}>
        <Button type="primary">
          <a
            href={updateInfo.html_url}
            target="_blank"
            rel="noreferrer"
            style={{ color: "inherit" }}
          >
            View on GitHub
          </a>
        </Button>
      </Space>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/pages/NewVersionPage/index.test.tsx`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pages/NewVersionPage
git commit -m "feat(pages): add NewVersionPage with markdown release notes"
```

---

## Task 9: Integrate the "New version" tab into `MainPage`

**Files:**
- Modify: `src/pages/MainPage/index.tsx`
- Modify: `src/App.main.test.tsx` (add stub for `check_for_update` so existing tests keep passing)

- [ ] **Step 1: Update the `invokeMock` in `App.main.test.tsx` to not crash on the new command**

Open `src/App.main.test.tsx`. Find the `invokeMock` definition (around line 9) and add a branch for `check_for_update` before the final `return null;`:

```ts
    if (cmd === "check_for_update") {
      return null;
    }
```

This makes the mock resolve with `null`, which our hook swallows into `updateInfo = null`, keeping existing tests unaffected.

Run existing tests to confirm no regressions yet:

Run: `npx vitest run src/App.main.test.tsx`
Expected: existing tests still pass (hook call will resolve to null, tab stays hidden).

- [ ] **Step 2: Modify `MainPage` — add hook + tab**

Edit `src/pages/MainPage/index.tsx`:

a) Add imports at the top (after the existing imports):

```ts
import { useVersionCheck } from "../../hooks/useVersionCheck";
import { NewVersionPage } from "../NewVersionPage";
```

b) Change the `MainTab` type:

```ts
type MainTab = "sessions" | "settings" | "new-version";
```

c) Inside `MainPage()`, right after the existing `useState` calls (before `const sessionSearchInputRef`), call the hook:

```ts
  const { updateInfo } = useVersionCheck();
  const showNewVersionTab = updateInfo?.is_newer === true;
```

d) Inside the `.main-tabs` `<div>` (after the "Settings" button), append a third tab button that renders only when `showNewVersionTab`:

```tsx
        {showNewVersionTab && (
          <button
            type="button"
            role="tab"
            className={`main-tab-button${mainTab === "new-version" ? " is-active" : ""}`}
            aria-selected={mainTab === "new-version"}
            onClick={() => handleTabSelect("new-version")}
          >
            New version
          </button>
        )}
```

e) Below the existing Settings `<section>` (right before the closing `</main>`), add the NewVersion panel:

```tsx
      {showNewVersionTab && updateInfo && (
        <section
          className="panel"
          style={mainTab === "new-version" ? undefined : { display: "none" }}
        >
          <NewVersionPage updateInfo={updateInfo} />
        </section>
      )}
```

(`handleTabSelect` already accepts `MainTab`; its body only does extra work for `"settings"`, so no change needed.)

- [ ] **Step 3: Add a MainPage test for the new tab**

Append this test inside the existing `describe("App main window", ...)` block in `src/App.main.test.tsx` (the `App` component is already imported at the top of the file; reuse it):

```tsx
  it("shows the New version tab when check_for_update reports a newer release", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "check_for_update") {
        return {
          current: "2.0.2",
          latest: "2.1.0",
          is_newer: true,
          html_url: "https://example.com/release",
          body: "## Notes\n- a",
          name: "v2.1.0",
          published_at: "2026-04-20T00:00:00Z",
        };
      }
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "list_sessions") return [];
      if (cmd === "get_settings") return null;
      return null;
    });

    render(<App />);

    const newVersionTab = await screen.findByRole("tab", { name: /New version/i });
    expect(newVersionTab).toBeInTheDocument();

    await user.click(newVersionTab);
    expect(await screen.findByText(/New version 2\.1\.0 available/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on GitHub/i })).toHaveAttribute(
      "href",
      "https://example.com/release"
    );
  });
```

After this test, reset the mock so it doesn't leak into the next test: add `invokeMock.mockReset();` to the `afterEach` if one exists, or call `invokeMock.mockImplementation(...)` explicitly at the top of any subsequent test that relies on the default behavior. Inspect the file's existing teardown before wiring this.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/App.main.test.tsx`
Expected: all tests pass, including the new one.

- [ ] **Step 5: Run the full frontend suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no TS errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/pages/MainPage/index.tsx src/App.main.test.tsx
git commit -m "feat(main): show New version tab when a newer release is available"
```

---

## Task 10: End-to-end smoke (manual)

- [ ] **Step 1: Run the dev app**

Run: `npm run tauri dev`

- [ ] **Step 2: Verify behavior by overriding the current version**

Edit `src-tauri/tauri.conf.json` temporarily: change `"version": "2.0.2"` to `"version": "0.0.1"`. Save — the dev build will restart.

- [ ] **Step 3: Confirm the tab appears**

In the main window, a "New version" tab should appear to the right of "Settings". Clicking it shows the release headline, markdown body, and a "View on GitHub" link that opens the release page in your browser.

- [ ] **Step 4: Restore the version and commit**

Revert the `tauri.conf.json` change:
Run: `git checkout -- src-tauri/tauri.conf.json`

Expected: no diff left. Nothing to commit.

---

## Final verification checklist

- [ ] `cd src-tauri && cargo test` — passes.
- [ ] `npx tsc --noEmit` — no errors.
- [ ] `npx vitest run` — all tests pass.
- [ ] Manual smoke in Task 10 showed the tab and the release notes render.
