import { SecretSaveState } from "../appTypes";

export function formatSecretSaveState(state: SecretSaveState): string {
  if (state === "updated") return "обновлён";
  if (state === "unchanged") return "не изменён";
  if (state === "error") return "ошибка";
  return "";
}

export function normalizeTags(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function splitTags(value: string): string[] {
  return normalizeTags(value.split(","));
}

export function parseEventPayload<T>(event: unknown): T | null {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { payload?: unknown };
  const payload = candidate.payload ?? event;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as T;
    } catch {
      return null;
    }
  }
  if (payload && typeof payload === "object") {
    return payload as T;
  }
  return null;
}

export function getErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

import vscodeIcon from "../assets/editor-icons/vscode.svg";
import cursorIcon from "../assets/editor-icons/cursor.svg";
import sublimeIcon from "../assets/editor-icons/sublime.svg";

export function localIconForEditor(editorName: string): string | null {
  const lowered = editorName.toLowerCase();
  if (lowered.includes("visual studio code") || lowered === "vscode") return vscodeIcon;
  if (lowered.includes("cursor")) return cursorIcon;
  if (lowered.includes("sublime")) return sublimeIcon;
  return null;
}
