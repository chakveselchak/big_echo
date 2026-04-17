import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("App.css", () => {
  it("keeps the custom prompt button square and aligned with session action buttons", () => {
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
    const rule = css.match(/\.session-summary-prompt-button\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";

    expect(rule).toContain("width: 36px");
    expect(rule).toContain("height: 36px");
    expect(rule).toContain("min-height: 36px");
  });
});
