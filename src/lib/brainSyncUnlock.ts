const STORAGE_KEY = "bigecho.brain_sync.unlocked";

export const BRAIN_UNLOCK_TAPS = 5;
export const BRAIN_UNLOCK_WINDOW_MS = 10_000;

/**
 * Records a version tap and reports whether the unlock gesture completed:
 * BRAIN_UNLOCK_TAPS taps within BRAIN_UNLOCK_WINDOW_MS. Only the last few
 * timestamps are kept (bounded array, no timers), so it cannot leak memory.
 */
export function registerUnlockTap(
  recent: number[],
  now: number,
): { taps: number[]; unlocked: boolean } {
  const taps = [...recent, now].slice(-BRAIN_UNLOCK_TAPS);
  const unlocked =
    taps.length === BRAIN_UNLOCK_TAPS && now - taps[0] <= BRAIN_UNLOCK_WINDOW_MS;
  return { taps, unlocked };
}

export function readBrainSyncUnlocked(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistBrainSyncUnlocked(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage may be unavailable; the unlock still applies for this session.
  }
}
