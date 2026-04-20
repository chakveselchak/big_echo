# New Version Check — Design Spec

Date: 2026-04-20
Branch: `claude/check_new_version`

## Goal

Check the latest GitHub release of `chakveselchak/big_echo` and notify the user in-app when a newer version exists. When an update is available, a "New version" tab appears to the right of "Settings" in the main navigation. Selecting the tab shows the release notes (markdown body) and a link to the GitHub release page.

## Non-Goals

- No auto-download / auto-install of the update.
- No listing of release assets (artifacts).
- No handling of pre-release or draft releases — only the latest stable release is considered.

## Architecture

### Backend (Rust / Tauri)

New module: `src-tauri/src/commands/updates.rs`.

Exposes one Tauri command:

```rust
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String>
```

**Behavior:**
1. Performs `GET https://api.github.com/repos/chakveselchak/big_echo/releases/latest` via `reqwest` with headers:
   - `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`
   - `Accept: application/vnd.github+json`
2. Parses response, compares `tag_name` (stripped of leading `v`) to `app.package_info().version` using the `semver` crate.
3. On any network/parse error: returns `Err(String)`. No caching — the check runs once per app launch from the frontend side.

**Return type:**

```rust
#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub current: String,       // e.g. "2.0.2"
    pub latest: String,        // e.g. "2.1.0"
    pub is_newer: bool,        // true iff latest > current
    pub html_url: String,      // release page URL
    pub body: String,          // release notes (markdown)
    pub name: String,          // release name (may equal tag)
    pub published_at: String,  // ISO8601 string as returned by GitHub
}
```

**Cargo dependency:** add `semver = "1"` to `src-tauri/Cargo.toml`.

**Registration:** register the command in `src-tauri/src/main.rs` alongside existing invoke handlers.

### Frontend (React)

#### New hook: `src/hooks/useVersionCheck.ts`

```ts
export function useVersionCheck(): {
  updateInfo: UpdateInfo | null;
  refresh: () => Promise<void>;
}
```

**Behavior:**
- On mount: calls `tauriInvoke<UpdateInfo>("check_for_update")` exactly once. On success stores result; on error logs `console.warn` and sets `updateInfo` to `null`.
- No polling / interval — a fresh check happens only on the next app launch.
- `refresh()` returns a promise that re-runs the check on demand (not used by the UI currently, kept as an escape hatch).

Type `UpdateInfo` lives in `src/types/updates.ts` (or extends `src/types/index.ts`).

#### New page: `src/pages/NewVersionPage/index.tsx`

Renders:
- Heading: `"New version {latest} available"` + published date (formatted).
- Subtitle: `"You are on {current}"`.
- `react-markdown` + `remark-gfm` component that renders `updateInfo.body`. Links inside markdown open externally (use `<a target="_blank" rel="noreferrer">` via component override).
- Bottom button/link: "View on GitHub" → opens `updateInfo.html_url` in external browser. Plain `<a target="_blank" rel="noreferrer">` is sufficient.

#### MainPage integration

Modify `src/pages/MainPage/index.tsx`:
- Add `type MainTab = "sessions" | "settings" | "new-version";`
- Call `useVersionCheck()` at the top.
- The "New version" tab button is rendered only when `updateInfo?.is_newer === true`. It appears to the right of "Settings".
- When selected, show `<NewVersionPage updateInfo={updateInfo} />` in a `.panel` section, following the same mount/display pattern used for Settings.

#### npm dependencies

Add to `package.json` dependencies:
- `react-markdown`
- `remark-gfm`

## Data Flow

```
App starts
  → MainPage mounts
    → useVersionCheck() fires check_for_update (once)
      → Rust: fetch GitHub → parse → compare → return.
    → if updateInfo.is_newer: tab becomes visible.
```

A new check happens only when the user restarts the application.

## Error Handling

- Network errors, 4xx/5xx, JSON parse errors: command returns `Err`; frontend logs `console.warn`, keeps `updateInfo = null`, tab stays hidden.
- Invalid semver in `tag_name` or `package_info().version`: treat as "no update" (`is_newer = false`), still return the fetched info so UI can stay consistent.
- Users never see alerts/toasts about failed version checks.

## Testing

**Rust (unit tests in `updates.rs`):**
- Version comparison: `"2.0.2"` vs `"2.1.0"` → newer.
- Version comparison: `"2.0.2"` vs `"2.0.2"` → not newer.
- Version comparison with `v`-prefix: `"v2.1.0"` strips correctly.
- Invalid semver → returns `is_newer = false` without panic.
- JSON parsing from a fixture response.

**Frontend (vitest + RTL):**
- `useVersionCheck`: calls `check_for_update` exactly once on mount; error sets `updateInfo` to null.
- `MainPage`: "New version" tab is absent when hook returns `null`; present when `is_newer = true`; absent when `is_newer = false`.
- `NewVersionPage`: renders markdown body, shows correct versions and link.

## File Layout Summary

New files:
- `src-tauri/src/commands/updates.rs`
- `src/hooks/useVersionCheck.ts`
- `src/pages/NewVersionPage/index.tsx`
- `src/types/updates.ts` (or extend `src/types/index.ts`)

Modified files:
- `src-tauri/Cargo.toml` — add `semver`.
- `src-tauri/src/commands/mod.rs` — expose `updates`.
- `src-tauri/src/main.rs` — register `check_for_update`.
- `src/pages/MainPage/index.tsx` — add third tab, wire up hook.
- `package.json` — add `react-markdown`, `remark-gfm`.

## Open Questions

None. Ready to plan implementation.
