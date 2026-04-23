# Sticky header + lazy session list — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the main tab strip and the entire `SessionFilters` toolbar to the top of the viewport while session cards scroll underneath, and render only the most recent 20 sessions initially with infinite-scroll batches of 40 — search continues to operate over all sessions exactly as today.

**Architecture:** Two surgical changes. (1) Restructure `MainPage` so tabs and `SessionFilters` live inside a single `position: sticky` wrapper; override `.app-shell.mac-content` to use `overflow: clip` (instead of `overflow: hidden` from `.mac-window`) so sticky pins to the viewport. (2) Add `visibleCount` state in `SessionList` that slices `filteredSessions`; an `IntersectionObserver` on a sentinel after the cards grid increments the count by 40; while the search query is non-empty, slicing is bypassed and all matches render.

**Tech Stack:** React 18, TypeScript, Vite, Vitest + jsdom + React Testing Library, antd 5, Tauri 2 WebView (Chromium 90+ / WebKit 16+ — `overflow: clip` and `IntersectionObserver` both supported).

**Spec:** `docs/superpowers/specs/2026-04-23-sticky-header-and-lazy-sessions-design.md`

---

## File map

| File | Change |
|---|---|
| `src/pages/MainPage/index.tsx` | Wrap `.main-tabs` + `<SessionFilters>` in a single `<div class="main-sticky-header">`; remove `<SessionFilters>` from inside the Sessions `.panel`. |
| `src/index.css` | Add `.main-sticky-header` rule; add `.app-shell.mac-content { overflow: clip; }` override; add narrow-screen padding override. |
| `src/components/sessions/SessionList.tsx` | Add `INITIAL_VISIBLE = 20` and `PAGE_SIZE = 40` constants, `visibleCount` state, `displayedSessions` slicing, sentinel `<div>` and `IntersectionObserver` effect. |
| `src/components/sessions/SessionList.test.tsx` | **New file** — focused unit tests for visible-count slicing, infinite-scroll trigger, and search-disables-pagination behavior. |

---

## Task 1: Sticky header — DOM restructure + CSS

**Files:**
- Modify: `src/pages/MainPage/index.tsx`
- Modify: `src/index.css`
- Run: `src/App.main.test.tsx` (existing — no edits expected, but verify still green)

- [ ] **Step 1: Restructure `MainPage` JSX**

In `src/pages/MainPage/index.tsx`, replace the JSX inside `<main className="app-shell mac-window mac-content" ref={appMainRef}>` so that the tab strip and `<SessionFilters>` are siblings inside a new sticky wrapper, and the Sessions `.panel` no longer contains `<SessionFilters>`:

