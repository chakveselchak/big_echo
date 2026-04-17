import React, { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Menu } from "antd";
import type { MenuProps } from "antd";
import type {
  DeleteTarget,
  PipelineUiState,
  PublicSettings,
  SessionArtifactPreview,
  SessionListItem,
  SessionMetaView,
} from "../../types";
import { getErrorMessage } from "../../lib/appUtils";
import { tauriInvoke } from "../../lib/tauri";
import { SessionCard } from "./SessionCard";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { ArtifactModal } from "./ArtifactModal";
import { SummaryPromptModal } from "./SummaryPromptModal";
import type { SummaryPromptDialogState } from "./SummaryPromptModal";

type SessionContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
};

type SessionListProps = {
  sessions: SessionListItem[];
  filteredSessions: SessionListItem[];
  sessionDetails: Record<string, SessionMetaView>;
  setSessionDetails: React.Dispatch<React.SetStateAction<Record<string, SessionMetaView>>>;
  sessionSearchQuery: string;
  sessionArtifactSearchHits: Record<string, { transcript_match?: boolean; summary_match?: boolean }>;
  textPendingBySession: Record<string, boolean>;
  summaryPendingBySession: Record<string, boolean>;
  pipelineStateBySession: Record<string, PipelineUiState>;
  deleteTarget: DeleteTarget | null;
  deletePendingSessionId: string | null;
  artifactPreview: SessionArtifactPreview | null;
  knownTags: string[];
  settings: PublicSettings | null;
  setDeleteTarget: (target: DeleteTarget | null) => void;
  confirmDeleteSession: () => Promise<void>;
  closeArtifactPreview: () => void;
  openSessionFolder: (dir: string) => void;
  openSessionArtifact: (sessionId: string, kind: "transcript" | "summary") => void;
  getText: (sessionId: string) => void;
  getSummary: (sessionId: string) => void;
  saveSessionDetails: (sessionId: string, detail: SessionMetaView) => Promise<boolean>;
  requestDeleteSession: (sessionId: string, isRecording: boolean) => void;
  setStatus: (status: string) => void;
};

