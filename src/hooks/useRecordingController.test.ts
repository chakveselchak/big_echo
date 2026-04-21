import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureAnalyticsEventMock, invokeMock, emitMock, listenMock, listeners } = vi.hoisted(() => ({
  captureAnalyticsEventMock: vi.fn(async () => undefined),
  listeners: new Map<string, (payload?: unknown) => void | Promise<void>>(),
  emitMock: vi.fn(async () => undefined),
  invokeMock: vi.fn(async (cmd: string) => {
    if (cmd === "get_ui_sync_state") {
      return {
        source: "slack",
        topic: "",
        is_recording: false,
        active_session_id: null,
        mute_state: { micMuted: false, systemMuted: false },
      };
    }
    if (cmd === "start_recording") {
      return { session_id: "s1", session_dir: "/tmp/s1", status: "recording" };
    }
    if (cmd === "stop_recording") {
      return "recorded";
    }
    if (cmd === "get_live_input_levels") {
      return { mic: 0.2, system: 0.5 };
    }
    if (cmd === "update_session_details") {
      return "updated";
    }
    if (cmd === "run_pipeline") {
      return "done";
    }
    if (cmd === "set_recording_input_muted") {
      return { micMuted: true, systemMuted: false };
    }
    return null;
  }),
  listenMock: vi.fn(async (event: string, handler: (payload?: unknown) => void | Promise<void>) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));

vi.mock("../lib/tauri", () => ({
  tauriEmit: emitMock,
  tauriInvoke: invokeMock,
  tauriListen: listenMock,
}));

vi.mock("../lib/analytics", () => ({
  captureAnalyticsEvent: captureAnalyticsEventMock,
}));

import { StartResponse } from "../types";
import { shouldAnimateTrayAudio } from "../lib/trayAudio";
import { useRecordingController } from "./useRecordingController";

function getDefaultInvokeResponse(cmd: string) {
  if (cmd === "get_ui_sync_state") {
    return {
      source: "slack",
      topic: "",
      is_recording: false,
      active_session_id: null,
      mute_state: { micMuted: false, systemMuted: false },
    };
  }
  if (cmd === "start_recording") {
    return { session_id: "s1", session_dir: "/tmp/s1", status: "recording" };
  }
  if (cmd === "stop_recording") {
    return "recorded";
  }
  if (cmd === "get_live_input_levels") {
    return { mic: 0.2, system: 0.5 };
  }
  if (cmd === "update_session_details") {
    return "updated";
  }
  if (cmd === "run_pipeline") {
    return "done";
  }
  if (cmd === "set_recording_input_muted") {
    return { micMuted: true, systemMuted: false };
  }
  return null;
}

function setDefaultInvokeMockImplementation() {
  invokeMock.mockImplementation(async (cmd: string) => getDefaultInvokeResponse(cmd));
}

type HarnessOptions = {
  initialTopic?: string;
  initialSource?: string;
  initialSession?: StartResponse | null;
  initialStatus?: string;
  isTrayWindow?: boolean;
  isSettingsWindow?: boolean;
  enableTrayCommandListeners?: boolean;
  loadSessions?: () => Promise<void>;
  flushPendingSessionDetails?: (sessionId: string) => Promise<void>;
};

function renderControllerHarness(opts: HarnessOptions = {}) {
  const loadSessions = opts.loadSessions ?? vi.fn(async () => undefined);
  const initialSession: StartResponse | null =
    opts.initialSession === undefined ? null : opts.initialSession;
  return renderHook(() => {
    const [topic, setTopic] = useState(opts.initialTopic ?? "");
    const [tagsInput] = useState("");
    const [source, setSource] = useState(opts.initialSource ?? "slack");
    const [notesInput] = useState("");
    const [session, setSession] = useState<StartResponse | null>(initialSession);
    const [lastSessionId, setLastSessionId] = useState<string | null>(
      initialSession?.session_id ?? null,
    );
    const [status, setStatus] = useState(opts.initialStatus ?? "idle");

    const controller = useRecordingController({
      enableTrayCommandListeners: opts.enableTrayCommandListeners,
      isSettingsWindow: opts.isSettingsWindow ?? false,
      isTrayWindow: opts.isTrayWindow ?? false,
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
      flushPendingSessionDetails: opts.flushPendingSessionDetails,
    });

    return { controller, topic, setTopic, source, setSource, status };
  });
}

describe("useRecordingController", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockClear();
    captureAnalyticsEventMock.mockClear();
    emitMock.mockClear();
    listenMock.mockClear();
    setDefaultInvokeMockImplementation();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates ui sync state and starts recording through the tauri adapter", async () => {
    const loadSessions = vi.fn(async () => undefined);

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return useRecordingController({
        isSettingsWindow: false,
        isTrayWindow: false,
        topic,
        setTopic,
        tagsInput,
        source,
        setSource,
        notesInput: customTag,
        session,
        setSession,
        lastSessionId,
        setLastSessionId,
        status,
        setStatus,
        loadSessions,
      });
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.start();
    });

    expect(invokeMock).toHaveBeenCalledWith("start_recording", {
      payload: {
        source: "slack",
        tags: [],
        notes: "",
        topic: "",
      },
    });
    expect(captureAnalyticsEventMock).toHaveBeenCalledWith("rec_clicked", {
      source: "slack",
      surface: "main",
      notes_present: false,
      topic_present: false,
      tags_count: 0,
    });
    expect(loadSessions).toHaveBeenCalled();
  });

  it("rejects start when recording permission is denied without mutating session state", async () => {
    const permissionError = "Screen & System Audio Recording permission is required";
    const loadSessions = vi.fn(async () => undefined);

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "start_recording") {
        throw permissionError;
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: false,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
        lastSessionId,
        status,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    let startError: unknown;
    await act(async () => {
      startError = await result.current.controller.start().catch((error) => error);
    });

    expect(startError).toBe(permissionError);

    expect(result.current.session).toBeNull();
    expect(result.current.lastSessionId).toBeNull();
    expect(result.current.status).toBe("idle");
    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("surfaces permission errors from the tray start listener without mutating session state", async () => {
    const permissionError = "Screen & System Audio Recording permission is required";
    const loadSessions = vi.fn(async () => undefined);

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: false,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
        lastSessionId,
        status,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "start_recording") {
        throw permissionError;
      }
      return getDefaultInvokeResponse(cmd);
    });

    const trayStartHandler = listeners.get("tray:start");
    expect(trayStartHandler).toBeDefined();

    await act(async () => {
      await trayStartHandler?.();
    });

    expect(result.current.status).toBe(`error: ${permissionError}`);
    expect(result.current.session).toBeNull();
    expect(result.current.lastSessionId).toBeNull();
    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("surfaces permission errors from direct startFromTray without mutating session state", async () => {
    const permissionError = "Screen & System Audio Recording permission is required";
    const loadSessions = vi.fn(async () => undefined);

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "start_recording") {
        throw permissionError;
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: false,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
        lastSessionId,
        status,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.startFromTray();
    });

    expect(result.current.status).toBe(`error: ${permissionError}`);
    expect(result.current.session).toBeNull();
    expect(result.current.lastSessionId).toBeNull();
    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("toggles recording input mute with the active session id and resets it after stop", async () => {
    const loadSessions = vi.fn(async () => undefined);

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
        lastSessionId,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.startFromTray();
    });

    expect(result.current.controller.muteState).toEqual({ micMuted: false, systemMuted: false });

    await act(async () => {
      await result.current.controller.toggleInputMuted("mic");
    });

    expect(invokeMock).toHaveBeenCalledWith("set_recording_input_muted", {
      sessionId: "s1",
      channel: "mic",
      muted: true,
    });
    expect(result.current.controller.muteState).toEqual({ micMuted: true, systemMuted: false });

    await act(async () => {
      await result.current.controller.stop();
    });

    expect(result.current.controller.muteState).toEqual({ micMuted: false, systemMuted: false });
  });

  it("resets mute state when a new recording session is hydrated while already recording", async () => {
    const loadSessions = vi.fn(async () => undefined);

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
        lastSessionId,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.startFromTray();
    });

    await act(async () => {
      await result.current.controller.toggleInputMuted("mic");
    });

    expect(result.current.controller.muteState).toEqual({ micMuted: true, systemMuted: false });

    const uiRecordingHandler = listeners.get("ui:recording");
    expect(uiRecordingHandler).toBeDefined();

    await act(async () => {
      await uiRecordingHandler?.({ payload: { recording: true, sessionId: "s2" } });
    });

    expect(result.current.session?.session_id).toBe("s2");
    expect(result.current.lastSessionId).toBe("s2");
    expect(result.current.controller.muteState).toEqual({ micMuted: false, systemMuted: false });
  });

  it("preserves mute state when recording sync repeats the active session id", async () => {
    const loadSessions = vi.fn(async () => undefined);
    const uiRecordingEmitCalls = () => emitMock.mock.calls.filter(([event]) => event === "ui:recording");

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
        lastSessionId,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.startFromTray();
    });

    await act(async () => {
      await result.current.controller.toggleInputMuted("mic");
    });

    expect(result.current.session?.session_id).toBe("s1");
    expect(result.current.controller.muteState).toEqual({ micMuted: true, systemMuted: false });
    await waitFor(() => {
      expect(uiRecordingEmitCalls()).toContainEqual(["ui:recording", { recording: true, sessionId: "s1" }]);
    });

    const uiRecordingHandler = listeners.get("ui:recording");
    expect(uiRecordingHandler).toBeDefined();
    const sessionBeforeSync = result.current.session;
    const emitCountBeforeSync = uiRecordingEmitCalls().length;

    await act(async () => {
      await uiRecordingHandler?.({ payload: { recording: true, sessionId: "s1" } });
    });

    expect(result.current.session?.session_id).toBe("s1");
    expect(result.current.session).toBe(sessionBeforeSync);
    expect(result.current.lastSessionId).toBe("s1");
    expect(result.current.controller.muteState).toEqual({ micMuted: true, systemMuted: false });
    expect(uiRecordingEmitCalls()).toHaveLength(emitCountBeforeSync);
  });

  it("hydrates authoritative mute state for an active recording and toggles the correct next edge", async () => {
    const loadSessions = vi.fn(async () => undefined);
    const muteCalls: Array<{ sessionId: string; channel: string; muted: boolean }> = [];

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return {
          source: "slack",
          topic: "Standup",
          is_recording: true,
          active_session_id: "s1",
          mute_state: { micMuted: true, systemMuted: false },
        };
      }
      if (cmd === "set_recording_input_muted") {
        muteCalls.push(args as { sessionId: string; channel: string; muted: boolean });
        return { micMuted: false, systemMuted: false };
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
        status,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    expect(result.current.status).toBe("recording");
    expect(result.current.session?.session_id).toBe("s1");
    expect(result.current.controller.muteState).toEqual({ micMuted: true, systemMuted: false });

    await act(async () => {
      await result.current.controller.toggleInputMuted("mic");
    });

    expect(muteCalls).toEqual([{ sessionId: "s1", channel: "mic", muted: false }]);
    expect(result.current.controller.muteState).toEqual({ micMuted: false, systemMuted: false });
  });

  it("uses the system mute branch and falls back to the optimistic state on null responses", async () => {
    const loadSessions = vi.fn(async () => undefined);
    const muteCalls: Array<{ sessionId: string; channel: string; muted: boolean }> = [];

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "set_recording_input_muted") {
        muteCalls.push(args as { channel: string; muted: boolean });
        await Promise.resolve();
        return null;
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.startFromTray();
    });

    await act(async () => {
      const firstToggle = result.current.controller.toggleInputMuted("system");
      const secondToggle = result.current.controller.toggleInputMuted("system");
      await Promise.all([firstToggle, secondToggle]);
    });

    expect(muteCalls).toEqual([
      { sessionId: "s1", channel: "system", muted: true },
      { sessionId: "s1", channel: "system", muted: false },
    ]);
    expect(result.current.controller.muteState).toEqual({ micMuted: false, systemMuted: false });
  });

  it("ignores a late mute rejection after the recording session changes", async () => {
    const loadSessions = vi.fn(async () => undefined);
    const muteCalls: Array<{ sessionId: string; channel: string; muted: boolean }> = [];
    let rejectMuteResponse: ((reason?: unknown) => void) | undefined;
    const muteResponse = new Promise<{ micMuted: boolean; systemMuted: boolean } | null>((_, reject) => {
      rejectMuteResponse = reject;
    });

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "set_recording_input_muted") {
        muteCalls.push(args as { channel: string; muted: boolean });
        return muteResponse;
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
        session,
      };
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.startFromTray();
    });

    let togglePromise: Promise<void> | undefined;
    await act(async () => {
      togglePromise = result.current.controller.toggleInputMuted("system");
    });

    expect(muteCalls).toEqual([{ sessionId: "s1", channel: "system", muted: true }]);
    expect(result.current.controller.muteState).toEqual({ micMuted: false, systemMuted: true });

    const uiRecordingHandler = listeners.get("ui:recording");
    expect(uiRecordingHandler).toBeDefined();

    await act(async () => {
      await uiRecordingHandler?.({ payload: { recording: true, sessionId: "s2" } });
    });

    expect(result.current.controller.muteState).toEqual({ micMuted: false, systemMuted: false });
    expect(result.current.session?.session_id).toBe("s2");

    await act(async () => {
      rejectMuteResponse?.(new Error("Recording session mismatch"));
      await togglePromise;
    });

    expect(result.current.controller.muteState).toEqual({ micMuted: false, systemMuted: false });
    expect(result.current.session?.session_id).toBe("s2");
  });

  it("treats muted or sub-threshold levels as inactive", () => {
    expect(shouldAnimateTrayAudio(0.02, false)).toBe(false);
    expect(shouldAnimateTrayAudio(0.12, false)).toBe(true);
    expect(shouldAnimateTrayAudio(0.9, true)).toBe(false);
  });

  it("debounces shared ui sync writes while source and topic are changing", async () => {
    vi.useFakeTimers();
    const loadSessions = vi.fn(async () => undefined);

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        setSource,
        setTopic,
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: false,
          topic,
          setTopic,
          tagsInput,
          source,
          setSource,
          notesInput: customTag,
          session,
          setSession,
          lastSessionId,
          setLastSessionId,
          status,
          setStatus,
          loadSessions,
        }),
      };
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");

    invokeMock.mockClear();
    emitMock.mockClear();

    await act(async () => {
      result.current.setTopic("Q1");
      result.current.setTopic("Q1 planning");
      result.current.setSource("telegram");
      await Promise.resolve();
    });

    expect(invokeMock).not.toHaveBeenCalledWith("set_ui_sync_state", expect.anything());

    await act(async () => {
      vi.advanceTimersByTime(149);
      await Promise.resolve();
    });

    expect(invokeMock).not.toHaveBeenCalledWith("set_ui_sync_state", expect.anything());

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("set_ui_sync_state", {
      source: "telegram",
      topic: "Q1 planning",
    });
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith("ui:sync", {
      source: "telegram",
      topic: "Q1 planning",
    });
    expect(result.current.controller.uiSyncReady).toBe(true);
  });

  it("reduces idle tray live-level polling frequency", async () => {
    vi.useFakeTimers();
    const loadSessions = vi.fn(async () => undefined);

    renderHook(() => {
      const [topic, setTopic] = useState("");
      const [tagsInput] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return useRecordingController({
        isSettingsWindow: false,
        isTrayWindow: true,
        topic,
        setTopic,
        tagsInput,
        source,
        setSource,
        notesInput: customTag,
        session,
        setSession,
        lastSessionId,
        setLastSessionId,
        status,
        setStatus,
        loadSessions,
      });
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith("get_live_input_levels");

    invokeMock.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    const liveLevelCalls = invokeMock.mock.calls.filter(([command]) => command === "get_live_input_levels");
    expect(liveLevelCalls.length).toBeLessThanOrEqual(4);
  });

  it("flushes pending session details before stopping the recording", async () => {
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

    const { result } = renderControllerHarness({
      initialSession: { session_id: "active-session", session_dir: "/tmp/active", status: "recording" },
      initialStatus: "recording",
      flushPendingSessionDetails,
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.stop();
    });

    expect(flushPendingSessionDetails).toHaveBeenCalledWith("active-session");
    expect(callOrder).toEqual(["flush", "stop_recording"]);
  });

  it("does not block stop if flushPendingSessionDetails rejects", async () => {
    const flushError = new Error("flush failed");
    const flushPendingSessionDetails = vi.fn(async () => {
      throw flushError;
    });

    const { result } = renderControllerHarness({
      initialSession: { session_id: "active-session", session_dir: "/tmp/active", status: "recording" },
      initialStatus: "recording",
      flushPendingSessionDetails,
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    await act(async () => {
      await result.current.controller.stop();
    });

    expect(flushPendingSessionDetails).toHaveBeenCalledWith("active-session");
    expect(invokeMock).toHaveBeenCalledWith("stop_recording", { sessionId: "active-session" });
  });

  it("flushes a pending tray topic autosave before stopping", async () => {
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

    const { result } = renderControllerHarness({
      isTrayWindow: true,
      initialSession: { session_id: "active-session", session_dir: "/tmp/active", status: "recording" },
      initialStatus: "recording",
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    // Fake timers go on AFTER the initial hydration waitFor — waitFor
    // polls via real setTimeout and would deadlock otherwise. Any
    // autosave side effect from the mount-time real timer is cleared
    // below so it can't pollute the flush/stop ordering assertion.
    vi.useFakeTimers();
    invokeMock.mockClear();
    callOrder.length = 0;

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
    const { result } = renderControllerHarness({
      isTrayWindow: true,
      initialTopic: "Daily sync",
      initialSession: { session_id: "active-session", session_dir: "/tmp/active", status: "recording" },
      initialStatus: "recording",
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
    const stopError = new Error("audio encoder crashed");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "stop_recording") {
        throw stopError;
      }
      if (cmd === "get_ui_sync_state") {
        return {
          source: "slack",
          topic: "Daily sync",
          is_recording: true,
          active_session_id: "active-session",
          mute_state: { micMuted: false, systemMuted: false },
        };
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderControllerHarness({
      isTrayWindow: true,
      initialTopic: "Daily sync",
      initialSession: { session_id: "active-session", session_dir: "/tmp/active", status: "recording" },
      initialStatus: "recording",
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

  it("flushes pending session details when tray:stop fires in the main window", async () => {
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

    renderControllerHarness({
      enableTrayCommandListeners: true,
      initialSession: { session_id: "active-session", session_dir: "/tmp/active", status: "recording" },
      initialStatus: "recording",
      flushPendingSessionDetails,
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

  it("does not schedule a tray topic autosave while a stop is in flight", async () => {
    let resolveStopRecording: () => void = () => undefined;
    const stopRecordingPromise = new Promise<string>((resolve) => {
      resolveStopRecording = () => resolve("recorded");
    });
    let updateCallCount = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "update_session_details") {
        updateCallCount += 1;
        return "updated";
      }
      if (cmd === "stop_recording") {
        return stopRecordingPromise;
      }
      if (cmd === "get_ui_sync_state") {
        return {
          source: "slack",
          topic: "initial",
          is_recording: false,
          active_session_id: null,
          mute_state: { micMuted: false, systemMuted: false },
        };
      }
      return getDefaultInvokeResponse(cmd);
    });

    const { result } = renderControllerHarness({
      isTrayWindow: true,
      initialTopic: "initial",
      initialSession: { session_id: "active-session", session_dir: "/tmp/active", status: "recording" },
      initialStatus: "recording",
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
    });

    // Install fake timers AFTER hydration so waitFor isn't blocked.
    vi.useFakeTimers();

    let stopPromise: Promise<void> = Promise.resolve();
    act(() => {
      stopPromise = result.current.controller.stop();
    });

    // Let microtasks drain so the in-stop flush completes and stop() is
    // now parked on `await stop_recording`.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsAfterFlush = updateCallCount;
    expect(callsAfterFlush).toBeGreaterThanOrEqual(1);

    // User types a new topic while stop_recording is in flight. Without
    // the race guard, the tray autosave effect schedules a 450ms debounce
    // that fires before session/status change, triggering a second
    // update_session_details for an effectively stopping session.
    act(() => {
      result.current.setTopic("typed during stop");
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(updateCallCount).toBe(callsAfterFlush);

    // Release stop_recording and drain.
    resolveStopRecording();
    await act(async () => {
      await stopPromise;
    });
  });
});
