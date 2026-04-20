import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UpdateInfo } from "../../types";
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

  it("renders an external link to the release page", () => {
    render(<NewVersionPage updateInfo={info} />);
    const link = screen.getByRole("link", { name: /View on GitHub/i });
    expect(link).toHaveAttribute("href", info.html_url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });
});
