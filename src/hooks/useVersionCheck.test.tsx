import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { UpdateInfo } from "../types";

const invokeMock = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

import { useVersionCheck } from "./useVersionCheck";

const sampleInfo: UpdateInfo = {
  current: "2.0.2",
  latest: "2.1.0",
  is_newer: true,
  html_url: "https://github.com/chakveselchak/big_echo/releases/tag/v2.1.0",
  body: "## Changes\n- Something new",
  name: "v2.1.0",
  published_at: "2026-04-20T00:00:00Z",
};

describe("useVersionCheck", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes check_for_update exactly once on mount", async () => {
    invokeMock.mockResolvedValueOnce(sampleInfo);
    const { result } = renderHook(() => useVersionCheck());
    await waitFor(() => expect(result.current.updateInfo).toEqual(sampleInfo));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("check_for_update");
  });

  it("leaves updateInfo null on error and does not throw", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() => useVersionCheck());
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(result.current.updateInfo).toBeNull();
    warnSpy.mockRestore();
  });

  it("refresh() re-invokes check_for_update", async () => {
    invokeMock.mockResolvedValueOnce(sampleInfo);
    const { result } = renderHook(() => useVersionCheck());
    await waitFor(() => expect(result.current.updateInfo).toEqual(sampleInfo));

    const refreshed: UpdateInfo = { ...sampleInfo, latest: "2.2.0" };
    invokeMock.mockResolvedValueOnce(refreshed);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.updateInfo).toEqual(refreshed);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
