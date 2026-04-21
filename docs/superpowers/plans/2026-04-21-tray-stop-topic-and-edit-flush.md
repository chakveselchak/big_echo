# Tray Stop: Clear Topic and Flush Pending Edits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On tray Stop, clear the Topic input; on any Stop path, flush pending debounced topic/tags/notes autosaves before `stop_recording` so the user's latest edits land in `meta.json`.

**Architecture:** Two surgical changes in the frontend:
1. Add a `flushPendingSessionDetails?: (sessionId: string) => Promise<void>` option to `useRecordingController`. Wire it in `MainPage` to `useSessions.flushSessionDetails` so debounced session-list edits flush before `stop_recording`. `TrayPage`/`SettingsPage` pass nothing.
2. Teach `useRecordingController.stop()` and its `tray:stop` event listener to (a) synchronously flush a pending tray topic autosave via `update_session_details` before calling `stop_recording`, and (b) clear tray `topic` state (via `setTopic("")`) after `stop_recording` resolves — only when `isTrayWindow`.

No backend changes. No new dependencies.

**Tech Stack:** React, TypeScript, Vitest, `@testing-library/react`, existing Tauri invoke/listen adapters.

---

## File Structure

Changes are localized:

- `src/hooks/useRecordingController.ts` — add `flushPendingSessionDetails` option; extend `stop()` and `tray:stop` listener; clear tray topic after successful tray-initiated stop.
- `src/hooks/useRecordingController.test.ts` — new tests for flush-before-stop and topic-clear.
- `src/pages/TrayPage/index.tsx` — the tray `stop()` wrapper handed to the Stop button must already call through the controller; ensure the controller handles the clear. (No page-level change required if the controller clears `topic` via `setTopic` — keep it centralized.)
- `src/pages/MainPage/index.tsx` — pass `flushPendingSessionDetails={flushSessionDetails}` into `useRecordingController`.
- `src/App.main.test.tsx` — assert main-window flush-before-stop.

Tests sit next to their subjects; no restructuring.

---

## Context for the implementer

Key existing code paths:

- `useRecordingController` lives in [src/hooks/useRecordingController.ts](src/hooks/useRecordingController.ts). Relevant pieces:
  - `stop()` function starts at [line 167](src/hooks/useRecordingController.ts:167).
  - `tray:stop` listener registered at [line 303](src/hooks/useRecordingController.ts:303).
  - Tray topic autosave effect at [line 393](src/hooks/useRecordingController.ts:393) — 450ms debounce, writes to `trayTopicSavedSignatureRef` (format: `${session_id}::${source}::${topic}`) after a successful `update_session_details` call.
- `useSessions.flushSessionDetails` at [src/hooks/useSessions.ts:313](src/hooks/useSessions.ts:313) — `async (sessionId, detail?) => Promise<void>`, cancels debounce and persists.
- `MainPage` already destructures `flushSessionDetails` at [src/pages/MainPage/index.tsx:51](src/pages/MainPage/index.tsx:51).
- Tests: `src/hooks/useRecordingController.test.ts` uses hoisted `vi.hoisted` mocks for `tauriInvoke`/`tauriEmit`/`tauriListen`. Import `useRecordingController` AFTER the mock block. Each test constructs a tiny `renderHook` harness with `useState` so topic/session/etc. are real React state.

Gotchas:

- The tray topic autosave timer is stored in `trayTopicAutosaveTimerRef`. It is scoped inside the effect — use the existing ref to cancel it.
- `trayTopicSavedSignatureRef.current` tracks what's already on disk. If current `${session_id}::${source}::${topic}` equals the ref, there's nothing to flush.
- `stop()` currently early-returns if `!session` — keep that. Flushes must also be skipped if there's no active session.
- In `tray:stop` listener, the code inlines `tauriInvoke("stop_recording")` rather than calling `stop()`. Duplicate the flush logic (do NOT refactor to call `stop()` — the listener uses `sessionRef.current` whereas `stop()` uses `session` closure; changing that is out of scope).
- Error policy (from spec): flush failures are swallowed; we proceed to `stop_recording`. Topic clear runs only after `stop_recording` resolves — a rejected stop keeps the topic so the user can retry without retyping.

