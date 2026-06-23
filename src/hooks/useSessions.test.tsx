import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureAnalyticsEventMock, invokeMock } = vi.hoisted(() => ({
  captureAnalyticsEventMock: vi.fn(async () => undefined),
  invokeMock: vi.fn(async (cmd: string, args?: unknown) => {
    if (cmd === "list_sessions") {
      return [
        {
          session_id: "s1",
          status: "recorded",
          primary_tag: "zoom",
          topic: "Weekly sync",
          display_date_ru: "11.03.2026",
          started_at_iso: "2026-03-11T10:00:00+03:00",
          session_dir: "/tmp/s1",
          audio_duration_hms: "00:15:20",
          has_transcript_text: false,
          has_summary_text: false,
        },
      ];
    }
    if (cmd === "get_session_meta") {
      return {
        session_id: "s1",
        source: "zoom",
        notes: "client-a",
        custom_summary_prompt: "Сделай саммари по решениям",
        topic: "Weekly sync",
        tags: ["Alice"],
      };
    }
    if (cmd === "list_known_tags") {
      return [];
    }
    if (cmd === "yandex_list_synced_sessions") {
      return [];
    }
    return args ?? null;
  }),
}));

vi.mock("../lib/tauri", () => ({
  tauriInvoke: invokeMock,
}));

vi.mock("../lib/analytics", () => ({
  captureAnalyticsEvent: captureAnalyticsEventMock,
}));

// useSessions subscribes to the "yandex-sync-finished" Tauri event on mount;
// stub listen() so it resolves to a no-op unlisten instead of hitting the
// (absent) Tauri IPC and emitting unhandled errors in jsdom.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { useSessions } from "./useSessions";