```tsx
return (
  <main className="app-shell mac-window mac-content" ref={appMainRef}>
    <div className="main-sticky-header">
      <div className="main-tabs" role="tablist" aria-label="Main sections">
        <button
          type="button"
          role="tab"
          className={`main-tab-button${mainTab === "sessions" ? " is-active" : ""}`}
          aria-selected={mainTab === "sessions"}
          onClick={() => handleTabSelect("sessions")}
        >
          Sessions
        </button>
        <button
          type="button"
          role="tab"
          className={`main-tab-button${mainTab === "settings" ? " is-active" : ""}`}
          aria-selected={mainTab === "settings"}
          onClick={() => handleTabSelect("settings")}
        >
          Settings
        </button>
        {showNewVersionTab && (
          <button
            type="button"
            role="tab"
            className={`main-tab-button${mainTab === "new-version" ? " is-active" : ""}`}
            aria-selected={mainTab === "new-version"}
            onClick={() => handleTabSelect("new-version")}
          >
            🔥 New version
          </button>
        )}
      </div>
      {mainTab === "sessions" && (
        <SessionFilters
          ref={sessionSearchInputRef}
          searchQuery={sessionSearchQuery}
          onSearchChange={setSessionSearchQuery}
          onImportAudio={() => void importAudioSession()}
          onRefresh={() => {
            setRefreshKey((k) => k + 1);
            void loadSessions();
          }}
          refreshKey={refreshKey}
        />
      )}
    </div>

    <section
      className="panel"
      style={mainTab === "sessions" ? undefined : { display: "none" }}
    >
      <SessionList
        sessions={sessions}
        filteredSessions={filteredSessions}
        sessionDetails={sessionDetails}
        setSessionDetails={setSessionDetails}
        sessionSearchQuery={sessionSearchQuery}
        sessionArtifactSearchHits={sessionArtifactSearchHits}
        textPendingBySession={textPendingBySession}
        summaryPendingBySession={summaryPendingBySession}
        pipelineStateBySession={pipelineStateBySession}
        deleteTarget={deleteTarget}
        deletePendingSessionId={deletePendingSessionId}
        audioDeleteTargetSessionId={audioDeleteTargetSessionId}
        audioDeletePendingSessionId={audioDeletePendingSessionId}
        isSearching={isSearching}
        isInitialLoading={isInitialLoading}
        artifactPreview={artifactPreview}
        knownTags={knownTags}
        settings={null}
        setDeleteTarget={setDeleteTarget}
        setAudioDeleteTargetSessionId={setAudioDeleteTargetSessionId}
        confirmDeleteSession={async () => {
          await confirmDeleteSession();
          sessionSearchInputRef.current?.input?.focus();
        }}
        confirmDeleteAudio={confirmDeleteAudio}
        closeArtifactPreview={closeArtifactPreview}
        openSessionFolder={openSessionFolder}
        openSessionArtifact={openSessionArtifact}
        getText={getText}
        getSummary={getSummary}
        saveSessionDetails={saveSessionDetails}
        flushSessionDetails={flushSessionDetails}
        requestDeleteSession={requestDeleteSession}
        requestDeleteAudio={requestDeleteAudio}
        setStatus={setStatus}
      />
    </section>

    {settingsMounted && (
      <section
        className="panel"
        style={mainTab === "settings" ? undefined : { display: "none" }}
      >
        <SettingsPage />
      </section>
    )}
    {showNewVersionTab && updateInfo && (
      <section
        className="panel"
        style={mainTab === "new-version" ? undefined : { display: "none" }}
      >
        <NewVersionPage updateInfo={updateInfo} />
      </section>
    )}
  </main>
);
```

Key changes vs. today:
- A new `<div className="main-sticky-header">` wraps the existing `<div className="main-tabs">` and a conditional `<SessionFilters>`.
- The Sessions `<section className="panel">` no longer contains `<SessionFilters>` — only `<SessionList>`.
- Settings and New Version sections are unchanged.
- `<SessionFilters>` is rendered only when `mainTab === "sessions"`, so the sticky header doesn't show search controls on other tabs.

- [ ] **Step 2: Add CSS rules in `src/index.css`**

Locate the existing `.main-tabs` rule (around line 258). Immediately **before** it, add the sticky wrapper:

```css
.main-sticky-header {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--surface);
  display: grid;
  gap: 14px;
  /* Cover the .app-shell top padding so cards don't peek above the header
     during scroll. */
  padding-top: 18px;
  margin-top: -18px;
}

.app-shell.mac-content {
  /* `mac-window` sets `overflow: hidden`, which establishes a non-scrolling
     scroll container and breaks `position: sticky` for descendants. `clip`
     visually clips the same way (rounded corners preserved) but does NOT
     create a scroll container, so sticky propagates to the viewport. */
  overflow: clip;
}
```

Then locate the existing `@media (max-width: 700px)` block (around line 1708) and add inside it, near the other narrow-screen overrides:

```css
  .main-sticky-header {
    padding-top: 12px;
    margin-top: -12px;
  }
```

(Mirrors the `.app-shell { padding: 12px 8px 18px; }` override already present in that media query.)

- [ ] **Step 3: Run the existing test suite to confirm nothing regressed**

Run: `npm test -- src/App.main.test.tsx`
Expected: all tests pass. The DOM restructure preserves all roles, labels, classes, and refs that the test queries (`role="tablist"`, `aria-selected`, `.session-toolbar-search`, etc. — see line 719 in `App.main.test.tsx` for the existing toolbar selector usage).

If any test fails because it relied on `<SessionFilters>` being inside the sessions `.panel`, update the assertion to find it via its existing selectors (`role="searchbox"`, the `.session-toolbar-search` class, etc.) — these are not parent-coupled.