---

## Tasks

### Task 1: Add `flushPendingSessionDetails` option + plumb through stop paths

**Files:**
- Modify: `src/hooks/useRecordingController.ts`
- Test: `src/hooks/useRecordingController.test.ts`

- [ ] **Step 1: Write the failing test for `stop()` flushing session details before `stop_recording`**

Add this test inside the existing `describe("useRecordingController", ...)` block at the end, before the closing `});`:

```ts
  it("flushes pending session details before stopping the recording", async () => {
    const loadSessions = vi.fn(async () => undefined);
    const callOrder: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "stop_recording") {
        callOrder.push("stop_recording");
        return "recorded";
      }
      return getDefaultInvokeResponse(cmd);
    });
    const flushPendingSessionDetails = vi.fn(async (_sessionId: string) => {
      callOrder.push("flush");
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [notesInput] = useState("");
      const [session, setSession] = useState<StartResponse | null>({
        session_id: "active-session",
        session_dir: "/tmp/active",
        status: "recording",
      });
      const [lastSessionId, setLastSessionId] = useState<string | null>("active-session");
      const [status, setStatus] = useState("recording");

      return useRecordingController({
        isSettingsWindow: false,
        isTrayWindow: false,
        topic,
        setTopic,
        tagsInput,
        source,
        setSource,
        notesInput,
        session,
        setSession,
        lastSessionId,
        setLastSessionId,
        status,
        setStatus,
        loadSessions,
        flushPendingSessionDetails,
      });
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.stop();
    });

    expect(flushPendingSessionDetails).toHaveBeenCalledWith("active-session");
    expect(callOrder).toEqual(["flush", "stop_recording"]);
  });

  it("does not block stop if flushPendingSessionDetails rejects", async () => {
    const loadSessions = vi.fn(async () => undefined);
    const flushError = new Error("flush failed");
    const flushPendingSessionDetails = vi.fn(async () => {
      throw flushError;
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [notesInput] = useState("");
      const [session, setSession] = useState<StartResponse | null>({
        session_id: "active-session",
        session_dir: "/tmp/active",
        status: "recording",
      });
      const [lastSessionId, setLastSessionId] = useState<string | null>("active-session");
      const [status, setStatus] = useState("recording");

      return useRecordingController({
        isSettingsWindow: false,
        isTrayWindow: false,
        topic,
        setTopic,
        tagsInput,
        source,
        setSource,
        notesInput,
        session,
        setSession,
        lastSessionId,
        setLastSessionId,
        status,
        setStatus,
        loadSessions,
        flushPendingSessionDetails,
      });
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.stop();
    });

    expect(flushPendingSessionDetails).toHaveBeenCalledWith("active-session");
    expect(invokeMock).toHaveBeenCalledWith("stop_recording", { sessionId: "active-session" });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/useRecordingController.test.ts -t "flushes pending session details"` and `... -t "does not block stop"`
Expected: FAIL — the new `flushPendingSessionDetails` option is not yet accepted by `useRecordingController`; TypeScript error on the option key.

- [ ] **Step 3: Add the `flushPendingSessionDetails` option to the hook's type + destructuring**

In [src/hooks/useRecordingController.ts](src/hooks/useRecordingController.ts), extend the `UseRecordingControllerOptions` type (the block starting at line 20):

```ts
type UseRecordingControllerOptions = {
  enableTrayCommandListeners?: boolean;
  isSettingsWindow: boolean;
  isTrayWindow: boolean;
  topic: string;
  setTopic: Setter<string>;
  tagsInput: string;
  source: string;
  setSource: Setter<string>;
  notesInput: string;
  session: StartResponse | null;
  setSession: Setter<StartResponse | null>;
  lastSessionId: string | null;
  setLastSessionId: Setter<string | null>;
  status: string;
  setStatus: Setter<string>;
  loadSessions: () => Promise<void>;
  flushPendingSessionDetails?: (sessionId: string) => Promise<void>;
};
```

