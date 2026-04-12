import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
        custom_tag: "client-a",
        custom_summary_prompt: "Сделай саммари по решениям",
        topic: "Weekly sync",
        participants: ["Alice"],
      };
    }
    return args ?? null;
  }),
}));

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: invokeMock,
}));

vi.mock("../../lib/analytics", () => ({
  captureAnalyticsEvent: captureAnalyticsEventMock,
}));

import { useSessions } from "./useSessions";

describe("useSessions", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    captureAnalyticsEventMock.mockClear();
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
      expect(result.current.sessionDetails.s1?.custom_tag).toBe("client-a");
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
              source: "meet",
              custom_tag: "inline-tag",
              custom_summary_prompt: "Inline summary prompt",
              topic: "Inline meta",
              participants: ["Alice", "Bob"],
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
      expect(result.current.sessionDetails["s-inline"]?.custom_tag).toBe("inline-tag");
      expect(result.current.sessionDetails["s-inline"]?.custom_summary_prompt).toBe("Inline summary prompt");
      expect(result.current.sessionDetails["s-inline"]?.participants).toEqual(["Alice", "Bob"]);
    });

    expect(invokeMock).not.toHaveBeenCalledWith("get_session_meta", { sessionId: "s-inline" });
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
              custom_tag: "",
              topic: "Dictaphone note",
              participants: [],
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
          custom_tag: "client-a",
          custom_summary_prompt: "Сделай саммари по решениям",
          topic: "Weekly sync",
          participants: ["Alice"],
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
});
