import { describe, expect, it } from "vitest";
import {
  formatBrainUploadUserMessage,
  isBrainUploadAlreadyRunning,
  parseBrainUploadPublicError,
} from "./brainUploadError";

describe("brainUploadError", () => {
  it("parses structured public error objects", () => {
    const parsed = parseBrainUploadPublicError({
      code: "network_error",
      message: "Не удалось связаться с Brain. Проверьте сеть и URL.",
    });
    expect(parsed?.code).toBe("network_error");
    expect(formatBrainUploadUserMessage(parsed)).toBe(
      "Не удалось связаться с Brain. Проверьте сеть и URL.",
    );
  });

  it("parses JSON-encoded invoke errors", () => {
    const parsed = parseBrainUploadPublicError(
      JSON.stringify({
        code: "already_running",
        message: "Загрузка Brain уже выполняется.",
      }),
    );
    expect(isBrainUploadAlreadyRunning(parsed)).toBe(true);
  });
});
