import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, emitMock, listenMock, listeners } = vi.hoisted(() => ({
  listeners: new Map<string, (payload?: unknown) => void | Promise<void>>(),
  emitMock: vi.fn(async () => undefined),
  invokeMock: vi.fn(async (cmd: string) => {
    if (cmd === "get_ui_sync_state") {
      return { source: "slack", topic: "", is_recording: false, active_session_id: null };
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

vi.mock("../../lib/tauri", () => ({
  tauriEmit: emitMock,
  tauriInvoke: invokeMock,
  tauriListen: listenMock,
}));

import { StartResponse } from "../../appTypes";
import { shouldAnimateTrayAudio } from "./trayAudio";
import { useRecordingController } from "./useRecordingController";

function getDefaultInvokeResponse(cmd: string) {
  if (cmd === "get_ui_sync_state") {
    return { source: "slack", topic: "", is_recording: false, active_session_id: null };
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

describe("useRecordingController", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockClear();
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return useRecordingController({
        isSettingsWindow: false,
        isTrayWindow: false,
        topic,
        setTopic,
        participants,
        setParticipants,
        source,
        setSource,
        customTag,
        setCustomTag,
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
        tags: ["slack"],
        topic: "",
        participants: [],
      },
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: false,
          topic,
          setTopic,
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: false,
          topic,
          setTopic,
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: false,
          topic,
          setTopic,
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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

    const { result } = renderHook(() => {
      const [topic, setTopic] = useState("");
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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

    const uiRecordingHandler = listeners.get("ui:recording");
    expect(uiRecordingHandler).toBeDefined();

    await act(async () => {
      await uiRecordingHandler?.({ payload: { recording: true, sessionId: "s1" } });
    });

    expect(result.current.session?.session_id).toBe("s1");
    expect(result.current.lastSessionId).toBe("s1");
    expect(result.current.controller.muteState).toEqual({ micMuted: true, systemMuted: false });
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return {
        controller: useRecordingController({
          isSettingsWindow: false,
          isTrayWindow: true,
          topic,
          setTopic,
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
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
          participants,
          setParticipants,
          source,
          setSource,
          customTag,
          setCustomTag,
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
      const [participants, setParticipants] = useState("");
      const [source, setSource] = useState("slack");
      const [customTag, setCustomTag] = useState("");
      const [session, setSession] = useState<StartResponse | null>(null);
      const [lastSessionId, setLastSessionId] = useState<string | null>(null);
      const [status, setStatus] = useState("idle");

      return useRecordingController({
        isSettingsWindow: false,
        isTrayWindow: true,
        topic,
        setTopic,
        participants,
        setParticipants,
        source,
        setSource,
        customTag,
        setCustomTag,
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
});
