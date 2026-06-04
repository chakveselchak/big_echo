import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTodoistSync } from "./useTodoistSync";

const invokeMock = vi.fn();

vi.mock("../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("useTodoistSync", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads token presence on mount when enabled", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "todoist_sync_has_token") return Promise.resolve(true);
      return Promise.reject(new Error("unexpected"));
    });

    const { result } = renderHook(() => useTodoistSync(true));

    await waitFor(() => expect(result.current.hasToken).toBe(true));
  });

  it("does not load token presence when disabled", async () => {
    renderHook(() => useTodoistSync(false));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("saveToken stores the token, refreshes presence, and marks it updated", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "todoist_sync_set_token") return Promise.resolve();
      if (cmd === "todoist_sync_has_token") return Promise.resolve(true);
      return Promise.reject(new Error("unexpected"));
    });

    const { result } = renderHook(() => useTodoistSync(true));

    await act(async () => {
      await result.current.saveToken("todoist-token");
    });

    expect(invokeMock).toHaveBeenCalledWith("todoist_sync_set_token", { token: "todoist-token" });
    expect(result.current.hasToken).toBe(true);
    expect(result.current.tokenState).toBe("updated");
  });

  it("clearToken clears the token, refreshes presence, and marks it unchanged", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "todoist_sync_clear_token") return Promise.resolve();
      if (cmd === "todoist_sync_has_token") return Promise.resolve(false);
      return Promise.reject(new Error("unexpected"));
    });

    const { result } = renderHook(() => useTodoistSync(true));

    await act(async () => {
      await result.current.clearToken();
    });

    expect(invokeMock).toHaveBeenCalledWith("todoist_sync_clear_token");
    expect(result.current.hasToken).toBe(false);
    expect(result.current.tokenState).toBe("unchanged");
  });
});
