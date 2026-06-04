import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTodoistTasks } from "./useTodoistTasks";

const invokeMock = vi.fn();

vi.mock("../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("useTodoistTasks", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads a Todoist task preview for a session", async () => {
    invokeMock.mockResolvedValue({
      sessionId: "session-1",
      summaryPath: "/tmp/session/summary.md",
      warnings: [],
      items: [],
    });

    const { result } = renderHook(() => useTodoistTasks());

    await act(async () => {
      await result.current.openPreview("session-1");
    });

    expect(invokeMock).toHaveBeenCalledWith("preview_todoist_tasks", {
      sessionId: "session-1",
    });
    expect(result.current.preview?.sessionId).toBe("session-1");
    expect(result.current.loading).toBe(false);
  });

  it("enqueues selected tasks, syncs, and refreshes preview", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "enqueue_todoist_tasks") return Promise.resolve();
      if (cmd === "sync_todoist_tasks") return Promise.resolve({ synced: 1, failed: 0 });
      if (cmd === "preview_todoist_tasks") {
        return Promise.resolve({
          sessionId: "session-1",
          summaryPath: "/tmp/session/summary.md",
          warnings: [],
          items: [],
        });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    const { result } = renderHook(() => useTodoistTasks());

    let syncResult: { synced: number; failed: number } | null = null;
    await act(async () => {
      syncResult = await result.current.enqueueAndSync("session-1", ["id-1"]);
    });

    expect(invokeMock).toHaveBeenCalledWith("enqueue_todoist_tasks", {
      sessionId: "session-1",
      taskIds: ["id-1"],
    });
    expect(invokeMock).toHaveBeenCalledWith("sync_todoist_tasks", {
      sessionId: "session-1",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("preview_todoist_tasks", {
      sessionId: "session-1",
    });
    expect(syncResult).toEqual({ synced: 1, failed: 0 });
    expect(result.current.syncing).toBe(false);
  });
});
