import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
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

import { useSessions } from "./useSessions";

describe("useSessions", () => {
  beforeEach(() => {
    invokeMock.mockClear();
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
      expect(result.current.sessionDetails["s-inline"]?.participants).toEqual(["Alice", "Bob"]);
    });

    expect(invokeMock).not.toHaveBeenCalledWith("get_session_meta", { sessionId: "s-inline" });
  });
});
