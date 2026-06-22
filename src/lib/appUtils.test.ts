import { describe, expect, it } from "vitest";
import { redactSensitiveText, resolveSessionAudioPath } from "./appUtils";
import type { SessionListItem } from "../types";

function makeSessionItem(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "s-speed",
    status: "recorded",
    primary_tag: "zoom",
    topic: "Speed",
    display_date_ru: "21.06.2026",
    started_at_iso: "2026-06-21T10:00:00+03:00",
    session_dir: "/tmp/s-speed",
    audio_file: "audio.opus",
    audio_format: "opus",
    audio_duration_hms: "00:01:00",
    has_transcript_text: false,
    has_summary_text: false,
    brain_upload_status: "not_uploaded",
    ...overrides,
  };
}

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

describe("resolveSessionAudioPath", () => {
  it("prefers speed-adjusted audio when the session exposes it", () => {
    const path = resolveSessionAudioPath(
      makeSessionItem({
        speed_adjusted_audio_file: "audio_1.5x.opus",
        audio_speed_multiplier: 1.5,
      }),
    );

    expect(path).toBe("/tmp/s-speed/audio_1.5x.opus");
  });
});
