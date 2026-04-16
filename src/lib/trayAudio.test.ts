import { describe, expect, it } from "vitest";

import { buildTrayAudioWavePath, getTrayAudioWaveMetrics, shouldAnimateTrayAudio } from "./trayAudio";

describe("trayAudio helpers", () => {
  it("treats muted or sub-threshold levels as inactive", () => {
    expect(shouldAnimateTrayAudio(0.02, false)).toBe(false);
    expect(shouldAnimateTrayAudio(0.12, false)).toBe(true);
    expect(shouldAnimateTrayAudio(0.9, true)).toBe(false);
  });

  it("keeps a flat horizontal line when the input is silent or muted", () => {
    expect(getTrayAudioWaveMetrics(0, false).mode).toBe("flat");
    expect(getTrayAudioWaveMetrics(0.02, false).mode).toBe("flat");
    expect(getTrayAudioWaveMetrics(0.9, true).mode).toBe("flat");
    expect(buildTrayAudioWavePath(getTrayAudioWaveMetrics(0, false), 0)).toBe("M 0.00 14.00 L 120.00 14.00");
  });

  it("switches from a gentle wave to a strong wave as the level rises", () => {
    const gentle = getTrayAudioWaveMetrics(0.2, false);
    const strong = getTrayAudioWaveMetrics(0.9, false);

    expect(gentle.mode).toBe("gentle");
    expect(strong.mode).toBe("strong");
    expect(gentle.amplitude).toBeGreaterThan(0);
    expect(strong.amplitude).toBeGreaterThan(gentle.amplitude);
    expect(strong.speed).toBeGreaterThan(gentle.speed);
    expect(buildTrayAudioWavePath(gentle, 0)).not.toBe("M 0.00 14.00 L 120.00 14.00");
  });
});
