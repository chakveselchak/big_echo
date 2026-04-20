import type { ReactNode } from "react";
import type { SessionListItem } from "../types";
import { SecretSaveState } from "../types";

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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderHighlightedText(text: string, query: string): ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;

  const matcher = new RegExp(`(${escapeRegExp(normalizedQuery)})`, "gi");
  return text.split(matcher).map((part, index) => {
    if (part.toLowerCase() === normalizedQuery.toLowerCase()) {
      return <mark key={`m-${index}`}>{part}</mark>;
    }
    return <span key={`t-${index}`}>{part}</span>;
  });
}

export function parseDurationHms(value: string | undefined): number {
  if (typeof value !== "string") return 0;
  const parts = value.split(":").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function extractStartTimeHm(startedAtIso: string): string {
  const match = startedAtIso.match(/T(\d{2}:\d{2})/);
  return match?.[1] ?? "";
}

export function joinSessionAudioPath(sessionDir: string, audioFile: string): string {
  const normalizedDir = sessionDir.trim().replace(/[\\/]+$/, "");
  const normalizedFile = audioFile.trim().replace(/^[\\/]+/, "");
  if (!normalizedDir) return normalizedFile;
  if (normalizedDir.includes("\\")) {
    return `${normalizedDir}\\${normalizedFile.replace(/\//g, "\\")}`;
  }
  return `${normalizedDir}/${normalizedFile.replace(/\\/g, "/")}`;
}

export function resolveSessionAudioPath(item: SessionListItem): string | null {
  const fallbackAudioFile =
    item.audio_format && item.audio_format !== "unknown" ? `audio.${item.audio_format}` : "";
  const audioFile = (item.audio_file ?? fallbackAudioFile).trim();
  if (!audioFile) return null;
  return joinSessionAudioPath(item.session_dir, audioFile);
}

export function pauseAudioElement(audio: HTMLAudioElement | null, force = false): void {
  if (!audio) return;
  if (!force && audio.paused) return;
  try {
    audio.pause();
  } catch {
    // jsdom does not fully implement media playback APIs.
  }
}

export function localIconForEditor(editorName: string): string | null {
  const lowered = editorName.toLowerCase();
  if (lowered.includes("visual studio code") || lowered === "vscode") return vscodeIcon;
  if (lowered.includes("cursor")) return cursorIcon;
  if (lowered.includes("sublime")) return sublimeIcon;
  return null;
}
