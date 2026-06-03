import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./appUtils";

describe("redactSensitiveText", () => {
  it.each(["01234567890123456789", "0123456789012345678901", "01234567890123456789012"])(
    "redacts %s token-like values with at least 20 characters",
    (token) => {
      const redacted = redactSensitiveText(`Authorization failed for ${token}`);
      expect(redacted).not.toContain(token);
      expect(redacted).toContain("[redacted]");
    },
  );
});