export function SessionList({
  sessions,
  filteredSessions,
  sessionDetails,
  setSessionDetails,
  sessionSearchQuery,
  sessionArtifactSearchHits,
  textPendingBySession,
  summaryPendingBySession,
  pipelineStateBySession,
  deleteTarget,
  deletePendingSessionId,
  artifactPreview,
  knownTags,
  settings,
  setDeleteTarget,
  confirmDeleteSession,
  closeArtifactPreview,
  openSessionFolder,
  openSessionArtifact,
  getText,
  getSummary,
  saveSessionDetails,
  requestDeleteSession,
  setStatus,
}: SessionListProps) {
  const [summaryPromptDialog, setSummaryPromptDialog] = useState<SummaryPromptDialogState | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuState | null>(null);

  const knownTagOptions = knownTags.map((tag) => ({ value: tag, label: tag }));

  const hasSessions = sessions.length > 0;
  const normalizedSessionSearchQuery = sessionSearchQuery.trim();
  const hasSessionSearchQuery = normalizedSessionSearchQuery.length > 0;
  const emptyStateTitle = hasSessions
    ? hasSessionSearchQuery
      ? `No results for "${normalizedSessionSearchQuery}"`
      : "No matching sessions"
    : "No sessions yet";
  const emptyStateCopy = hasSessions
    ? hasSessionSearchQuery
      ? "Try a different search or clear the query to see all sessions."
      : "No sessions matched the current filters."
    : "New recordings will appear here with search, transcript, summary, and audio actions.";

  function getSessionDetail(item: SessionListItem): SessionMetaView {
    return (
      sessionDetails[item.session_id] ?? {
        session_id: item.session_id,
        source: item.primary_tag,
        notes: "",
        custom_summary_prompt: "",
        topic: item.topic,
        tags: [],
      }
    );
  }

  async function openSummaryPromptDialog(detail: SessionMetaView) {
    const persistedPrompt = detail.custom_summary_prompt?.trim() ?? "";
    if (persistedPrompt) {
      setSummaryPromptDialog({
        sessionId: detail.session_id,
        value: detail.custom_summary_prompt ?? "",
        saving: false,
      });
      return;
    }

    let defaultPrompt = settings?.summary_prompt ?? "";
    if (!settings) {
      try {
        const currentSettings = await tauriInvoke<PublicSettings>("get_settings");
        defaultPrompt = currentSettings.summary_prompt;
      } catch (err) {
        setStatus(`error: ${getErrorMessage(err)}`);
      }
    }

    setSummaryPromptDialog({
      sessionId: detail.session_id,
      value: defaultPrompt,
      saving: false,
    });
  }

  async function confirmSummaryPrompt() {
    if (!summaryPromptDialog) return;
    const current = sessionDetails[summaryPromptDialog.sessionId];
    if (!current) {
      setSummaryPromptDialog(null);
      return;
    }

    const nextDetail: SessionMetaView = {
      ...current,
      custom_summary_prompt: summaryPromptDialog.value,
    };
    setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: true } : prev));
    const saved = await saveSessionDetails(summaryPromptDialog.sessionId, nextDetail);
    if (saved) {
      setSummaryPromptDialog(null);
    } else {
      setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: false } : prev));
    }
  }

  function openSessionContextMenu(event: ReactMouseEvent<HTMLElement>, sessionId: string) {
    event.preventDefault();
    const menuWidth = 248;
    const menuHeight = 300;
    const viewportWidth = window.innerWidth || event.clientX + menuWidth;
    const viewportHeight = window.innerHeight || event.clientY + menuHeight;

    setSessionContextMenu({
      sessionId,
      x: Math.max(8, Math.min(event.clientX, viewportWidth - menuWidth)),
      y: Math.max(8, Math.min(event.clientY, viewportHeight - menuHeight)),
    });
  }

  useEffect(() => {
    if (!sessionContextMenu) return;

    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".session-context-menu-popup")) return;
      setSessionContextMenu(null);
    };
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSessionContextMenu(null);
      }
    };
    const onWindowScroll = () => setSessionContextMenu(null);

    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    window.addEventListener("scroll", onWindowScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
      window.removeEventListener("scroll", onWindowScroll, true);
    };
  }, [sessionContextMenu]);

  const sessionContextMenuItem = sessionContextMenu
    ? filteredSessions.find((item) => item.session_id === sessionContextMenu.sessionId)
    : null;
  const sessionContextMenuDetail = sessionContextMenuItem ? getSessionDetail(sessionContextMenuItem) : null;
  const sessionContextMenuTextPending = sessionContextMenuItem
    ? Boolean(textPendingBySession[sessionContextMenuItem.session_id])
    : false;
  const sessionContextMenuSummaryPending = sessionContextMenuItem
    ? Boolean(summaryPendingBySession[sessionContextMenuItem.session_id])
    : false;

  const sessionContextMenuLabel = (key: string, label: string) => (
    <span className="session-context-menu-label" data-session-context-menu-label={key}>
      {label}
    </span>
  );

  const sessionContextMenuItems: MenuProps["items"] = sessionContextMenuItem
    ? [
        {
          key: "folder",
          label: sessionContextMenuLabel("folder", "Открыть папку сессии"),
        },
        ...(sessionContextMenuItem.has_transcript_text
          ? [
              {
                key: "open-text",
                label: sessionContextMenuLabel("open-text", "Открыть текст"),
              },
            ]
          : []),
        ...(sessionContextMenuItem.has_summary_text
          ? [
              {
                key: "open-summary",
                label: sessionContextMenuLabel("open-summary", "Открыть саммари"),
              },
            ]
          : []),
        {
          key: "text",
          label: sessionContextMenuLabel("text", "Сгенерировать текст"),
          disabled:
            sessionContextMenuItem.status === "recording" ||
            sessionContextMenuTextPending ||
            sessionContextMenuSummaryPending,
        },
        {
          key: "summary",
          label: sessionContextMenuLabel("summary", "Сгенерировать саммари"),
          disabled:
            sessionContextMenuItem.status === "recording" ||
            !sessionContextMenuItem.has_transcript_text ||
            sessionContextMenuSummaryPending ||
            sessionContextMenuTextPending,
        },
        {
          key: "prompt",
          label: sessionContextMenuLabel("prompt", "Настроить промпт саммари"),
        },
        {
          key: "delete",
          label: sessionContextMenuLabel("delete", "Удалить"),
          danger: true,
        },
      ]
    : [];

  function runSessionContextMenuItem(key: string) {
    if (!sessionContextMenuItem) return;
    setSessionContextMenu(null);
    if (key === "folder") {
      void openSessionFolder(sessionContextMenuItem.session_dir);
    } else if (key === "open-text") {
      void openSessionArtifact(sessionContextMenuItem.session_id, "transcript");
    } else if (key === "open-summary") {
      void openSessionArtifact(sessionContextMenuItem.session_id, "summary");
    } else if (key === "text") {
      void getText(sessionContextMenuItem.session_id);
    } else if (key === "summary") {
      void getSummary(sessionContextMenuItem.session_id);
    } else if (key === "prompt" && sessionContextMenuDetail) {
      void openSummaryPromptDialog(sessionContextMenuDetail);
    } else if (key === "delete") {
      requestDeleteSession(sessionContextMenuItem.session_id, sessionContextMenuItem.status === "recording");
    }
  }

  return (
    <>
      <div className="sessions-grid">
        {filteredSessions.map((item) => {
          const detail = getSessionDetail(item);
          const textPending = Boolean(textPendingBySession[item.session_id]);
          const summaryPending = Boolean(summaryPendingBySession[item.session_id]);
          const pipelineState = pipelineStateBySession[item.session_id];
          const query = sessionSearchQuery.trim().toLowerCase();
          const artifactHit = sessionArtifactSearchHits[item.session_id];
          const transcriptMatch = query !== "" && Boolean(artifactHit?.transcript_match);
          const summaryMatch = query !== "" && Boolean(artifactHit?.summary_match);

          return (
            <SessionCard
              key={item.session_id}
              item={item}
              detail={detail}
              textPending={textPending}
              summaryPending={summaryPending}
              pipelineState={pipelineState}
              searchQuery={sessionSearchQuery}
              knownTagOptions={knownTagOptions}
              transcriptMatch={transcriptMatch}
              summaryMatch={summaryMatch}
              onContextMenu={openSessionContextMenu}
              onDetailChange={(nextDetail) =>
                setSessionDetails((prev) => ({ ...prev, [item.session_id]: nextDetail }))
              }
              onOpenArtifact={openSessionArtifact}
              onGetText={getText}
              onGetSummary={getSummary}
              onOpenSummaryPrompt={(d) => void openSummaryPromptDialog(d)}
              onDelete={requestDeleteSession}
              onOpenFolder={openSessionFolder}
              setStatus={setStatus}
            />
          );
        })}
        {!filteredSessions.length && (
          <div className="sessions-empty-state">
            <div className="sessions-empty-state-title">{emptyStateTitle}</div>
            <div className="sessions-empty-state-copy">{emptyStateCopy}</div>
          </div>
        )}
      </div>

      {sessionContextMenu && sessionContextMenuItem && sessionContextMenuDetail && (
        <div
          className="session-context-menu-popup"
          style={{ position: "fixed", left: sessionContextMenu.x, top: sessionContextMenu.y, zIndex: 1050 }}
        >
          <Menu
            aria-label="Действия сессии"
            items={sessionContextMenuItems}
            onClick={({ key }) => runSessionContextMenuItem(String(key))}
          />
        </div>
      )}

      <DeleteConfirmModal
        deleteTarget={deleteTarget}
        deletePendingSessionId={deletePendingSessionId}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDeleteSession()}
      />

      <ArtifactModal
        preview={artifactPreview}
        onClose={closeArtifactPreview}
      />

      <SummaryPromptModal
        dialog={summaryPromptDialog}
        onCancel={() => setSummaryPromptDialog(null)}
        onConfirm={() => void confirmSummaryPrompt()}
        onChange={(value) =>
          setSummaryPromptDialog((prev) => (prev ? { ...prev, value } : prev))
        }
      />
    </>
  );
}