- [ ] **Step 4: Manual verification (the harness can't test sticky positioning)**

Start the dev server: `npm run dev` (or run via Tauri if needed: `npm run tauri dev`).

Then in the running app:
1. Open the Sessions tab.
2. Scroll down the cards list — the tab strip and the entire toolbar (label + Загрузить аудио + Refresh + search input) must stay visible at the top of the window.
3. Click the search input while scrolled — focus should land in the input without jumping.
4. Switch to Settings — the toolbar is gone (only tabs remain pinned). Switch back to Sessions — toolbar reappears in the sticky header.
5. Resize the window narrower than 700px — sticky still works; padding compensation hides any peek-through.

If sticky is not pinning, double-check that `.app-shell.mac-content { overflow: clip; }` is present and that no closer ancestor has `overflow: hidden`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/MainPage/index.tsx src/index.css
git commit -m "$(cat <<'EOF'
feat(ui): pin main tabs and session toolbar to top via sticky wrapper

Wrap .main-tabs and SessionFilters in a single sticky container so both
remain visible while the cards list scrolls underneath. Override
.app-shell overflow to `clip` so sticky propagates to the viewport
instead of binding to the non-scrolling .mac-window container.
EOF
)"
```

---

## Task 2: Lazy load — slice to first 20 cards

**Files:**
- Create: `src/components/sessions/SessionList.test.tsx`
- Modify: `src/components/sessions/SessionList.tsx`

- [ ] **Step 1: Create the test file with a failing assertion that only 20 of 25 sessions render**

Create `src/components/sessions/SessionList.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { SessionList } from "./SessionList";
import type { SessionListItem } from "../../types";

vi.mock("./SessionCard", () => ({
  SessionCard: ({ item }: { item: SessionListItem }) => (
    <div data-testid="session-card" data-session-id={item.session_id} />
  ),
}));

vi.mock("./DeleteConfirmModal", () => ({
  DeleteConfirmModal: () => null,
}));

vi.mock("./ArtifactModal", () => ({
  ArtifactModal: () => null,
}));

vi.mock("./SummaryPromptModal", () => ({
  SummaryPromptModal: () => null,
}));

type IOInstance = {
  cb: IntersectionObserverCallback;
  opts?: IntersectionObserverInit;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

const ioInstances: IOInstance[] = [];

class MockIntersectionObserver {
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    const inst: IOInstance = {
      cb,
      opts,
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
    ioInstances.push(inst);
    Object.assign(this, inst);
  }
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}

beforeEach(() => {
  ioInstances.length = 0;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeSession(i: number): SessionListItem {
  return {
    session_id: `s-${i}`,
    status: "done",
    primary_tag: "slack",
    topic: `Topic ${i}`,
    display_date_ru: "01.01.2026",
    started_at_iso: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    session_dir: `/tmp/s-${i}`,
    audio_file: "",
    audio_format: "unknown",
    audio_duration_hms: "00:00:00",
    has_transcript_text: false,
    has_summary_text: false,
  };
}

function renderList(
  sessions: SessionListItem[],
  overrides: Partial<ComponentProps<typeof SessionList>> = {},
) {
  const noop = () => undefined;
  const noopAsync = async () => undefined;
  const props: ComponentProps<typeof SessionList> = {
    sessions,
    filteredSessions: sessions,
    sessionDetails: {},
    setSessionDetails: noop,
    sessionSearchQuery: "",
    sessionArtifactSearchHits: {},
    textPendingBySession: {},
    summaryPendingBySession: {},
    pipelineStateBySession: {},
    deleteTarget: null,
    deletePendingSessionId: null,
    audioDeleteTargetSessionId: null,
    audioDeletePendingSessionId: null,
    isSearching: false,
    isInitialLoading: false,
    artifactPreview: null,
    knownTags: [],
    settings: null,
    setDeleteTarget: noop,
    setAudioDeleteTargetSessionId: noop,
    confirmDeleteSession: noopAsync,
    confirmDeleteAudio: noopAsync,
    closeArtifactPreview: noop,
    openSessionFolder: noop,
    openSessionArtifact: noop,
    getText: noop,
    getSummary: noop,
    saveSessionDetails: async () => true,
    flushSessionDetails: noop,
    requestDeleteSession: noop,
    requestDeleteAudio: noop,
    setStatus: noop,
    ...overrides,
  };
  return render(<SessionList {...props} />);
}

describe("SessionList lazy loading", () => {
  it("renders only the first 20 cards when there are more than 20 sessions", () => {
    const sessions = Array.from({ length: 25 }, (_, i) => makeSession(i));
    renderList(sessions);
    expect(screen.getAllByTestId("session-card")).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run the new test to confirm it fails**

Run: `npm test -- src/components/sessions/SessionList.test.tsx`
Expected: FAIL — current implementation renders all 25 cards, so `toHaveLength(20)` fails with `Expected length: 20 / Received length: 25`.

- [ ] **Step 3: Add `visibleCount` state and slicing in `SessionList.tsx`**

In `src/components/sessions/SessionList.tsx`:

a) Add module-level constants near the top of the file (after the imports):

```tsx
const INITIAL_VISIBLE = 20;
```

b) Inside the `SessionList` function, near the other `useState` calls (around the existing `useState<SummaryPromptDialogState | null>(null)`), add:

```tsx
const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
```

c) Right before the `return (` statement (after `const sessionContextMenuItems = ...`), compute the displayed slice:

```tsx
const isSearchActive = sessionSearchQuery.trim().length > 0;
const displayedSessions = isSearchActive
  ? filteredSessions
  : filteredSessions.slice(0, visibleCount);
```

d) Replace `filteredSessions.map((item) => {` (inside `<div className="sessions-grid">`) with `displayedSessions.map((item) => {`.

e) Replace the empty-state condition `{!filteredSessions.length && (` with `{!displayedSessions.length && (` so the empty state still appears correctly when filtering produces zero results.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm test -- src/components/sessions/SessionList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sessions/SessionList.tsx src/components/sessions/SessionList.test.tsx
git commit -m "$(cat <<'EOF'
perf(sessions): cap initial render at 20 cards

Add visibleCount state to SessionList and slice filteredSessions before
rendering. Search remains over the full set; pagination is bypassed when
the query is non-empty (next task wires the infinite-scroll trigger).
EOF
)"
```

---

## Task 3: Lazy load — infinite scroll via IntersectionObserver

**Files:**
- Modify: `src/components/sessions/SessionList.test.tsx`
- Modify: `src/components/sessions/SessionList.tsx`

- [ ] **Step 1: Add a failing test for the IntersectionObserver trigger**

Append to the existing `describe("SessionList lazy loading", () => { ... })` block in `src/components/sessions/SessionList.test.tsx`:

```tsx
  it("loads 40 more cards when the sentinel intersects the viewport", () => {
    const sessions = Array.from({ length: 100 }, (_, i) => makeSession(i));
    renderList(sessions);
    expect(screen.getAllByTestId("session-card")).toHaveLength(20);
    expect(ioInstances).toHaveLength(1);

    act(() => {
      ioInstances[0].cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        ioInstances[0] as unknown as IntersectionObserver,
      );
    });

    expect(screen.getAllByTestId("session-card")).toHaveLength(60);
  });

  it("clamps the next batch to filteredSessions.length", () => {
    const sessions = Array.from({ length: 25 }, (_, i) => makeSession(i));
    renderList(sessions);
    expect(screen.getAllByTestId("session-card")).toHaveLength(20);

    act(() => {
      ioInstances[0].cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        ioInstances[0] as unknown as IntersectionObserver,
      );
    });

    expect(screen.getAllByTestId("session-card")).toHaveLength(25);
  });
