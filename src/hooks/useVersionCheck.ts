import { useCallback, useEffect, useRef, useState } from "react";
import { tauriInvoke } from "../lib/tauri";
import type { UpdateInfo } from "../types";

/// Re-trigger `check_for_update` once a day in long-running sessions. The
/// Rust command rate-limits actual GitHub fetches to once per 24h via an
/// on-disk cache, so this interval mostly returns cached data — but ensures
/// the UI surfaces a freshly-released version even if the user never restarts
/// the app.
const VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function useVersionCheck(): {
  updateInfo: UpdateInfo | null;
  refresh: () => Promise<void>;
} {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const didInitialCheckRef = useRef(false);

  const check = useCallback(async () => {
    try {
      const info = await tauriInvoke<UpdateInfo>("check_for_update");
      setUpdateInfo(info);
    } catch (err) {
      console.warn("check_for_update failed", err);
      setUpdateInfo(null);
    }
  }, []);

  useEffect(() => {
    if (didInitialCheckRef.current) return;
    didInitialCheckRef.current = true;
    void check();

    const interval = setInterval(() => {
      void check();
    }, VERSION_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [check]);

  return { updateInfo, refresh: check };
}