describe("useSessions", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    captureAnalyticsEventMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads sessions and meta details through the tauri adapter", async () => {
    const setStatus = vi.fn();
    const setLastSessionId = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
      expect(invokeMock).toHaveBeenCalledWith("get_session_meta", { sessionId: "s1" });
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessionDetails.s1?.notes).toBe("client-a");
      expect(result.current.sessionDetails.s1?.custom_summary_prompt).toBe("Сделай саммари по решениям");
    });
  });

  it("hydrates session details directly from the list payload when inline meta is available", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s-inline",
            status: "recorded",
            primary_tag: "meet",
            topic: "Inline meta",
            display_date_ru: "12.03.2026",
            started_at_iso: "2026-03-12T10:00:00+03:00",
            session_dir: "/tmp/s-inline",
            audio_duration_hms: "00:10:00",
            has_transcript_text: true,
            has_summary_text: false,
            meta: {
              session_id: "s-inline",
              source: "slack",
              notes: "Inline note",
              custom_summary_prompt: "Inline summary prompt",
              topic: "Inline topic",
              tags: ["project/acme", "call/sales"],
            },
          },
        ];
      }
      if (cmd === "get_session_meta") {
        throw new Error("unexpected meta lookup");
      }
      return null;
    });

    const setStatus = vi.fn();
    const setLastSessionId = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await waitFor(() => {
      expect(result.current.sessionDetails["s-inline"]?.notes).toBe("Inline note");
      expect(result.current.sessionDetails["s-inline"]?.custom_summary_prompt).toBe("Inline summary prompt");
      expect(result.current.sessionDetails["s-inline"]?.tags).toEqual(["project/acme", "call/sales"]);
    });

    expect(invokeMock).not.toHaveBeenCalledWith("get_session_meta", { sessionId: "s-inline" });
  });

  it("refreshes session identity when available audio speed multipliers change", async () => {
    let listCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_sessions") {
        listCalls += 1;
        return [
          {
            session_id: "s-speed",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Speed options",
            display_date_ru: "12.03.2026",
            started_at_iso: "2026-03-12T10:00:00+03:00",
            session_dir: "/tmp/s-speed",
            audio_file: "audio.opus",
            available_audio_speed_multipliers: listCalls === 1 ? [1, 1.25] : [1, 1.25, 1.5],
            audio_duration_hms: "00:10:00",
            has_transcript_text: true,
            has_summary_text: false,
            meta: {
              session_id: "s-speed",
              source: "zoom",
              notes: "",
              topic: "Speed options",
              tags: [],
            },
          },
        ];
      }
      return null;
    });

    const { result } = renderHook(() =>
      useSessions({ setStatus: vi.fn(), lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.loadSessions();
    });
    const firstSession = result.current.sessions[0];

    await act(async () => {
      await result.current.loadSessions();
    });

    expect(result.current.sessions[0]).not.toBe(firstSession);
    expect(result.current.sessions[0].available_audio_speed_multipliers).toEqual([1, 1.25, 1.5]);
  });

  it("loads known tags for autocomplete", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_sessions") return [];
      if (cmd === "list_known_tags") return ["call/sales", "project/acme"];
      return null;
    });

    const { result } = renderHook(() =>
      useSessions({ setStatus: vi.fn(), lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await waitFor(() => {
      expect(result.current.knownTags).toEqual(["call/sales", "project/acme"]);
    });
  });

  it("ignores stale known tag responses when refreshes resolve out of order", async () => {
    const knownTagResolvers: Array<(tags: string[]) => void> = [];

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_sessions") return [];
      if (cmd === "list_known_tags") {
        return new Promise<string[]>((resolve) => {
          knownTagResolvers.push(resolve);
        });
      }
      return null;
    });

    const { result } = renderHook(() =>
      useSessions({ setStatus: vi.fn(), lastSessionId: null, setLastSessionId: vi.fn() })
    );

    let firstLoad!: Promise<void>;
    await act(async () => {
      firstLoad = result.current.loadSessions();
    });

    let secondLoad!: Promise<void>;
    await act(async () => {
      secondLoad = result.current.loadSessions();
    });

    expect(knownTagResolvers).toHaveLength(2);

    await act(async () => {
      knownTagResolvers[1](["new"]);
      await secondLoad;
    });

    await waitFor(() => {
      expect(result.current.knownTags).toEqual(["new"]);
    });

    await act(async () => {
      knownTagResolvers[0](["old"]);
      await firstLoad;
    });

    expect(result.current.knownTags).toEqual(["new"]);
  });

  it("keeps newer known tags when an older session reload tag refresh resolves later", async () => {
    const knownTagResolvers: Array<(tags: string[]) => void> = [];
    const baseSession = {
      session_id: "s1",
      status: "recorded",
      primary_tag: "zoom",
      topic: "Weekly sync",
      display_date_ru: "11.03.2026",
      started_at_iso: "2026-03-11T10:00:00+03:00",
      session_dir: "/tmp/s1",
      audio_duration_hms: "00:15:20",
      has_transcript_text: true,
      has_summary_text: false,
      meta: {
        session_id: "s1",
        source: "zoom",
        notes: "",
        custom_summary_prompt: "",
        topic: "Weekly sync",
        tags: [],
      },
    };

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") return [baseSession];
      if (cmd === "update_session_details") return "updated";
      if (cmd === "list_known_tags") {
        return new Promise<string[]>((resolve) => {
          knownTagResolvers.push(resolve);
        });
      }
      return args ?? null;
    });

    const { result } = renderHook(() =>
      useSessions({ setStatus: vi.fn(), lastSessionId: null, setLastSessionId: vi.fn() })
    );

    let initialLoad!: Promise<void>;
    await act(async () => {
      initialLoad = result.current.loadSessions();
    });
    await act(async () => {
      knownTagResolvers[0](["initial"]);
      await initialLoad;
    });

    let olderReload!: Promise<void>;
    await act(async () => {
      olderReload = result.current.loadSessions();
    });
    await waitFor(() => {
      expect(knownTagResolvers).toHaveLength(2);
    });

    let savePromise!: Promise<boolean>;
    await act(async () => {
      savePromise = result.current.saveSessionDetails("s1", {
        ...result.current.sessionDetails.s1!,
        tags: ["new"],
      });
    });
    await waitFor(() => {
      expect(knownTagResolvers).toHaveLength(3);
    });

    await act(async () => {
      knownTagResolvers[2](["new"]);
      await savePromise;
    });

    expect(result.current.knownTags).toEqual(["new"]);

    await act(async () => {
      knownTagResolvers[1](["old"]);
      await olderReload;
    });

    expect(result.current.knownTags).toEqual(["new"]);
  });

  it("imports an audio file as a native session and reloads the list", async () => {
    let listCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_sessions") {
        listCalls += 1;
        if (listCalls === 1) {
          return [];
        }
        return [
          {
            session_id: "s-imported",
            status: "recorded",
            primary_tag: "other",
            topic: "Dictaphone note",
            display_date_ru: "06.04.2026",
            started_at_iso: "2026-04-06T09:00:00+03:00",
            session_dir: "/tmp/recordings/other/06.04.2026/meeting_09-00-00",
            audio_duration_hms: "00:02:14",
            has_transcript_text: false,
            has_summary_text: false,
            meta: {
              session_id: "s-imported",
              source: "other",
              notes: "",
              topic: "Dictaphone note",
              tags: [],
            },
          },
        ];
      }
      if (cmd === "import_audio_session") {
        return {
          session_id: "s-imported",
          session_dir: "/tmp/recordings/other/06.04.2026/meeting_09-00-00",
          status: "recorded",
        };
      }
      return null;
    });

    const setStatus = vi.fn();
    const setLastSessionId = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await act(async () => {
      await result.current.importAudioSession();
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("import_audio_session");
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessionDetails["s-imported"]?.source).toBe("other");
    });

    expect(setLastSessionId).toHaveBeenCalledWith("s-imported");
    expect(setStatus).toHaveBeenCalledWith("audio_imported");
  });

  it("passes session custom summary prompt to run_summary", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s1",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Weekly sync",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/s1",
            audio_duration_hms: "00:15:20",
            has_transcript_text: true,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s1",
          source: "zoom",
          notes: "client-a",
          custom_summary_prompt: "Сделай саммари по решениям",
          topic: "Weekly sync",
          tags: ["Alice"],
        };
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const setLastSessionId = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await waitFor(() => {
      expect(result.current.sessionDetails.s1?.custom_summary_prompt).toBe("Сделай саммари по решениям");
    });

    await act(async () => {
      await result.current.getSummary("s1");
    });

    expect(invokeMock).toHaveBeenCalledWith("run_summary", {
      sessionId: "s1",
      customPrompt: "Сделай саммари по решениям",
    });
    expect(captureAnalyticsEventMock).toHaveBeenCalledWith("get_summary_clicked", {
      session_id: "s1",
      surface: "sessions",
      custom_prompt_present: true,
    });
  });

  it("runs summary without passing prompt text when the session uses a named prompt", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s-named",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Named prompt",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/s-named",
            audio_duration_hms: "00:15:20",
            has_transcript_text: true,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s-named",
          source: "zoom",
          notes: "",
          custom_summary_prompt: "",
          custom_summary_prompt_name: "Actions",
          topic: "Named prompt",
          tags: [],
        };
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const setLastSessionId = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await act(async () => {
      await result.current.getSummary("s-named");
    });

    expect(invokeMock).toHaveBeenCalledWith("run_summary", { sessionId: "s-named" });
  });

  it("rolls back optimistic details when explicit save persistence fails", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s1",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Weekly sync",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/s1",
            audio_duration_hms: "00:15:20",
            has_transcript_text: true,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s1",
          source: "zoom",
          notes: "",
          custom_summary_prompt: "Legacy prompt",
          custom_summary_prompt_name: "",
          topic: "Weekly sync",
          tags: [],
        };
      }
      if (cmd === "update_session_details") {
        throw new Error("disk write failed");
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const setLastSessionId = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await waitFor(() => {
      expect(result.current.sessionDetails.s1?.custom_summary_prompt).toBe("Legacy prompt");
    });

    const nextDetail = {
      ...result.current.sessionDetails.s1!,
      custom_summary_prompt: "",
      custom_summary_prompt_name: "Actions",
    };

    let saved = true;
    await act(async () => {
      saved = await result.current.saveSessionDetails("s1", nextDetail);
    });

    expect(saved).toBe(false);
    expect(result.current.sessionDetails.s1?.custom_summary_prompt).toBe("Legacy prompt");
    expect(result.current.sessionDetails.s1?.custom_summary_prompt_name).toBe("");
  });

  it("keeps a newer local edit eligible for autosave after explicit save fails", async () => {
    let rejectFirstSave!: (reason?: unknown) => void;

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s1",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Weekly sync",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/s1",
            audio_duration_hms: "00:15:20",
            has_transcript_text: true,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s1",
          source: "zoom",
          notes: "",
          custom_summary_prompt: "Legacy prompt",
          custom_summary_prompt_name: "",
          topic: "Weekly sync",
          tags: [],
        };
      }
      if (cmd === "update_session_details") {
        const payload = (args as { payload: { custom_summary_prompt_name?: string } }).payload;
        if (payload.custom_summary_prompt_name === "Actions") {
          return new Promise((_resolve, reject) => {
            rejectFirstSave = reject;
          });
        }
        return "updated";
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const setLastSessionId = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await waitFor(() => {
      expect(result.current.sessionDetails.s1?.custom_summary_prompt).toBe("Legacy prompt");
    });

    vi.useFakeTimers();
    const failedDetail = {
      ...result.current.sessionDetails.s1!,
      custom_summary_prompt: "",
      custom_summary_prompt_name: "Actions",
    };
    let savePromise!: Promise<boolean>;
    act(() => {
      savePromise = result.current.saveSessionDetails("s1", failedDetail);
    });

    const newerDetail = {
      ...failedDetail,
      custom_summary_prompt_name: "Decisions",
    };
    act(() => {
      result.current.setSessionDetails((prev) => ({ ...prev, s1: newerDetail }));
    });

    await act(async () => {
      rejectFirstSave(new Error("disk write failed"));
      await savePromise;
    });

    expect(result.current.sessionDetails.s1?.custom_summary_prompt_name).toBe("Decisions");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(invokeMock).toHaveBeenCalledWith("update_session_details", {
      payload: expect.objectContaining({
        session_id: "s1",
        custom_summary_prompt: "",
        custom_summary_prompt_name: "Decisions",
      }),
    });
  });

  it("tracks Get text clicks before running transcription", async () => {
    const setStatus = vi.fn();
    const setLastSessionId = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId })
    );

    await act(async () => {
      await result.current.getText("s1");
    });

    expect(captureAnalyticsEventMock).toHaveBeenCalledWith("get_text_clicked", {
      session_id: "s1",
      surface: "sessions",
    });
    expect(invokeMock).toHaveBeenCalledWith("run_transcription", { sessionId: "s1" });
  });

  it("sets session transcription speed and reloads sessions after success", async () => {
    let listCalls = 0;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        listCalls += 1;
        return [
          {
            session_id: "s-speed",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Speed options",
            display_date_ru: "12.03.2026",
            started_at_iso: "2026-03-12T10:00:00+03:00",
            session_dir: "/tmp/s-speed",
            audio_file: "audio.opus",
            audio_speed_multiplier: listCalls === 1 ? 1 : 1.5,
            available_audio_speed_multipliers: [1, 1.5],
            audio_duration_hms: "00:10:00",
            has_transcript_text: true,
            has_summary_text: false,
            meta: {
              session_id: "s-speed",
              source: "zoom",
              notes: "",
              topic: "Speed options",
              tags: [],
            },
          },
        ];
      }
      if (cmd === "set_session_transcription_audio_speed") {
        return "ok";
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    await act(async () => {
      await result.current.setSessionTranscriptionSpeed("s-speed", 1.5);
    });

    expect(invokeMock).toHaveBeenCalledWith("set_session_transcription_audio_speed", {
      sessionId: "s-speed",
      speed: 1.5,
    });
    expect(listCalls).toBe(2);
    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1.5);
    expect(result.current.speedPendingBySession["s-speed"]).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("session_speed_updated");
  });

  it("lets the speed pending loader render before invoking speed generation", async () => {
    let frameCallback: FrameRequestCallback | null = null;
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallback = callback;
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "set_session_transcription_audio_speed") {
        return "ok";
      }
      if (cmd === "list_sessions") {
        return [];
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const { result } = renderHook(() =>
      useSessions({ setStatus: vi.fn(), lastSessionId: null, setLastSessionId: vi.fn() })
    );

    let speedPromise!: Promise<void>;
    act(() => {
      speedPromise = result.current.setSessionTranscriptionSpeed("s-speed", 1.5);
    });

    expect(result.current.speedPendingBySession["s-speed"]).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("set_session_transcription_audio_speed", {
      sessionId: "s-speed",
      speed: 1.5,
    });

    await act(async () => {
      frameCallback?.(performance.now());
      await speedPromise;
    });

    expect(requestAnimationFrameSpy).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("set_session_transcription_audio_speed", {
      sessionId: "s-speed",
      speed: 1.5,
    });
  });

  it("clears session transcription speed pending state after failure", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "set_session_transcription_audio_speed") {
        throw new Error("speed unavailable");
      }
      return [];
    });

    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.setSessionTranscriptionSpeed("s-speed", 1.75);
    });

    expect(invokeMock).toHaveBeenCalledWith("set_session_transcription_audio_speed", {
      sessionId: "s-speed",
      speed: 1.75,
    });
    expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    expect(result.current.speedPendingBySession["s-speed"]).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("error: speed unavailable");
  });

  it("keeps session transcription speed pending for a newer overlapping request", async () => {
    let listCalls = 0;
    const speedResolvers = new Map<number, (value: string) => void>();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        listCalls += 1;
        return [
          {
            session_id: "s-speed",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Speed options",
            display_date_ru: "12.03.2026",
            started_at_iso: "2026-03-12T10:00:00+03:00",
            session_dir: "/tmp/s-speed",
            audio_file: "audio.opus",
            audio_speed_multiplier: listCalls === 1 ? 1 : 1.75,
            available_audio_speed_multipliers: [1, 1.25, 1.75],
            audio_duration_hms: "00:10:00",
            has_transcript_text: true,
            has_summary_text: false,
            meta: {
              session_id: "s-speed",
              source: "zoom",
              notes: "",
              topic: "Speed options",
              tags: [],
            },
          },
        ];
      }
      if (cmd === "set_session_transcription_audio_speed") {
        const speed = (args as { speed: number }).speed;
        return new Promise<string>((resolve) => {
          speedResolvers.set(speed, resolve);
        });
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    let firstRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.setSessionTranscriptionSpeed("s-speed", 1.25);
    });

    await waitFor(() => {
      expect(result.current.speedPendingBySession["s-speed"]).toBe(true);
      expect(speedResolvers.has(1.25)).toBe(true);
    });

    let secondRequest!: Promise<void>;
    act(() => {
      secondRequest = result.current.setSessionTranscriptionSpeed("s-speed", 1.75);
    });

    await waitFor(() => {
      expect(result.current.speedPendingBySession["s-speed"]).toBe(true);
      expect(speedResolvers.has(1.75)).toBe(true);
    });

    await act(async () => {
      speedResolvers.get(1.25)?.("ok");
      await firstRequest;
    });

    expect(result.current.speedPendingBySession["s-speed"]).toBe(true);
    expect(listCalls).toBe(1);
    expect(setStatus).not.toHaveBeenCalledWith("session_speed_updated");

    await act(async () => {
      speedResolvers.get(1.75)?.("ok");
      await secondRequest;
    });

    expect(result.current.speedPendingBySession["s-speed"]).toBe(false);
    expect(listCalls).toBe(2);
    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1.75);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("session_speed_updated");
  });

  it("does not apply a stale session transcription speed reload that resolves after a newer request starts", async () => {
    let listCalls = 0;
    const speedResolvers = new Map<number, (value: string) => void>();
    const listResolvers = new Map<number, (value: unknown[]) => void>();
    const sessionList = (speed: number) => [
      {
        session_id: "s-speed",
        status: "recorded",
        primary_tag: "zoom",
        topic: "Speed options",
        display_date_ru: "12.03.2026",
        started_at_iso: "2026-03-12T10:00:00+03:00",
        session_dir: "/tmp/s-speed",
        audio_file: "audio.opus",
        audio_speed_multiplier: speed,
        available_audio_speed_multipliers: [1, 1.25, 1.75],
        audio_duration_hms: "00:10:00",
        has_transcript_text: true,
        has_summary_text: false,
        meta: {
          session_id: "s-speed",
          source: "zoom",
          notes: "",
          topic: "Speed options",
          tags: [],
        },
      },
    ];

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        listCalls += 1;
        if (listCalls === 1) return sessionList(1);
        return new Promise<unknown[]>((resolve) => {
          listResolvers.set(listCalls, resolve);
        });
      }
      if (cmd === "set_session_transcription_audio_speed") {
        const speed = (args as { speed: number }).speed;
        return new Promise<string>((resolve) => {
          speedResolvers.set(speed, resolve);
        });
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    let firstRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.setSessionTranscriptionSpeed("s-speed", 1.25);
    });

    await waitFor(() => {
      expect(speedResolvers.has(1.25)).toBe(true);
    });

    act(() => {
      speedResolvers.get(1.25)?.("ok");
    });

    await waitFor(() => {
      expect(listResolvers.has(2)).toBe(true);
    });

    let secondRequest!: Promise<void>;
    act(() => {
      secondRequest = result.current.setSessionTranscriptionSpeed("s-speed", 1.75);
    });

    await waitFor(() => {
      expect(speedResolvers.has(1.75)).toBe(true);
    });

    await act(async () => {
      listResolvers.get(2)?.(sessionList(1.25));
      await firstRequest;
    });

    expect(result.current.speedPendingBySession["s-speed"]).toBe(true);
    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1);
    expect(setStatus).not.toHaveBeenCalledWith("session_speed_updated");

    await act(async () => {
      speedResolvers.get(1.75)?.("ok");
    });

    await waitFor(() => {
      expect(listResolvers.has(3)).toBe(true);
    });

    await act(async () => {
      listResolvers.get(3)?.(sessionList(1.75));
      await secondRequest;
    });

    expect(result.current.speedPendingBySession["s-speed"]).toBe(false);
    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1.75);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("session_speed_updated");
  });

  it("does not apply stale session transcription speed list state while awaiting metadata", async () => {
    let listCalls = 0;
    const speedResolvers = new Map<number, (value: string) => void>();
    const metaResolvers = new Map<number, (value: unknown) => void>();
    const sessionList = (speed: number) => [
      {
        session_id: "s-speed",
        status: "recorded",
        primary_tag: "zoom",
        topic: "Speed options",
        display_date_ru: "12.03.2026",
        started_at_iso: "2026-03-12T10:00:00+03:00",
        session_dir: "/tmp/s-speed",
        audio_file: "audio.opus",
        audio_speed_multiplier: speed,
        available_audio_speed_multipliers: [1, 1.25, 1.75],
        audio_duration_hms: "00:10:00",
        has_transcript_text: true,
        has_summary_text: false,
      },
    ];
    const meta = {
      session_id: "s-speed",
      source: "zoom",
      notes: "",
      topic: "Speed options",
      tags: [],
    };

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        listCalls += 1;
        if (listCalls === 1) return sessionList(1);
        return sessionList(listCalls === 2 ? 1.25 : 1.75);
      }
      if (cmd === "get_session_meta") {
        const call = listCalls;
        if (call === 1) return meta;
        return new Promise<unknown>((resolve) => {
          metaResolvers.set(call, resolve);
        });
      }
      if (cmd === "set_session_transcription_audio_speed") {
        const speed = (args as { speed: number }).speed;
        return new Promise<string>((resolve) => {
          speedResolvers.set(speed, resolve);
        });
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    let firstRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.setSessionTranscriptionSpeed("s-speed", 1.25);
    });

    await waitFor(() => {
      expect(speedResolvers.has(1.25)).toBe(true);
    });

    act(() => {
      speedResolvers.get(1.25)?.("ok");
    });

    await waitFor(() => {
      expect(metaResolvers.has(2)).toBe(true);
    });

    let secondRequest!: Promise<void>;
    act(() => {
      secondRequest = result.current.setSessionTranscriptionSpeed("s-speed", 1.75);
    });

    await waitFor(() => {
      expect(speedResolvers.has(1.75)).toBe(true);
    });

    await act(async () => {
      metaResolvers.get(2)?.(meta);
      await firstRequest;
    });

    expect(result.current.speedPendingBySession["s-speed"]).toBe(true);
    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1);
    expect(setStatus).not.toHaveBeenCalledWith("session_speed_updated");

    await act(async () => {
      speedResolvers.get(1.75)?.("ok");
    });

    await waitFor(() => {
      expect(metaResolvers.has(3)).toBe(true);
    });

    await act(async () => {
      metaResolvers.get(3)?.(meta);
      await secondRequest;
    });

    expect(result.current.speedPendingBySession["s-speed"]).toBe(false);
    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1.75);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("session_speed_updated");
  });

  it("keeps newer session transcription speed state when an older normal reload resolves later", async () => {
    let listCalls = 0;
    const listResolvers = new Map<number, (value: unknown[]) => void>();
    const sessionList = (speed: number) => [
      {
        session_id: "s-speed",
        status: "recorded",
        primary_tag: "zoom",
        topic: "Speed options",
        display_date_ru: "12.03.2026",
        started_at_iso: "2026-03-12T10:00:00+03:00",
        session_dir: "/tmp/s-speed",
        audio_file: "audio.opus",
        audio_speed_multiplier: speed,
        available_audio_speed_multipliers: [1, 1.75],
        audio_duration_hms: "00:10:00",
        has_transcript_text: true,
        has_summary_text: false,
        meta: {
          session_id: "s-speed",
          source: "zoom",
          notes: "",
          topic: "Speed options",
          tags: [],
        },
      },
    ];

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        listCalls += 1;
        if (listCalls === 1) return sessionList(1);
        if (listCalls === 3) return sessionList(1.75);
        return new Promise<unknown[]>((resolve) => {
          listResolvers.set(listCalls, resolve);
        });
      }
      if (cmd === "set_session_transcription_audio_speed") {
        return "ok";
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    let staleReload!: Promise<void>;
    act(() => {
      staleReload = result.current.loadSessions();
    });

    await waitFor(() => {
      expect(listResolvers.has(2)).toBe(true);
    });

    await act(async () => {
      await result.current.setSessionTranscriptionSpeed("s-speed", 1.75);
    });

    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1.75);

    await act(async () => {
      listResolvers.get(2)?.(sessionList(1));
      await staleReload;
    });

    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1.75);
    expect(setStatus).toHaveBeenCalledWith("session_speed_updated");
  });

  it("reloads session transcription speed after an older success is followed by a newer failure", async () => {
    let listCalls = 0;
    const speedResolvers = new Map<number, { resolve: (value: string) => void; reject: (reason?: unknown) => void }>();
    const sessionList = (speed: number) => [
      {
        session_id: "s-speed",
        status: "recorded",
        primary_tag: "zoom",
        topic: "Speed options",
        display_date_ru: "12.03.2026",
        started_at_iso: "2026-03-12T10:00:00+03:00",
        session_dir: "/tmp/s-speed",
        audio_file: "audio.opus",
        audio_speed_multiplier: speed,
        available_audio_speed_multipliers: [1, 1.25, 1.75],
        audio_duration_hms: "00:10:00",
        has_transcript_text: true,
        has_summary_text: false,
        meta: {
          session_id: "s-speed",
          source: "zoom",
          notes: "",
          topic: "Speed options",
          tags: [],
        },
      },
    ];

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        listCalls += 1;
        return sessionList(listCalls === 1 ? 1 : 1.25);
      }
      if (cmd === "set_session_transcription_audio_speed") {
        const speed = (args as { speed: number }).speed;
        return new Promise<string>((resolve, reject) => {
          speedResolvers.set(speed, { resolve, reject });
        });
      }
      if (cmd === "list_known_tags") {
        return [];
      }
      return args ?? null;
    });

    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSessions({ setStatus, lastSessionId: null, setLastSessionId: vi.fn() })
    );

    await act(async () => {
      await result.current.loadSessions();
    });

    let firstRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.setSessionTranscriptionSpeed("s-speed", 1.25);
    });
    await waitFor(() => {
      expect(speedResolvers.has(1.25)).toBe(true);
    });

    let secondRequest!: Promise<void>;
    act(() => {
      secondRequest = result.current.setSessionTranscriptionSpeed("s-speed", 1.75);
    });
    await waitFor(() => {
      expect(speedResolvers.has(1.75)).toBe(true);
    });

    await act(async () => {
      speedResolvers.get(1.25)?.resolve("ok");
      await firstRequest;
    });

    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1);
    expect(result.current.speedPendingBySession["s-speed"]).toBe(true);

    await act(async () => {
      speedResolvers.get(1.75)?.reject(new Error("speed unavailable"));
      await secondRequest;
    });

    expect(result.current.speedPendingBySession["s-speed"]).toBe(false);
    expect(result.current.sessions[0].audio_speed_multiplier).toBe(1.25);
    expect(setStatus).toHaveBeenCalledWith("error: speed unavailable");
  });
});
