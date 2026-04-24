import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useYandexSync } from "./useYandexSync";

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

describe("useYandexSync", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads has_token and status on mount when enabled", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_has_token") return Promise.resolve(true);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.reject(new Error("unexpected"));
    });
    const { result } = renderHook(() => useYandexSync(true));
    await waitFor(() => expect(result.current.hasToken).toBe(true));
  });

  it("does not load when disabled", async () => {
    renderHook(() => useYandexSync(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("saveToken refreshes has_token after success", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_set_token") return Promise.resolve();
      if (cmd === "yandex_sync_has_token") return Promise.resolve(true);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.reject(new Error("unexpected"));
    });
    const { result } = renderHook(() => useYandexSync(true));
    await act(async () => {
      await result.current.saveToken("abc");
    });
    expect(invokeMock).toHaveBeenCalledWith("yandex_sync_set_token", { token: "abc" });
    expect(result.current.hasToken).toBe(true);
    expect(result.current.tokenState).toBe("updated");
  });

  it("clearToken invokes yandex_sync_clear_token and refreshes has_token to false", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_clear_token") return Promise.resolve();
      if (cmd === "yandex_sync_has_token") return Promise.resolve(false);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.reject(new Error("unexpected"));
    });
    const { result } = renderHook(() => useYandexSync(true));
    await act(async () => {
      await result.current.clearToken();
    });
    expect(invokeMock).toHaveBeenCalledWith("yandex_sync_clear_token");
    expect(result.current.hasToken).toBe(false);
  });

  it("subscribes to yandex-sync-progress and yandex-sync-finished", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_has_token") return Promise.resolve(true);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.resolve();
    });
    renderHook(() => useYandexSync(true));
    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith("yandex-sync-progress", expect.any(Function));
      expect(listenMock).toHaveBeenCalledWith("yandex-sync-finished", expect.any(Function));
    });
  });
});
