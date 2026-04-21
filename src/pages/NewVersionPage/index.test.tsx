import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { UpdateInfo } from "../../types";

const invokeMock = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => undefined)
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

import { NewVersionPage } from "./index";

const info: UpdateInfo = {
  current: "2.0.2",
  latest: "2.1.0",
  is_newer: true,
  html_url: "https://github.com/chakveselchak/big_echo/releases/tag/v2.1.0",
  body: "## What is new\n\n- Feature A\n- Feature B",
  name: "v2.1.0",
  published_at: "2026-04-20T00:00:00Z",
};

describe("NewVersionPage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("renders headline with latest and current versions", () => {
    render(<NewVersionPage updateInfo={info} />);
    expect(screen.getByText(/New version 2\.1\.0 available/i)).toBeInTheDocument();
    expect(screen.getByText(/You are on 2\.0\.2/i)).toBeInTheDocument();
  });

  it("renders markdown body headings and list items", () => {
    render(<NewVersionPage updateInfo={info} />);
    expect(screen.getByRole("heading", { name: /What is new/i })).toBeInTheDocument();
    expect(screen.getByText(/Feature A/)).toBeInTheDocument();
    expect(screen.getByText(/Feature B/)).toBeInTheDocument();
  });

  it("opens the GitHub release via open_external_url when clicked", async () => {
    const user = userEvent.setup();
    render(<NewVersionPage updateInfo={info} />);
    const button = screen.getByRole("link", { name: /Download new version/i });
    expect(button).toHaveAttribute("href", info.html_url);
    await user.click(button);
    expect(invokeMock).toHaveBeenCalledWith("open_external_url", { url: info.html_url });
  });
});
