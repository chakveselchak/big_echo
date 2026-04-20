import { useCallback, useEffect, useRef, useState } from "react";
import { tauriInvoke } from "../lib/tauri";
import type { UpdateInfo } from "../types";

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
  }, [check]);

  return { updateInfo, refresh: check };
}