```

Add `act` to the existing import line at the top of the file:

```tsx
import { act, render, screen } from "@testing-library/react";
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm test -- src/components/sessions/SessionList.test.tsx`
Expected: FAIL — `ioInstances` stays empty (no observer is created yet) and the second assertion finds only 20 cards.

- [ ] **Step 3: Implement the sentinel + IntersectionObserver effect**

In `src/components/sessions/SessionList.tsx`:

a) Add `PAGE_SIZE` next to the existing `INITIAL_VISIBLE` constant:

```tsx
const INITIAL_VISIBLE = 20;
const PAGE_SIZE = 40;
```

b) Inside the component, declare a ref for the sentinel near the existing `useRef` calls:

```tsx
const sentinelRef = useRef<HTMLDivElement | null>(null);
```

c) After the existing `useEffect` blocks (the context-menu `useEffect` is the last one), add a new effect:

```tsx
useEffect(() => {
  if (isSearchActive) return;
  if (visibleCount >= filteredSessions.length) return;
  const node = sentinelRef.current;
  if (!node) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        setVisibleCount((current) =>
          Math.min(current + PAGE_SIZE, filteredSessions.length),
        );
      }
    },
    { rootMargin: "300px" },
  );
  observer.observe(node);
  return () => observer.disconnect();
}, [isSearchActive, visibleCount, filteredSessions.length]);
```

(Note: `isSearchActive` is computed before `return` — this effect references it. That's fine because effects run after render and the value is stable for that render.)

d) Render the sentinel inside the `sessions-grid` block, immediately after the closing `</div>` of `<div className="sessions-grid">` but before the `)` that closes the `isInitialLoading ? ... : (...)` ternary. The current structure is:

```tsx
<div className="sessions-grid">
  {displayedSessions.map(...)}
  {!displayedSessions.length && (
    <div className="sessions-empty-state">...</div>
  )}