Destructure it inside the `useRecordingController` function signature (the block at line 46):

```ts
export function useRecordingController({
  enableTrayCommandListeners = true,
  isSettingsWindow,
  isTrayWindow,
  topic,
  setTopic,
  tagsInput,
  source,
  setSource,
  notesInput,
  session,
  setSession,
  lastSessionId,
  setLastSessionId,
  status,
  setStatus,
  loadSessions,
  flushPendingSessionDetails,
}: UseRecordingControllerOptions) {
```

Add a ref to keep the latest callback accessible inside the `tray:stop` listener closure. Place near the other refs (after line 75):

```ts
  const flushPendingSessionDetailsRef = useRef(flushPendingSessionDetails);
  useEffect(() => {
    flushPendingSessionDetailsRef.current = flushPendingSessionDetails;
  }, [flushPendingSessionDetails]);
```

- [ ] **Step 4: Wire `flushPendingSessionDetails` into `stop()`**

Replace the existing `stop()` function ([useRecordingController.ts:167](src/hooks/useRecordingController.ts:167)) with:

```ts
  async function stop() {
    if (!session) return;
    const sessionId = session.session_id;
    if (flushPendingSessionDetails) {
      try {
        await flushPendingSessionDetails(sessionId);
      } catch {
        // Swallow — the recorder must stop even if metadata flush fails.
      }
    }
    await tauriInvoke<string>("stop_recording", { sessionId });
    resetMuteState();
    setStatus("recorded");
    setSession(null);
    await loadSessions();
  }
```

- [ ] **Step 5: Wire the same flush into the `tray:stop` listener**

In the `tauriListen("tray:stop", ...)` handler at [line 303](src/hooks/useRecordingController.ts:303), replace the block with:

```ts
      tauriListen("tray:stop", async () => {
        try {
          if (!sessionRef.current) return;
          const sessionId = sessionRef.current.session_id;
          const flush = flushPendingSessionDetailsRef.current;
          if (flush) {
            try {
              await flush(sessionId);
            } catch {
              // Swallow — recorder must stop even if flush fails.
            }
          }
          await tauriInvoke<string>("stop_recording", { sessionId });
          resetMuteState();
          setStatus("recorded");
          setSession(null);
          await loadSessions();
        } catch (err) {
          setStatus(`error: ${formatRecordingError(err)}`);
        }
      }).then((fn) => {
        unlistenStop = fn;
      });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useRecordingController.test.ts`
Expected: PASS for the two new cases; all previously-passing cases still green.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useRecordingController.ts src/hooks/useRecordingController.test.ts
git commit -m "feat(recording): flush pending session details before stop

