import { useCallback, useEffect, useState } from "react";
import { tauriInvoke } from "../lib/tauri";
import type { SecretSaveState } from "../types";

export function useTodoistSync(enabled: boolean) {
  const [hasToken, setHasToken] = useState<boolean>(false);
  const [tokenState, setTokenState] = useState<SecretSaveState>("unknown");

  const refreshHasToken = useCallback(async () => {
    try {
      const has = await tauriInvoke<boolean>("todoist_sync_has_token");
      setHasToken(Boolean(has));
    } catch {
      setHasToken(false);
    }
  }, []);

  const saveToken = useCallback(
    async (value: string) => {
      try {
        await tauriInvoke("todoist_sync_set_token", { token: value });
        setTokenState("updated");
        await refreshHasToken();
        return true;
      } catch {
        setTokenState("error");
        return false;
      }
    },
    [refreshHasToken],
  );

  const clearToken = useCallback(async () => {
    try {
      await tauriInvoke("todoist_sync_clear_token");
      setTokenState("unchanged");
      await refreshHasToken();
      return true;
    } catch {
      setTokenState("error");
      return false;
    }
  }, [refreshHasToken]);

  useEffect(() => {
    if (!enabled) return;
    void refreshHasToken();
  }, [enabled, refreshHasToken]);

  return {
    hasToken,
    tokenState,
    refreshHasToken,
    saveToken,
    clearToken,
  };
}

export type UseTodoistSyncReturn = ReturnType<typeof useTodoistSync>;