</div>
```

Change to:

```tsx
<>
  <div className="sessions-grid">
    {displayedSessions.map(...)}
    {!displayedSessions.length && (
      <div className="sessions-empty-state">...</div>
    )}
  </div>
  {!isSearchActive && visibleCount < filteredSessions.length && (
    <div ref={sentinelRef} className="sessions-load-sentinel" aria-hidden />
  )}
</>
```

(Wrap the existing grid + the new sentinel in a fragment so the surrounding JSX structure stays a single expression.)

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npm test -- src/components/sessions/SessionList.test.tsx`
Expected: PASS — all three lazy-loading tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/sessions/SessionList.tsx src/components/sessions/SessionList.test.tsx
git commit -m "$(cat <<'EOF'
feat(sessions): infinite scroll for session list (40 per batch)

Render a sentinel div after the grid and use IntersectionObserver with a
300px rootMargin to grow visibleCount by 40 each time the sentinel
approaches the viewport. Sentinel and observer are skipped when search
is active or all sessions are already visible.
EOF
)"
```

---

## Task 4: Lock down — search bypasses pagination

**Files:**
- Modify: `src/components/sessions/SessionList.test.tsx`

- [ ] **Step 1: Add a regression test that search renders all results and skips the sentinel**

Append to the same `describe` block in `src/components/sessions/SessionList.test.tsx`:

```tsx
  it("renders all filtered sessions and creates no observer when search is active", () => {
    const sessions = Array.from({ length: 50 }, (_, i) => makeSession(i));
    const filtered = sessions.slice(0, 30);
    renderList(sessions, {
      filteredSessions: filtered,
      sessionSearchQuery: "topic",
    });
    expect(screen.getAllByTestId("session-card")).toHaveLength(30);
    expect(ioInstances).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the test to confirm it passes immediately**

Run: `npm test -- src/components/sessions/SessionList.test.tsx`
Expected: PASS — Task 3's effect guards on `isSearchActive` and the JSX guards on `!isSearchActive`, so this is already correct. The test exists to prevent future regression.

- [ ] **Step 3: Run the full test suite to make sure nothing else broke**

Run: `npm test`
Expected: full green. If any test in `App.main.test.tsx` or elsewhere fails because it now finds fewer rendered cards (e.g. it set up >20 fixtures), update the test fixtures or add the search query to bypass the cap — but the existing `App.main.test.tsx` `list_sessions` mock returns `[]`, so no impact is expected.

- [ ] **Step 4: Commit**

```bash
git add src/components/sessions/SessionList.test.tsx
git commit -m "$(cat <<'EOF'
test(sessions): lock down that active search bypasses lazy-load slicing
EOF
)"
```

---

## Task 5: Final manual verification

**Files:** none

- [ ] **Step 1: Build the app**

Run: `npm run build`
Expected: a clean Vite build with no TypeScript errors.

- [ ] **Step 2: Run the dev server and exercise the full flow**

Run: `npm run dev` (or `npm run tauri dev` if you want the full WebView).

Walk through each of these manually:

1. **Sticky header** — Sessions tab loaded with enough sessions to scroll. Tabs + toolbar stay pinned at the top while cards scroll under them.
2. **Initial 20** — On first paint of Sessions tab (with > 20 sessions present), the page shows exactly 20 cards followed by the sentinel placeholder and a small empty space.
3. **Infinite scroll** — Scrolling toward the bottom loads the next 40 before reaching the very last card. Repeat until all sessions are visible; the sentinel disappears when the count is reached.
4. **Search across all** — Type a query that you know matches a session past index 20. Result appears even though you never scrolled it into the lazy window.
5. **Clear search** — Clearing the input returns the list to the lazy-paged view; `visibleCount` is preserved (you don't snap back to the very top by yanking content out).
6. **Delete a session** — Use the context-menu Delete on a card. The list compacts cleanly and lazy-loading still works.
7. **Record a new session** — Record + stop. The new card appears at the top; lazy-loading state is unaffected.
8. **Switch tabs** — Sessions → Settings → Sessions. Tabs stay sticky on Settings (no toolbar). Returning to Sessions reattaches the toolbar; lazy state is preserved (component is not unmounted because the panel is hidden via `display: none`).

If all eight check out — done.
