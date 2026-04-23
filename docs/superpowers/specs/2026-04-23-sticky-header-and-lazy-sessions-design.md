# Sticky header and lazy session list — design

## Goals

1. **Sticky top:** Main tab strip (`Sessions / Settings / 🔥 New version`) and the entire `SessionFilters` toolbar (label + `Загрузить аудио` + `Refresh` + search input) stay pinned to the top of the viewport while the session cards scroll underneath.
2. **Lazy load:** On the Sessions tab, render only the most recent 20 cards initially. Append 40 more as the user scrolls toward the bottom. Search must continue to operate against **all** sessions (metadata + artifact text) exactly as today.

## Non-goals

- No virtualization of the cards grid (`react-window` etc.).
- No backend changes to `list_sessions` or `search_session_artifacts`.
- No UI controls for page size, no "Show more" button — only infinite scroll.
- No persistent `visibleCount` across mounts.
- No backdrop blur / shadow-on-scroll polish for the sticky header (can be a follow-up).

## Section 1 — Sticky header

### DOM restructure (`src/pages/MainPage/index.tsx`)

Today:

```tsx
<main class="app-shell mac-window mac-content">
  <div class="main-tabs">…</div>
  <section class="panel">                 ← Sessions panel
    <SessionFilters …/>
    <SessionList …/>
  </section>
  <section class="panel" hidden>SettingsPage</section>
  <section class="panel" hidden>NewVersionPage</section>
</main>
```

After:

```tsx
<main class="app-shell mac-window mac-content">
  <div class="main-sticky-header">        ← position: sticky; top: 0
    <div class="main-tabs">…</div>
    {mainTab === "sessions" && <SessionFilters …/>}
  </div>
  <section class="panel">                 ← Sessions panel: only <SessionList>
    <SessionList …/>
  </section>
  <section class="panel" hidden>SettingsPage</section>
  <section class="panel" hidden>NewVersionPage</section>
</main>
```

Why a single sticky wrapper (instead of two independent sticky elements with manually-tuned `top` values): tab-strip height is variable (line wraps on narrow windows, font sizing). One wrapper means we never have to pin the toolbar at `top: <tabs-height>`.

### CSS (`src/index.css`)

New rule:

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
```

Override on `.app-shell` to make sticky actually pin against the viewport:

```css
.app-shell.mac-content {
  /* `mac-window` sets `overflow: hidden`, which establishes a non-scrolling
     scroll container and breaks `position: sticky` for descendants. `clip`
     visually clips the same way (rounded corners preserved) but does NOT
     create a scroll container, so sticky propagates to the viewport. */
  overflow: clip;
}
```

Browser support for `overflow: clip`: Chromium 90+, WebKit 16+ — fine for Tauri WebView on macOS / WebView2 on Windows.

The narrow-screen `@media (max-width: 700px)` block already has `.app-shell { padding: 12px 8px 18px; }`. Mirror the padding compensation in that breakpoint:

```css
@media (max-width: 700px) {
  .main-sticky-header {
    padding-top: 12px;
    margin-top: -12px;
  }
}
```

### What we don't change

- Tray, settings, new-version windows — untouched.
- `mac-window` rule is left as-is; only `.app-shell.mac-content` is overridden.
- No JS measuring of header height — sticky handles it natively.

## Section 2 — Lazy load with infinite scroll

### State and slicing (`src/components/sessions/SessionList.tsx`)

```ts
const INITIAL_VISIBLE = 20;
const PAGE_SIZE = 40;

const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

const isSearchActive = sessionSearchQuery.trim().length > 0;
const displayedSessions = isSearchActive
  ? filteredSessions
  : filteredSessions.slice(0, visibleCount);
```

### Sentinel + IntersectionObserver

Render a sentinel after the cards grid only when there is more to load:

```tsx
<div className="sessions-grid">
  {displayedSessions.map(item => <SessionCard … />)}
</div>
{!isSearchActive && visibleCount < filteredSessions.length && (
  <div ref={sentinelRef} className="sessions-load-sentinel" aria-hidden />
)}
```

Effect:

```ts
useEffect(() => {
  if (isSearchActive) return;
  if (visibleCount >= filteredSessions.length) return;
  const node = sentinelRef.current;
  if (!node) return;
  const obs = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        setVisibleCount((c) => Math.min(c + PAGE_SIZE, filteredSessions.length));
      }
    },
    { rootMargin: "300px" }
  );
  obs.observe(node);
  return () => obs.disconnect();
}, [isSearchActive, visibleCount, filteredSessions.length]);
```

`rootMargin: "300px"` makes the observer fire ~300px before the sentinel enters the viewport, so the next batch is appended before the user notices a pause. If the first 20 don't fill a tall window, the sentinel stays in the extended viewport and the observer fires again after each `setVisibleCount` until the viewport is filled.

### Reset / clamp rules

| Event | Behavior |
|---|---|
| Search query becomes non-empty | Render `filteredSessions` in full; sentinel not rendered. |
| Search query clears | Keep `visibleCount` as-is (don't yank the user back to top). |
| Session deleted (`filteredSessions.length` shrinks) | `slice` naturally caps; no explicit reset needed. |
| New session added (recording finishes) | Appears at top of `sessions`; `visibleCount` unchanged; new card immediately visible. |
| User switches away from Sessions tab and back | Don't reset `visibleCount` — preserves scroll context. |

### Search behavior — unchanged

- Client-side metadata filter operates on the full `sessions` array via the existing `useMemo` in `useSessions`.
- Backend `search_session_artifacts` IPC continues to scan all sessions.
- `isSearching` `LoadingPlaceholder` keeps its current behavior.

### Edge cases

- `filteredSessions.length <= visibleCount` → sentinel not rendered, observer not subscribed.
- `isSearchActive` → sentinel not rendered, observer not subscribed.
- `isInitialLoading` → existing loader, no sentinel work.

## Files touched

- `src/pages/MainPage/index.tsx` — DOM restructure: sticky wrapper, hoist `SessionFilters`.
- `src/index.css` — `.main-sticky-header` rule, `.app-shell.mac-content { overflow: clip; }`, narrow-screen padding override.
- `src/components/sessions/SessionList.tsx` — `visibleCount` state, `displayedSessions`, sentinel + IntersectionObserver effect.

## Verification

- Manual: scroll cards in app — tabs + toolbar stay pinned. Type query — sentinel disappears, all matches render. Clear query — pagination resumes. Delete a card — list compacts cleanly. Record a new session — new card at top, infinite scroll still works.
- Existing tests: `App.main.test.tsx` exercises MainPage; SessionList tests if any. Update assertions where DOM moved (e.g. SessionFilters no longer inside `.panel`).
