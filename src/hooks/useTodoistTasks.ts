import { useCallback, useState } from "react";
import { tauriInvoke } from "../lib/tauri";
import type { TodoistTaskPreview, TodoistTaskSyncResult } from "../types";

export function useTodoistTasks() {
  const [preview, setPreview] = useState<TodoistTaskPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const openPreview = useCallback(async (sessionId: string) => {
    setLoading(true);
    try {
      const nextPreview = await tauriInvoke<TodoistTaskPreview>("preview_todoist_tasks", {
        sessionId,
      });
      setPreview(nextPreview);
      return nextPreview;
    } finally {
      setLoading(false);
    }
  }, []);

  const closePreview = useCallback(() => {
    setPreview(null);
  }, []);

  const enqueueAndSync = useCallback(async (sessionId: string, taskIds: string[]) => {
    setSyncing(true);
    try {
      await tauriInvoke("enqueue_todoist_tasks", {
        sessionId,
        taskIds,
      });
      const result = await tauriInvoke<TodoistTaskSyncResult>("sync_todoist_tasks", {
        sessionId,
      });
      const refreshedPreview = await tauriInvoke<TodoistTaskPreview>("preview_todoist_tasks", {
        sessionId,
      });
      setPreview(refreshedPreview);
      return result;
    } finally {
      setSyncing(false);
    }
  }, []);

  return {
    preview,
    loading,
    syncing,
    openPreview,
    closePreview,
    enqueueAndSync,
  };
}

export type UseTodoistTasksReturn = ReturnType<typeof useTodoistTasks>;