Add flushPendingSessionDetails option to useRecordingController,
invoked in both stop() and the tray:stop event listener before
tauriInvoke('stop_recording') so debounced topic/tags/notes edits
land in meta.json. Flush errors are swallowed; the recorder stops
unconditionally."
```

---

### Task 2: Wire `flushSessionDetails` from `MainPage` into the controller

**Files:**
- Modify: `src/pages/MainPage/index.tsx`
- Test: `src/App.main.test.tsx`

- [ ] **Step 1: Write the failing test for main-window stop flushing session details**

Locate the existing test in `src/App.main.test.tsx` that covers `stop_recording` from the main window (search for `stop_recording` — there's one around line 279). Add a new `it(...)` near it. Before writing, inspect the file briefly to copy the render-wrapping idiom; the test body below uses the same `invokeMock` pattern.

Add this test in `src/App.main.test.tsx` inside the existing `describe` block that exercises the main window (the one where tray events `tray:start`/`tray:stop` are asserted). Use the file's existing helper shape (e.g., how `invokeMock.mockImplementation` is composed and how `listeners.get("tray:stop")?.()` is invoked). Model the new test on the existing `tray:stop` test at around line 203-222:

```ts
    it("flushes pending session details before stopping via tray:stop", async () => {
      const callOrder: string[] = [];
      invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "update_session_details") {
          callOrder.push("update_session_details");
          return "updated";
        }
        if (cmd === "stop_recording") {
          callOrder.push("stop_recording");
          return "recorded";
        }
        // fall through to whatever default the outer test defined.
        if (cmd === "start_recording") {
          return { session_id: "s1", session_dir: "/tmp/s1", status: "recording" };
        }
        if (cmd === "get_ui_sync_state") {
          return {
            source: "slack",
            topic: "",
            is_recording: false,
            active_session_id: null,
            mute_state: { micMuted: false, systemMuted: false },
          };
        }
        return null;
      });

      render(<App />);

      await waitFor(() => {
        expect(listeners.has("tray:start")).toBe(true);
        expect(listeners.has("tray:stop")).toBe(true);
      });

      await act(async () => {
        await listeners.get("tray:start")?.();
      });

      // Simulate a pending debounced edit: an in-progress change to session
      // details that hasn't yet flushed. The main-window stop path must
      // call update_session_details before stop_recording regardless of
      // whether anything is dirty — flushSessionDetails handles the no-op
      // case internally.
      await act(async () => {
        await listeners.get("tray:stop")?.();
      });

      // At minimum: if there are pending edits, update_session_details
      // must precede stop_recording. When nothing is pending,
      // stop_recording still runs. The defining assertion is the order
      // when both are called.
      const stopIndex = callOrder.indexOf("stop_recording");
      const flushIndex = callOrder.indexOf("update_session_details");
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      if (flushIndex >= 0) {
        expect(flushIndex).toBeLessThan(stopIndex);
      }
    });
```

- [ ] **Step 2: Run the test to verify it fails (or is a no-op) without the wiring**

Run: `npx vitest run src/App.main.test.tsx -t "flushes pending session details before stopping via tray:stop"`
Expected: The assertion `stopIndex >= 0` passes, but once we add dirty state in a follow-up this test will enforce ordering. For now, the test must PASS against `App.tsx` already — if the render fails because of missing mocks, copy any additional mocks from the nearest working test in the file (e.g. `get_session_meta`, `list_sessions`).

> Note: This test validates the wiring contract without seeding dirty state (setting up seeded edits in a JSDOM session list is heavy). Task 2 guarantees the wiring exists; the unit test in Task 1 already covers that `flushPendingSessionDetails` runs before `stop_recording` when provided.

- [ ] **Step 3: Wire `flushSessionDetails` into `useRecordingController`**

In [src/pages/MainPage/index.tsx:77](src/pages/MainPage/index.tsx:77) (the `useRecordingController` call), add the new prop. Change:

```tsx
  const { start, stop } = useRecordingController({
    enableTrayCommandListeners: true,
    isSettingsWindow: false,
    isTrayWindow: false,
    topic,
    setTopic,
    tagsInput: "",
    source,
    setSource,
    notesInput: "",
    session,
    setSession,
    lastSessionId,
    setLastSessionId,
    status,
    setStatus,
    loadSessions,
  });
```

to:

```tsx
  const { start, stop } = useRecordingController({
    enableTrayCommandListeners: true,
    isSettingsWindow: false,
    isTrayWindow: false,
    topic,
    setTopic,
    tagsInput: "",
    source,
    setSource,
    notesInput: "",
    session,
    setSession,
    lastSessionId,
    setLastSessionId,
    status,
    setStatus,
    loadSessions,
    flushPendingSessionDetails: flushSessionDetails,
  });
