import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { tauriInvoke } from "../lib/tauri";
import type {
  SecretSaveState,
  YandexSyncLastRun,
  YandexSyncPreflight,
  YandexSyncProgress,
  YandexSyncStatus,
} from "../types";

const POLL_MS = 2000;
const PROGRESS_EVENT = "yandex-sync-progress";
const PREFLIGHT_EVENT = "yandex-sync-preflight";
const FINISHED_EVENT = "yandex-sync-finished";

export function useYandexSync(enabled: boolean) {
  const [hasToken, setHasToken] = useState<boolean>(false);
  const [tokenState, setTokenState] = useState<SecretSaveState>("unknown");
  const [status, setStatus] = useState<YandexSyncStatus>({ is_running: false, last_run: null });
  const [progress, setProgress] = useState<YandexSyncProgress | null>(null);
  const [preflight, setPreflight] = useState<YandexSyncPreflight | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshHasToken = useCallback(async () => {
    try {
      const has = await tauriInvoke<boolean>("yandex_sync_has_token");
      setHasToken(Boolean(has));
    } catch {
      setHasToken(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await tauriInvoke<YandexSyncStatus>("yandex_sync_status");
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const saveToken = useCallback(
    async (value: string) => {
      try {
        await tauriInvoke("yandex_sync_set_token", { token: value });
        setTokenState("updated");
        await refreshHasToken();
      } catch {
        setTokenState("error");
      }
    },
    [refreshHasToken],
  );

  const clearToken = useCallback(async () => {
    try {
      await tauriInvoke("yandex_sync_clear_token");
      setTokenState("unchanged");
      await refreshHasToken();
    } catch {
      setTokenState("error");
    }
  }, [refreshHasToken]);

  const syncNow = useCallback(async (): Promise<YandexSyncLastRun | null> => {
    try {
      const summary = await tauriInvoke<YandexSyncLastRun>("yandex_sync_now");
      await refreshStatus();
      return summary;
    } catch {
      await refreshStatus();
      return null;
    }
  }, [refreshStatus]);

  useEffect(() => {
    if (!enabled) return;
    void refreshHasToken();
    void refreshStatus();
  }, [enabled, refreshHasToken, refreshStatus]);

  useEffect(() => {
    if (!enabled) return;
    const unlistenPreflight = listen<YandexSyncPreflight>(PREFLIGHT_EVENT, (e) => {
      setPreflight(e.payload);
    });
    const unlistenProgress = listen<YandexSyncProgress>(PROGRESS_EVENT, (e) => {
      setProgress(e.payload);
    });
    const unlistenFinished = listen<YandexSyncLastRun>(FINISHED_EVENT, (e) => {
      setProgress(null);
      setPreflight(null);
      setStatus({ is_running: false, last_run: e.payload });
    });
    return () => {
      void unlistenPreflight.then((fn) => fn());
      void unlistenProgress.then((fn) => fn());
      void unlistenFinished.then((fn) => fn());
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (status.is_running) {
      pollTimer.current = setInterval(() => {
        void refreshStatus();
      }, POLL_MS);
      return () => {
        if (pollTimer.current) clearInterval(pollTimer.current);
        pollTimer.current = null;
      };
    }
    return;
  }, [enabled, status.is_running, refreshStatus]);

  return {
    hasToken,
    tokenState,
    status,
    progress,
    preflight,
    refreshHasToken,
    refreshStatus,
    saveToken,
    clearToken,
    syncNow,
  };
}

export type UseYandexSyncReturn = ReturnType<typeof useYandexSync>;
