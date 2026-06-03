import { describe, expect, it } from "vitest";

import {
  BRAIN_UNLOCK_TAPS,
  BRAIN_UNLOCK_WINDOW_MS,
  registerUnlockTap,
} from "./brainSyncUnlock";

describe("registerUnlockTap", () => {
  it("requires five taps within the window", () => {
    expect(BRAIN_UNLOCK_TAPS).toBe(5);
    expect(BRAIN_UNLOCK_WINDOW_MS).toBe(10_000);
  });

  it("does not unlock before the fifth tap", () => {
    let taps: number[] = [];
    for (let i = 0; i < BRAIN_UNLOCK_TAPS - 1; i += 1) {
      const result = registerUnlockTap(taps, i * 100);
      taps = result.taps;
      expect(result.unlocked).toBe(false);
    }
  });

  it("unlocks on the fifth tap inside the ten-second window", () => {
    let taps: number[] = [];
    const times = [0, 1000, 2000, 3000, 4000];
    const unlocks = times.map((now) => {
      const result = registerUnlockTap(taps, now);
      taps = result.taps;
      return result.unlocked;
    });
    expect(unlocks).toEqual([false, false, false, false, true]);
  });

  it("does not unlock when the five taps span more than ten seconds", () => {
    let taps: number[] = [];
    const times = [0, 1000, 2000, 3000, 10_001];
    const result = times.map((now) => {
      const r = registerUnlockTap(taps, now);
      taps = r.taps;
      return r.unlocked;
    });
    expect(result[result.length - 1]).toBe(false);
  });

  it("unlocks via the sliding window when a fresh burst follows stale taps", () => {
    let taps: number[] = [];
    // Two stale taps long ago, then five rapid taps within the window.
    const times = [0, 500, 30_000, 30_100, 30_200, 30_300, 30_400];
    let lastUnlocked = false;
    for (const now of times) {
      const result = registerUnlockTap(taps, now);
      taps = result.taps;
      lastUnlocked = result.unlocked;
    }
    expect(lastUnlocked).toBe(true);
  });

  it("never retains more than five timestamps", () => {
    let taps: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      taps = registerUnlockTap(taps, i * 50).taps;
      expect(taps.length).toBeLessThanOrEqual(BRAIN_UNLOCK_TAPS);
    }
  });
});
