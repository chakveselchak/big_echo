import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type InvokeMock = (cmd: string, args?: unknown) => Promise<unknown>;

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<InvokeMock>(async (cmd: string) => {
    if (cmd === "get_ui_sync_state") {
      return { source: "slack", topic: "", is_recording: false, active_session_id: null };
    }
    if (cmd === "set_ui_sync_state") return "updated";
    if (cmd === "list_sessions") return [];
    return null;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (filePath: string) => `asset://${filePath}`,
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", hide: vi.fn(async () => undefined) }),
}));

import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  it("wraps the app with Ant Design ConfigProvider and AntdApp", async () => {
    render(<AppRoot />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    const antApp = document.querySelector(".ant-app");

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(antApp).toBeInTheDocument();
  });
});