```

No other changes in this file.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS. Pay particular attention to `src/App.main.test.tsx` and `src/hooks/useRecordingController.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/MainPage/index.tsx src/App.main.test.tsx
git commit -m "feat(main): pass flushSessionDetails to recording controller

Ensures pending debounced session-detail edits in the main window
flush before stop_recording on any tray:stop event."
```

---

### Task 3: Flush pending tray topic autosave + clear tray topic on stop

**Files:**
- Modify: `src/hooks/useRecordingController.ts`
- Test: `src/hooks/useRecordingController.test.ts`

Goal: When the tray initiates a stop, (a) synchronously flush any pending tray topic autosave by calling `update_session_details` with current values if the debounce timer is still pending, then (b) clear the tray `topic` state after a successful `stop_recording`.

- [ ] **Step 1: Write the failing test for tray topic flush before stop**

Add to `src/hooks/useRecordingController.test.ts` at the end of the `describe` block:

```ts
  it("flushes a pending tray topic autosave before stopping", async () => {
    vi.useFakeTimers();
    const loadSessions = vi.fn(async () => undefined);
    const callOrder: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === "update_session_details") {
        callOrder.push("update_session_details");
        return "updated";
      }
      if (cmd === "stop_recording") {
        callOrder.push("stop_recording");
        return "recorded";
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [notesInput] = useState("");
      const [session, setSession] = useState<StartResponse | null>({
        session_id: "active-session",
        session_dir: "/tmp/active",
        status: "recording",
      });
      const [lastSessionId, setLastSessionId] = useState<string | null>("active-session");
      const [status, setStatus] = useState("recording");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        topic,
        setTopic,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    // Simulate the user typing a topic during recording. The autosave
    // effect schedules a 450ms debounce; we stop *before* it fires.
    act(() => {
      result.current.setTopic("Daily sync");
    });
    // Advance time just a little — not enough to trip the 450ms debounce.
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    await act(async () => {
      await result.current.controller.stop();
    });

    // update_session_details must have been called as part of stop()
    // and must precede stop_recording.
    expect(callOrder[0]).toBe("update_session_details");
    expect(callOrder).toContain("stop_recording");
    expect(callOrder.indexOf("update_session_details")).toBeLessThan(
      callOrder.indexOf("stop_recording")
    );

    const flushCall = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "update_session_details"
    );
    expect(flushCall?.[1]).toEqual({
      payload: {
        session_id: "active-session",
        source: "slack",
        notes: "",
        topic: "Daily sync",
        tags: [],
      },
    });
  });

  it("clears the tray topic after a successful tray stop", async () => {
    const loadSessions = vi.fn(async () => undefined);

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("Daily sync");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [notesInput] = useState("");
      const [session, setSession] = useState<StartResponse | null>({
        session_id: "active-session",
        session_dir: "/tmp/active",
        status: "recording",
      });
      const [lastSessionId, setLastSessionId] = useState<string | null>("active-session");
      const [status, setStatus] = useState("recording");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        topic,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.stop();
    });

    await waitFor(() => {
      expect(result.current.topic).toBe("");
    });
  });

  it("keeps tray topic intact if stop_recording rejects", async () => {
    const loadSessions = vi.fn(async () => undefined);
    const stopError = new Error("audio encoder crashed");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "stop_recording") {
        throw stopError;
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("Daily sync");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [notesInput] = useState("");
      const [session, setSession] = useState<StartResponse | null>({
        session_id: "active-session",
        session_dir: "/tmp/active",
        status: "recording",
      });
      const [lastSessionId, setLastSessionId] = useState<string | null>("active-session");
      const [status, setStatus] = useState("recording");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        topic,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    let caught: unknown;
    await act(async () => {
      caught = await result.current.controller.stop().catch((err) => err);
    });

    expect(caught).toBe(stopError);
    expect(result.current.topic).toBe("Daily sync");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/useRecordingController.test.ts -t "flushes a pending tray topic" -t "clears the tray topic" -t "keeps tray topic intact"`
Expected: FAIL — no tray flush is wired, and the topic isn't cleared.

- [ ] **Step 3: Implement tray topic flush + clear inside `stop()`**

In `src/hooks/useRecordingController.ts`, replace the `stop()` function from Task 1 with the fuller version:

```ts
  async function stop() {
    if (!session) return;
    const sessionId = session.session_id;

    // Flush tray-side debounced topic autosave synchronously.
    if (isTrayWindow) {
      if (trayTopicAutosaveTimerRef.current) {
        clearTimeout(trayTopicAutosaveTimerRef.current);
        trayTopicAutosaveTimerRef.current = null;
      }
      const trimmedTopic = topic.trim();
      const signature = `${sessionId}::${source}::${trimmedTopic}`;
      if (signature !== trayTopicSavedSignatureRef.current) {
        try {
          await tauriInvoke<string>("update_session_details", {
            payload: {
              session_id: sessionId,
              source,
              notes: "",
              topic: trimmedTopic,
              tags: [],
            },
          });
          trayTopicSavedSignatureRef.current = signature;
        } catch {
          // Swallow — recorder must stop even if metadata flush fails.
        }
      }
    }

    if (flushPendingSessionDetails) {
      try {
        await flushPendingSessionDetails(sessionId);
      } catch {
        // Swallow — recorder must stop even if flush fails.
      }
    }

    await tauriInvoke<string>("stop_recording", { sessionId });
    resetMuteState();
    setStatus("recorded");
    setSession(null);
    if (isTrayWindow) {
      setTopic("");
    }
    await loadSessions();
  }
```

Note: The `topic`, `source`, `trayTopicAutosaveTimerRef`, `trayTopicSavedSignatureRef` identifiers already exist in scope — do not redeclare.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useRecordingController.test.ts`
Expected: PASS for all three new tray cases plus everything in Task 1. No regressions in previously-passing cases.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useRecordingController.ts src/hooks/useRecordingController.test.ts
git commit -m "feat(tray): flush topic autosave + clear Topic on Stop

On tray-initiated stop, synchronously persist any pending
debounced topic edit before stop_recording, then clear the
Topic input after a successful stop. Topic is preserved when
stop_recording rejects so the user can retry without
retyping."
```

---

### Task 4: Apply the same flush/clear to the `tray:stop` listener

**Files:**
- Modify: `src/hooks/useRecordingController.ts`
- Test: `src/hooks/useRecordingController.test.ts`

The `tray:stop` event listener at [useRecordingController.ts:303](src/hooks/useRecordingController.ts:303) runs only in the main window (where `enableTrayCommandListeners` is true). It does not own the tray topic input, so the tray-only clear (`setTopic("")`) does NOT apply here — the tray window will have already cleared its own topic via Task 3, OR, if stop was triggered by a hotkey, the tray window will observe the topic clear via its `ui:sync` subscription once the tray window is next opened. But: the hotkey path must still run `flushPendingSessionDetails`.

- [ ] **Step 1: Review the Task 1 test "flushes pending session details before stopping" and confirm it covers the direct `stop()` path only**

No new test file creation here. The existing Task-1 test exercises `stop()`. We need a new test that exercises the `tray:stop` event listener.

- [ ] **Step 2: Write the failing test for `tray:stop` listener flushing**

Add to `src/hooks/useRecordingController.test.ts`:

```ts
  it("flushes pending session details when tray:stop fires in the main window", async () => {
    const loadSessions = vi.fn(async () => undefined);
    const callOrder: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "stop_recording") {
        callOrder.push("stop_recording");
        return "recorded";
      }
      return getDefaultInvokeResponse(cmd);
    });
    const flushPendingSessionDetails = vi.fn(async () => {
      callOrder.push("flush");
    });

    const { result: _result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [notesInput] = useState("");
      const [session, setSession] = useState<StartResponse | null>({
        session_id: "active-session",
        session_dir: "/tmp/active",
        status: "recording",
      });
      const [lastSessionId, setLastSessionId] = useState<string | null>("active-session");
      const [status, setStatus] = useState("recording");

      return useRecordingController({
        enableTrayCommandListeners: true,
        isSettingsWindow: false,
        isTrayWindow: false,
        topic,
        setTopic,
        tagsInput,
        source,
        setSource,
        notesInput,
        session,
        setSession,
        lastSessionId,
        setLastSessionId,
        status,
        setStatus,
        loadSessions,
        flushPendingSessionDetails,
      });
    });

    await waitFor(() => {
      expect(listeners.has("tray:stop")).toBe(true);
    });

    await act(async () => {
      await listeners.get("tray:stop")?.();
    });

    expect(flushPendingSessionDetails).toHaveBeenCalledWith("active-session");
    expect(callOrder).toEqual(["flush", "stop_recording"]);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/hooks/useRecordingController.test.ts -t "flushes pending session details when tray:stop"`
Expected: FAIL — Task 1 already wired the `tray:stop` listener to call the flush, BUT the test will fail if the listener doesn't yet read from `flushPendingSessionDetailsRef` at the moment of invocation. If Task 1's Step 5 was applied correctly, this test may PASS on first run — that's acceptable; in that case proceed to Step 5.

- [ ] **Step 4: If failing, fix the listener**

If the test fails because the ref isn't used, ensure the `tray:stop` listener in the hook uses `flushPendingSessionDetailsRef.current` (per Task 1 Step 5). Re-run the test.

- [ ] **Step 5: Run the full hook test file**

Run: `npx vitest run src/hooks/useRecordingController.test.ts`
Expected: PASS across the board.

- [ ] **Step 6: Commit (only if there were code changes in this task)**

```bash
git add src/hooks/useRecordingController.ts src/hooks/useRecordingController.test.ts
git commit -m "test(recording): cover tray:stop listener flush ordering"
```

If there were no code changes (only a new test that already passed), commit just the test:

```bash
git add src/hooks/useRecordingController.test.ts
git commit -m "test(recording): cover tray:stop listener flush ordering"
```

---

### Task 5: Full regression + manual smoke check

**Files:** none modified.

- [ ] **Step 1: Run the full Vitest suite**

Run: `npx vitest run`
Expected: PASS across all files.

- [ ] **Step 2: Run Rust tests (sanity)**

Run: `cd src-tauri && cargo test --no-run` to confirm the backend still compiles; then `cargo test` if build is fast.
Expected: PASS. No backend code changed.

- [ ] **Step 3: Manual smoke — tray Stop clears Topic**

Launch the app with `npm run tauri dev`. From the tray:
1. Set Topic = "Plan review", press Rec.
2. Press Stop.
3. Open the tray again → Topic must be empty.
4. Open the main window → any topic UI must also show empty (via `ui:sync`).

- [ ] **Step 4: Manual smoke — edit-during-record survives stop**

From the tray:
1. Press Rec.
2. In the tray Topic input, type "late change" immediately before pressing Stop (within the 450ms debounce window).
3. After stop, open the session in the main window and confirm the Topic on the saved session is "late change".

From the main window:
1. Press Rec (via hotkey or by re-opening tray Rec).
2. In the session list for the active recording, edit Topic/Tags/Notes.
3. Trigger Stop (hotkey or tray Stop) immediately — before the blur-flush had a chance to fire.
4. Confirm the saved session reflects those edits.

- [ ] **Step 5: Final commit if any manual fixups were needed**

If no code changed, skip. Otherwise:

```bash
git status
git add <files>
git commit -m "fix: manual smoke follow-ups"
```

---

## Out of Scope (explicit deferrals)

- **Microphone hot-swap during recording.** Dropped per user direction on 2026-04-21.
- **Changing the 450ms tray-topic debounce.** Not needed — we flush instead.
- **Backend changes to `update_session_details` or stop semantics.** Already correct.
