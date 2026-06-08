import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { ConfigProvider, Menu } from "antd";
import type { MenuProps } from "antd";
import { LoadingPlaceholder } from "../LoadingPlaceholder";
import type {
  DeleteTarget,
  PipelineUiState,
  PublicSettings,
  SessionArtifactPreview,
  SessionListItem,
  SessionMetaView,
  SummaryPromptView,
} from "../../types";
import { getErrorMessage } from "../../lib/appUtils";
import { tauriInvoke } from "../../lib/tauri";
import { useTodoistTasks } from "../../hooks/useTodoistTasks";
import { SessionCard } from "./SessionCard";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { ArtifactModal } from "./ArtifactModal";
import { SummaryPromptModal } from "./SummaryPromptModal";
import type { SummaryPromptDialogState } from "./SummaryPromptModal";
import { TodoistExportModal } from "./TodoistExportModal";

const INITIAL_VISIBLE = 20;
const PAGE_SIZE = 40;

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
  brainUploadPendingBySession: Record<string, boolean>;
  pipelineStateBySession: Record<string, PipelineUiState>;
  deleteTarget: DeleteTarget | null;
  deletePendingSessionId: string | null;
  audioDeleteTargetSessionId: string | null;
  audioDeletePendingSessionId: string | null;
  isSearching: boolean;
  isInitialLoading: boolean;
  artifactPreview: SessionArtifactPreview | null;
  knownTags: string[];
  settings: PublicSettings | null;
  brainSyncReady: boolean;
  transcriptionProvider: string | null;
  setDeleteTarget: (target: DeleteTarget | null) => void;
  setAudioDeleteTargetSessionId: (sessionId: string | null) => void;
  confirmDeleteSession: () => Promise<void>;
  confirmDeleteAudio: () => Promise<void>;
  closeArtifactPreview: () => void;
  openSessionFolder: (dir: string) => void;
  openSessionArtifact: (sessionId: string, kind: "transcript" | "summary") => void;
  openArtifactInEditor: (sessionId: string, kind: "transcript" | "summary") => Promise<void> | void;
  getText: (sessionId: string) => void;
  getSummary: (sessionId: string) => void;
  saveSessionDetails: (sessionId: string, detail: SessionMetaView) => Promise<boolean>;
  flushSessionDetails: (sessionId: string, detail?: SessionMetaView) => void;
  requestDeleteSession: (sessionId: string, isRecording: boolean) => void;
  requestDeleteAudio: (sessionId: string) => void;
  onUploadToBrain: (sessionId: string) => void;
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
  brainUploadPendingBySession,
  pipelineStateBySession,
  deleteTarget,
  deletePendingSessionId,
  audioDeleteTargetSessionId,
  audioDeletePendingSessionId,
  isSearching,
  isInitialLoading,
  artifactPreview,
  knownTags,
  settings,
  brainSyncReady,
  transcriptionProvider,
  setDeleteTarget,
  setAudioDeleteTargetSessionId,
  confirmDeleteSession,
  confirmDeleteAudio,
  closeArtifactPreview,
  openSessionFolder,
  openSessionArtifact,
  openArtifactInEditor,
  getText,
  getSummary,
  saveSessionDetails,
  flushSessionDetails,
  requestDeleteSession,
  requestDeleteAudio,
  onUploadToBrain,
  setStatus,
}: SessionListProps) {
  const [summaryPromptDialog, setSummaryPromptDialog] = useState<SummaryPromptDialogState | null>(null);
  const [summaryPrompts, setSummaryPrompts] = useState<SummaryPromptView[]>([]);
  const [summaryPromptsLoading, setSummaryPromptsLoading] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuState | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [todoistPendingSessionId, setTodoistPendingSessionId] = useState<string | null>(null);
  const todoistTasks = useTodoistTasks();
  const summaryPromptsRequestIdRef = useRef(0);
  // Cache the default summary prompt fetched from backend so clicking the
  // "Настроить промпт саммари" button is instant on every repeat click
  // (the first one pays one IPC round-trip).
  const cachedDefaultPromptRef = useRef<string | null>(null);

  // Stable reference across renders — a new array on every render would
  // force `Select` (with `options` prop deeply diffed) to rebuild its
  // virtualised list on every keystroke in any card.
  const knownTagOptions = useMemo(
    () => knownTags.map((tag) => ({ value: tag, label: tag })),
    [knownTags],
  );

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
        custom_summary_prompt_name: "",
        topic: item.topic,
        tags: [],
      }
    );
  }

  function sortSummaryPrompts(prompts: SummaryPromptView[]) {
    return [...prompts].sort((left, right) => left.name.localeCompare(right.name));
  }

  async function loadSummaryPrompts(requestId: number) {
    setSummaryPromptsLoading(true);
    try {
      const prompts = await tauriInvoke<SummaryPromptView[]>("list_summary_prompts");
      const sorted = sortSummaryPrompts(prompts);
      if (summaryPromptsRequestIdRef.current !== requestId) return sorted;
      setSummaryPrompts(sorted);
      return sorted;
    } catch (err) {
      if (summaryPromptsRequestIdRef.current === requestId) {
        setStatus(`error: ${getErrorMessage(err)}`);
      }
      return null;
    } finally {
      if (summaryPromptsRequestIdRef.current === requestId) {
        setSummaryPromptsLoading(false);
      }
    }
  }

  async function openSummaryPromptDialog(detail: SessionMetaView) {
    const requestId = summaryPromptsRequestIdRef.current + 1;
    summaryPromptsRequestIdRef.current = requestId;
    const prompts = await loadSummaryPrompts(requestId);
    if (summaryPromptsRequestIdRef.current !== requestId) return;
    if (!prompts) return;
    const promptName = detail.custom_summary_prompt_name?.trim() ?? "";
    const selectedPrompt = promptName
      ? prompts.find((prompt) => prompt.name === promptName)
      : null;

    if (selectedPrompt) {
      setSummaryPromptDialog({
        sessionId: detail.session_id,
        promptName: selectedPrompt.name,
        value: selectedPrompt.prompt,
        saving: false,
      });
      return;
    }

    if (promptName) {
      setStatus(`error: summary_prompt_not_found: ${promptName}`);
      setSummaryPromptDialog({
        sessionId: detail.session_id,
        promptName,
        value: "",
        saving: false,
        notice: "Сохраненный промпт с таким именем не найден. Введите текст, чтобы восстановить его.",
      });
      return;
    }

    const persistedPrompt = detail.custom_summary_prompt?.trim() ?? "";
    if (persistedPrompt) {
      setSummaryPromptDialog({
        sessionId: detail.session_id,
        promptName: "",
        value: detail.custom_summary_prompt ?? "",
        saving: false,
      });
      return;
    }

    // Prefer the prop, then the local cache — both are synchronous and let
    // the modal appear instantly. Only if we have nothing do we fall back to
    // an IPC fetch, and even then we open the modal IMMEDIATELY with an
    // empty value and backfill it asynchronously when the fetch resolves.
    const syncDefault =
      settings?.summary_prompt ?? cachedDefaultPromptRef.current ?? null;
    if (syncDefault !== null) {
      setSummaryPromptDialog({
        sessionId: detail.session_id,
        promptName: "",
        value: syncDefault,
        saving: false,
      });
      return;
    }

    // Open with a placeholder first; fetch in background.
    const sessionId = detail.session_id;
    setSummaryPromptDialog({ sessionId, promptName: "", value: "", saving: false });
    void tauriInvoke<PublicSettings>("get_settings")
      .then((currentSettings) => {
        cachedDefaultPromptRef.current = currentSettings.summary_prompt;
        // Only backfill if the user hasn't closed the dialog or started
        // editing a different session's prompt in the meantime.
        setSummaryPromptDialog((prev) => {
          if (!prev || prev.sessionId !== sessionId) return prev;
          if (prev.value !== "") return prev; // user already typed
          return { ...prev, value: currentSettings.summary_prompt };
        });
      })
      .catch((err) => {
        setStatus(`error: ${getErrorMessage(err)}`);
      });
  }

  async function confirmSummaryPrompt(payload: { name: string; prompt: string }) {
    if (!summaryPromptDialog) return;
    const current = sessionDetails[summaryPromptDialog.sessionId];
    if (!current) {
      setSummaryPromptDialog(null);
      return;
    }

    setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: true } : prev));
    try {
      const existingPrompt = summaryPrompts.find((prompt) => prompt.name === payload.name);
      const promptChanged = existingPrompt?.prompt !== payload.prompt;
      const currentPromptName = current.custom_summary_prompt_name?.trim() ?? "";
      const nextDetail: SessionMetaView = {
        ...current,
        custom_summary_prompt: "",
        custom_summary_prompt_name: payload.name,
      };

      if (existingPrompt && promptChanged && currentPromptName !== payload.name) {
        const saved = await saveSessionDetails(summaryPromptDialog.sessionId, nextDetail);
        if (!saved) {
          setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: false } : prev));
          return;
        }
      }

      const savedPrompt =
        existingPrompt && !promptChanged
          ? existingPrompt
          : await tauriInvoke<SummaryPromptView>("upsert_summary_prompt", {
              payload,
            });
      if (!existingPrompt || promptChanged) {
        setSummaryPrompts((prev) => {
          const next = prev.filter((prompt) => prompt.name !== savedPrompt.name);
          next.push(savedPrompt);
          return sortSummaryPrompts(next);
        });
      }

      if (!(existingPrompt && promptChanged && currentPromptName !== payload.name)) {
        const saved = await saveSessionDetails(summaryPromptDialog.sessionId, {
          ...nextDetail,
          custom_summary_prompt_name: savedPrompt.name,
        });
        if (!saved) {
          setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: false } : prev));
          return;
        }
      }
      setSummaryPromptDialog(null);
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
      setSummaryPromptDialog((prev) => (prev ? { ...prev, saving: false } : prev));
    }
  }

  async function openTodoistExport(sessionId: string) {
    setTodoistPendingSessionId(sessionId);
    try {
      await todoistTasks.openPreview(sessionId);
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
    } finally {
      setTodoistPendingSessionId(null);
    }
  }

  async function addTodoistTasks(taskIds: string[]) {
    const sessionId = todoistTasks.preview?.sessionId;
    if (!sessionId) return;
    try {
      const result = await todoistTasks.enqueueAndSync(sessionId, taskIds);
      setStatus(`todoist_synced: ${result.synced} synced, ${result.failed} failed`);
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
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

  const observerRef = useRef<IntersectionObserver | null>(null);
  const filteredSessionsLengthRef = useRef(filteredSessions.length);
  filteredSessionsLengthRef.current = filteredSessions.length;

  const setSentinelRef = useCallback((node: HTMLDivElement | null) => {
    // Tear down the observer attached to the previous sentinel node (if any).
    // This runs both on unmount (node === null) and on remount with a new
    // node. Stable observer across batch loads avoids a WebKit issue where
    // a freshly-created observer can drop its initial intersection callback.
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((current) => {
            const max = filteredSessionsLengthRef.current;
            if (current >= max) return current;
            return Math.min(current + PAGE_SIZE, max);
          });
        }
      },
      { rootMargin: "2000px" },
    );
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  const isSearchActive = sessionSearchQuery.trim().length > 0;
  const displayedSessions = isSearchActive
    ? filteredSessions
    : filteredSessions.slice(0, visibleCount);

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
      {isInitialLoading ? (
        <LoadingPlaceholder
          className="sessions-grid-loading"
          label="Loading sessions…"
          ariaLabel="Loading sessions"
        />
      ) : isSearching ? (
        <LoadingPlaceholder
          className="sessions-grid-loading"
          label="Searching sessions…"
          ariaLabel="Searching sessions"
        />
      ) : (
        <>
          <div className="sessions-grid">
            {displayedSessions.map((item) => {
              const detail = getSessionDetail(item);
              const textPending = Boolean(textPendingBySession[item.session_id]);
              const summaryPending = Boolean(summaryPendingBySession[item.session_id]);
              const brainUploadPending = Boolean(brainUploadPendingBySession[item.session_id]);
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
                  showNumSpeakers={transcriptionProvider === "nexara"}
                  brainUploadPending={brainUploadPending}
                  brainSyncReady={brainSyncReady}
                  onContextMenu={openSessionContextMenu}
                  onDetailChange={(nextDetail) =>
                    setSessionDetails((prev) => ({ ...prev, [item.session_id]: nextDetail }))
                  }
                  onOpenArtifact={openSessionArtifact}
                  onGetText={getText}
                  onGetSummary={getSummary}
                  onOpenSummaryPrompt={(d) => void openSummaryPromptDialog(d)}
                  onDelete={requestDeleteSession}
                  onDeleteAudio={requestDeleteAudio}
                  onFieldBlur={flushSessionDetails}
                  onOpenFolder={openSessionFolder}
                  onUploadToBrain={onUploadToBrain}
                  onExportTodoist={(sessionId) => void openTodoistExport(sessionId)}
                  todoistPending={todoistPendingSessionId === item.session_id}
                  setStatus={setStatus}
                />
              );
            })}
            {!displayedSessions.length && (
              <div className="sessions-empty-state">
                <div className="sessions-empty-state-title">{emptyStateTitle}</div>
                <div className="sessions-empty-state-copy">{emptyStateCopy}</div>
              </div>
            )}
          </div>
          {!isSearchActive && visibleCount < filteredSessions.length && (
            <div ref={setSentinelRef} className="sessions-load-sentinel" aria-hidden />
          )}
        </>
      )}

      {sessionContextMenu && sessionContextMenuItem && sessionContextMenuDetail && (
        <div
          className="session-context-menu-popup"
          style={{ position: "fixed", left: sessionContextMenu.x, top: sessionContextMenu.y, zIndex: 1050 }}
        >
          <ConfigProvider
            theme={{
              components: {
                Menu: {
                  itemHeight: 28,
                  itemPaddingInline: 12,
                  itemMarginBlock: 0,
                  itemMarginInline: 0,
                  itemBorderRadius: 4,
                  fontSize: 13,
                },
              },
            }}
          >
            <Menu
              aria-label="Действия сессии"
              items={sessionContextMenuItems}
              onClick={({ key }) => runSessionContextMenuItem(String(key))}
              style={{ minWidth: 200, padding: 4, borderRadius: 6 }}
            />
          </ConfigProvider>
        </div>
      )}

      <DeleteConfirmModal
        open={Boolean(deleteTarget)}
        pending={deletePendingSessionId !== null}
        message={
          deleteTarget?.force
            ? "Сессия помечена как активная. Принудительно удалить сессию и все связанные файлы?"
            : "Удалить сессию и все связанные файлы?"
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDeleteSession()}
      />

      <DeleteConfirmModal
        open={Boolean(audioDeleteTargetSessionId)}
        pending={audioDeletePendingSessionId !== null}
        title="Удаление аудио"
        message="Удалить аудио-файл? Сессия останется, но запись будет недоступна для прослушивания."
        onCancel={() => setAudioDeleteTargetSessionId(null)}
        onConfirm={() => void confirmDeleteAudio()}
      />

      <ArtifactModal
        preview={artifactPreview}
        onClose={closeArtifactPreview}
        onOpenInEditor={
          artifactPreview
            ? () => openArtifactInEditor(artifactPreview.sessionId, artifactPreview.artifactKind)
            : undefined
        }
      />

      <SummaryPromptModal
        dialog={summaryPromptDialog}
        prompts={summaryPrompts}
        loadingPrompts={summaryPromptsLoading}
        onCancel={() => setSummaryPromptDialog(null)}
        onConfirm={(payload) => void confirmSummaryPrompt(payload)}
      />

      <TodoistExportModal
        preview={todoistTasks.preview}
        open={Boolean(todoistTasks.preview)}
        syncing={todoistTasks.syncing}
        onCancel={todoistTasks.closePreview}
        onAddSelected={(taskIds) => void addTodoistTasks(taskIds)}
      />
    </>
  );
}
