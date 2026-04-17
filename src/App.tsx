import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Button,
  Dropdown,
  Input,
  InputNumber,
  Menu,
  Modal,
  Select,
  Slider,
  Switch,
  Tabs,
  type InputRef,
  type MenuProps,
} from "antd";
import {
  audioFormatOptions,
  fixedSources,
  diarizationSettingOptions,
  PublicSettings,
  SessionListItem,
  saluteSpeechRecognitionModelOptions,
  saluteSpeechScopeOptions,
  SessionMetaView,
  SettingsTab,
  StartResponse,
  transcriptionProviderOptions,
  transcriptionTaskOptions,
} from "./types";
import { TrayAudioRow } from "./features/recording/TrayAudioRow";
import { TrayPage } from "./pages/TrayPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useRecordingController } from "./hooks/useRecordingController";
import { useSessions } from "./hooks/useSessions";
import { useSettingsForm } from "./hooks/useSettingsForm";
import { initializeAnalytics } from "./lib/analytics";
import { formatSecretSaveState, getErrorMessage } from "./lib/appUtils";
import { getCurrentWindowLabel, tauriConvertFileSrc, tauriInvoke } from "./lib/tauri";
import { formatAppStatus, formatSessionStatus } from "./lib/status";
import vscodeIcon from "./assets/editor-icons/vscode.svg";
import cursorIcon from "./assets/editor-icons/cursor.svg";
import sublimeIcon from "./assets/editor-icons/sublime.svg";
const currentWindowLabel = getCurrentWindowLabel();
const isSettingsWindow = currentWindowLabel === "settings";
const isTrayWindow = currentWindowLabel === "tray";
const openerUiFallback = [
  { id: "TextEdit", name: "TextEdit", icon_fallback: "📝", icon_data_url: null },
  { id: "Visual Studio Code", name: "Visual Studio Code", icon_fallback: "💠", icon_data_url: null },
  { id: "Sublime Text", name: "Sublime Text", icon_fallback: "🟧", icon_data_url: null },
  { id: "Cursor", name: "Cursor", icon_fallback: "🧩", icon_data_url: null },
  { id: "Windsurf", name: "Windsurf", icon_fallback: "🧩", icon_data_url: null },
  { id: "Zed", name: "Zed", icon_fallback: "🧩", icon_data_url: null },
] as const;

type MainTab = "sessions" | "settings";
type SummaryPromptDialogState = {
  sessionId: string;
  value: string;
  saving: boolean;
};
type SessionContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
};

function localIconForEditor(editorName: string): string | null {
  const lowered = editorName.toLowerCase();
  if (lowered.includes("visual studio code") || lowered === "vscode") return vscodeIcon;
  if (lowered.includes("cursor")) return cursorIcon;
  if (lowered.includes("sublime")) return sublimeIcon;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedText(text: string, query: string) {
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

function parseDurationHms(value: string | undefined): number {
  if (typeof value !== "string") return 0;
  const parts = value.split(":").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function extractStartTimeHm(startedAtIso: string): string {
  const match = startedAtIso.match(/T(\d{2}:\d{2})/);
  return match?.[1] ?? "";
}

function joinSessionAudioPath(sessionDir: string, audioFile: string): string {
  const normalizedDir = sessionDir.trim().replace(/[\\/]+$/, "");
  const normalizedFile = audioFile.trim().replace(/^[\\/]+/, "");
  if (!normalizedDir) return normalizedFile;
  if (normalizedDir.includes("\\")) {
    return `${normalizedDir}\\${normalizedFile.replace(/\//g, "\\")}`;
  }
  return `${normalizedDir}/${normalizedFile.replace(/\\/g, "/")}`;
}

function resolveSessionAudioPath(item: SessionListItem): string | null {
  const fallbackAudioFile =
    item.audio_format && item.audio_format !== "unknown" ? `audio.${item.audio_format}` : "";
  const audioFile = (item.audio_file ?? fallbackAudioFile).trim();
  if (!audioFile) return null;
  return joinSessionAudioPath(item.session_dir, audioFile);
}

function pauseAudioElement(audio: HTMLAudioElement | null, force = false) {
  if (!audio) return;
  if (!force && audio.paused) return;
  try {
    audio.pause();
  } catch {
    // jsdom does not fully implement media playback APIs.
  }
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
}

function SessionAudioPlayer({
  item,
  setStatus,
}: {
  item: SessionListItem;
  setStatus: (status: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioPath = resolveSessionAudioPath(item);
  const audioSrc = audioPath ? tauriConvertFileSrc(audioPath) : "";
  const fallbackDuration = parseDurationHms(item.audio_duration_hms);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(fallbackDuration);
  const isDisabled = !audioSrc || item.status === "recording";

  useEffect(() => {
    setIsPlaying(false);
    setProgressPercent(0);
    setDurationSeconds(fallbackDuration);
    if (!audioRef.current) return;
    pauseAudioElement(audioRef.current);
    audioRef.current.currentTime = 0;
  }, [audioSrc, fallbackDuration]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      pauseAudioElement(audio);
    };
  }, []);

  function syncProgressFromAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    const nextDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration;
    const nextTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    setDurationSeconds(nextDuration);
    setProgressPercent(nextDuration > 0 ? Math.min(100, (nextTime / nextDuration) * 100) : 0);
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || isDisabled) return;
    try {
      if (!isPlaying) {
        await audio.play();
      } else {
        pauseAudioElement(audio, true);
      }
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
    }
  }

  function handleSeek(nextPercent: number) {
    const audio = audioRef.current;
    setProgressPercent(nextPercent);
    if (!audio) return;
    const effectiveDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationSeconds;
    if (effectiveDuration <= 0) return;
    audio.currentTime = (nextPercent / 100) * effectiveDuration;
  }

  return (
    <div className={`session-audio-player${isDisabled ? " is-disabled" : ""}`}>
      <Button
        htmlType="button"
        className="session-audio-toggle"
        aria-label={isPlaying ? "Пауза" : "Воспроизвести аудио"}
        onClick={() => void togglePlayback()}
        disabled={isDisabled}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          {isPlaying ? (
            <>
              <line x1="6.5" y1="4.5" x2="6.5" y2="15.5" />
              <line x1="13.5" y1="4.5" x2="13.5" y2="15.5" />
            </>
          ) : (
            <path d="M6 4.5 14.5 10 6 15.5Z" />
          )}
        </svg>
      </Button>
      <Slider
        className="session-audio-slider"
        min={0}
        max={100}
        step={1}
        aria-label="Позиция аудио"
        {...({ ariaLabelForHandle: "Позиция аудио" } as { ariaLabelForHandle: string })}
        value={Math.round(progressPercent)}
        tooltip={{ open: false }}
        onChange={(value) => handleSeek(Number(value))}
        disabled={isDisabled || durationSeconds <= 0}
      />
      <audio
        data-session-id={item.session_id}
        ref={audioRef}
        src={audioSrc || undefined}
        preload="metadata"
        onLoadedMetadata={syncProgressFromAudio}
        onTimeUpdate={syncProgressFromAudio}
        onEnded={() => {
          setIsPlaying(false);
          setProgressPercent(100);
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />
    </div>
  );
}

export function App() {
  const [mainTab, setMainTab] = useState<MainTab>("sessions");
  const [topic, setTopic] = useState("");
  const [tagsInput] = useState("");
  const [source, setSource] = useState("slack");
  const [notesInput] = useState("");
  const [session, setSession] = useState<StartResponse | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [trayMuteError, setTrayMuteError] = useState<string | null>(null);
  const appMainRef = useRef<HTMLElement | null>(null);
  const sessionSearchInputRef = useRef<InputRef | null>(null);
  const artifactPreviewBodyRef = useRef<HTMLPreElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteCancelButtonRef = useRef<HTMLElement | null>(null);
  const deleteConfirmButtonRef = useRef<HTMLElement | null>(null);
  const artifactDialogRef = useRef<HTMLDivElement | null>(null);
  const summaryPromptDialogRef = useRef<HTMLDivElement | null>(null);
  const sessionContextMenuRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasDialogOpenRef = useRef(false);
  const loadSessionsRef = useRef<(() => Promise<void>) | null>(null);
  const [summaryPromptDialog, setSummaryPromptDialog] = useState<SummaryPromptDialogState | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuState | null>(null);
  const [refreshAnimationCount, setRefreshAnimationCount] = useState(0);
  const shouldLoadSettings = isTrayWindow || isSettingsWindow || mainTab === "settings";
  const {
    audioDevices,
    autoDetectSystemSource,
    canSaveSettings,
    macosSystemAudioPermission,
    macosSystemAudioPermissionLoadState,
    nexaraKey,
    nexaraSecretState,
    openaiKey,
    openaiSecretState,
    openMacosSystemAudioSettings,
    pickRecordingRoot,
    salutSpeechAuthKey,
    salutSpeechSecretState,
    saveApiKeys,
    saveSettings,
    saveSettingsPatch,
    savedSettingsSnapshot,
    setNexaraKey,
    setNexaraSecretState,
    setOpenaiKey,
    setOpenaiSecretState,
    setSalutSpeechAuthKey,
    setSalutSpeechSecretState,
    setSettings,
    setSettingsTab,
    settings,
    settingsErrors,
    settingsTab,
    textEditorApps,
  } = useSettingsForm({ enabled: shouldLoadSettings, isTrayWindow, setStatus });
  const openerOptions = textEditorApps.length > 0 ? textEditorApps : openerUiFallback;
  const openerMenuOptions = [
    { id: "", name: "System default", icon_fallback: "", icon_data_url: null },
    ...openerOptions,
  ];
  const {
    artifactPreview,
    closeArtifactPreview,
    confirmDeleteSession,
    deletePendingSessionId,
    deleteTarget,
    filteredSessions,
    getSummary,
    getText,
    importAudioSession,
    knownTags,
    loadSessions,
    openSessionFolder,
    openSessionArtifact,
    pipelineStateBySession,
    requestDeleteSession,
    saveSessionDetails,
    sessionArtifactSearchHits,
    sessionDetails,
    sessionSearchQuery,
    sessions,
    setDeleteTarget,
    setSessionDetails,
    setSessionSearchQuery,
    summaryPendingBySession,
    textPendingBySession,
  } = useSessions({ setStatus, lastSessionId, setLastSessionId });
  const fixedSourceOptions = fixedSources.map((s) => ({ value: s, label: s }));
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
  const { liveLevels, muteState, start, startFromTray, stop, toggleInputMuted } = useRecordingController({
    enableTrayCommandListeners: !isSettingsWindow && !isTrayWindow,
    isSettingsWindow,
    isTrayWindow,
    topic,
    setTopic,
    tagsInput,
    source,
    setSource,
    notesInput,
    session,
    setSession,
    lastSessionId,
    setLastSessionId,
    status,
    setStatus,
    loadSessions,
  });

  useEffect(() => {
    initializeAnalytics({ window_label: currentWindowLabel });
  }, []);

  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  }, [loadSessions]);

  useEffect(() => {
    if (!isTrayWindow) return;
    document.body.classList.add("tray-window-body");
    document.documentElement.classList.add("tray-window-html");
    return () => {
      document.body.classList.remove("tray-window-body");
      document.documentElement.classList.remove("tray-window-html");
    };
  }, []);

  useEffect(() => {
    if (isTrayWindow || isSettingsWindow) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const searchInput = sessionSearchInputRef.current?.input;
      searchInput?.focus();
      searchInput?.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!artifactPreview) return;
    const firstMatch = artifactPreviewBodyRef.current?.querySelector("mark");
    if (!(firstMatch instanceof HTMLElement) || typeof firstMatch.scrollIntoView !== "function") return;
    firstMatch.scrollIntoView({ block: "center" });
  }, [artifactPreview]);

  useEffect(() => {
    const isDialogOpen = Boolean(deleteTarget || artifactPreview || summaryPromptDialog);
    const dialogRef = deleteTarget
      ? deleteDialogRef
      : artifactPreview
        ? artifactDialogRef
        : summaryPromptDialog
          ? summaryPromptDialogRef
          : null;
    const dialogElement = dialogRef ? dialogRef.current : null;

    if (isDialogOpen && !wasDialogOpenRef.current) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const focusables = getFocusableElements(dialogElement);
      (focusables[0] ?? dialogElement)?.focus();
    }

    if (!isDialogOpen && wasDialogOpenRef.current) {
      if (restoreFocusRef.current && document.contains(restoreFocusRef.current)) {
        restoreFocusRef.current.focus();
      } else {
        const searchInputElement = sessionSearchInputRef.current?.input ?? null;
        const fallbackFocusTarget =
          searchInputElement && document.contains(searchInputElement)
            ? searchInputElement
            : getFocusableElements(appMainRef.current)[0] ?? appMainRef.current;
        fallbackFocusTarget?.focus();
      }
      restoreFocusRef.current = null;
    }

    wasDialogOpenRef.current = isDialogOpen;
  }, [artifactPreview, deleteTarget, summaryPromptDialog]);

  useEffect(() => {
    if (!sessionContextMenu) return;

    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && sessionContextMenuRef.current?.contains(target)) return;
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

  async function openSummaryPromptDialogForSession(detail: SessionMetaView) {
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

  async function confirmSummaryPromptDialog() {
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

  function refreshSessions() {
    setRefreshAnimationCount((count) => count + 1);
    void loadSessions();
  }

  function handleDeleteDialogKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "Tab") return;
    const cancelButton = deleteCancelButtonRef.current;
    const deleteButton = deleteConfirmButtonRef.current;
    if (!cancelButton || !deleteButton) return;
    if (event.shiftKey && document.activeElement === cancelButton) {
      event.preventDefault();
      deleteButton.focus();
    } else if (!event.shiftKey && document.activeElement === deleteButton) {
      event.preventDefault();
      cancelButton.focus();
    }
  }

  useEffect(() => {
    if (isTrayWindow || isSettingsWindow || mainTab !== "sessions") return;
    loadSessionsRef.current?.().catch((err) => {
      setStatus(`error: ${String(err)}`);
    });
  }, [isSettingsWindow, isTrayWindow, mainTab]);

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
      void openSummaryPromptDialogForSession(sessionContextMenuDetail);
    } else if (key === "delete") {
      requestDeleteSession(sessionContextMenuItem.session_id, sessionContextMenuItem.status === "recording");
    }
  }

  function renderSettingsFields() {
    if (!settings) return null;
    const isOpusFormat = settings.audio_format === "opus";
    const isNexaraProvider = settings.transcription_provider === "nexara";
    const openerOptions = textEditorApps.length > 0 ? textEditorApps : openerUiFallback;
    const artifactOpenerLabelId = "artifact-opener-label";
    const snapshot = savedSettingsSnapshot;
    const isDirty = (field: keyof PublicSettings) => Boolean(snapshot && settings[field] !== snapshot[field]);
    const isMacosPermissionLoading = macosSystemAudioPermissionLoadState === "loading";
    const isMacosPermissionLookupFailed = macosSystemAudioPermissionLoadState === "error";
    const isMacosPermissionUnsupported =
      macosSystemAudioPermissionLoadState === "ready" && macosSystemAudioPermission?.kind === "unsupported";
    const dirtyByTab: Record<SettingsTab, boolean> = {
      audiototext:
        isDirty("transcription_provider") ||
        isDirty("transcription_url") ||
        isDirty("transcription_task") ||
        isDirty("transcription_diarization_setting") ||
        isDirty("salute_speech_scope") ||
        isDirty("salute_speech_model") ||
        isDirty("salute_speech_language") ||
        isDirty("salute_speech_sample_rate") ||
        isDirty("salute_speech_channels_count") ||
        isDirty("summary_url") ||
        isDirty("summary_prompt") ||
        isDirty("openai_model") ||
        nexaraKey.trim().length > 0 ||
        salutSpeechAuthKey.trim().length > 0 ||
        openaiKey.trim().length > 0,
      generals:
        isDirty("recording_root") ||
        isDirty("artifact_open_app") ||
        isDirty("auto_run_pipeline_on_stop") ||
        isDirty("api_call_logging_enabled"),
      audio:
        isDirty("audio_format") ||
        isDirty("opus_bitrate_kbps") ||
        isDirty("mic_device_name") ||
        isDirty("system_device_name"),
    };
    const tabButtons: Array<{ id: SettingsTab; label: string }> = [
      { id: "generals", label: "Generals" },
      { id: "audiototext", label: "AudioToText" },
      { id: "audio", label: "Audio" },
    ];
    const settingsTabItems = tabButtons.map((tab) => ({
      key: tab.id,
      label: (
        <>
          {tab.label}
          {dirtyByTab[tab.id] && <span className="settings-tab-dirty-dot" aria-hidden="true" />}
        </>
      ),
    }));

    return (
      <div className="settings-tabs settings-layout">
        <Tabs
          className="settings-tab-list"
          activeKey={settingsTab}
          aria-label="Settings sections"
          items={settingsTabItems}
          onChange={(key) => setSettingsTab(key as SettingsTab)}
        />

        <div className="settings-tab-panel" role="tabpanel">
          {settingsTab === "audiototext" && (
            <div className="settings-subsections">
              <section className="settings-subsection">
                <h3>Транскрибация</h3>
                <div className="settings-tab-grid">
                  <label className="field">
                    Transcription provider
                    <Select
                      aria-label="Transcription provider"
                      value={settings.transcription_provider}
                      options={transcriptionProviderOptions.map((value) => ({
                        value,
                        label: value === "nexara" ? "nexara" : "SalutSpeechAPI",
                      }))}
                      onChange={(value) => setSettings({ ...settings, transcription_provider: value })}
                    />
                  </label>
                  {isNexaraProvider ? (
                    <>
                      <label className="field">
                        Transcription URL
                        <Input
                          value={settings.transcription_url}
                          onChange={(e) => setSettings({ ...settings, transcription_url: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        Task
                        <Select
                          aria-label="Task"
                          value={settings.transcription_task}
                          options={transcriptionTaskOptions.map((value) => ({ value, label: value }))}
                          onChange={(value) => setSettings({ ...settings, transcription_task: value })}
                        />
                      </label>
                      <label className="field">
                        Diarization setting
                        <Select
                          aria-label="Diarization setting"
                          value={settings.transcription_diarization_setting}
                          options={diarizationSettingOptions.map((value) => ({ value, label: value }))}
                          onChange={(value) => setSettings({ ...settings, transcription_diarization_setting: value })}
                        />
                      </label>
                      <label className="field">
                        Nexara API key
                        <Input.Password
                          value={nexaraKey}
                          onChange={(e) => {
                            setNexaraKey(e.target.value);
                            setNexaraSecretState("unknown");
                          }}
                          placeholder="Stored in OS secure storage"
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="field">
                        Scope
                        <Select
                          aria-label="Scope"
                          value={settings.salute_speech_scope}
                          virtual={false}
                          options={saluteSpeechScopeOptions.map((value) => ({ value, label: value }))}
                          onChange={(value) => setSettings({ ...settings, salute_speech_scope: value })}
                        />
                      </label>
                      <label className="field">
                        Recognition model
                        <Select
                          aria-label="Recognition model"
                          value={settings.salute_speech_model}
                          virtual={false}
                          options={saluteSpeechRecognitionModelOptions.map((value) => ({ value, label: value }))}
                          onChange={(value) => setSettings({ ...settings, salute_speech_model: value })}
                        />
                      </label>
                      <label className="field">
                        Language
                        <Input
                          value={settings.salute_speech_language}
                          onChange={(e) => setSettings({ ...settings, salute_speech_language: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        Sample rate
                        <InputNumber
                          aria-label="Sample rate"
                          value={settings.salute_speech_sample_rate}
                          onChange={(value) =>
                            setSettings({ ...settings, salute_speech_sample_rate: Number(value) || 0 })
                          }
                        />
                      </label>
                      <label className="field">
                        Channels count
                        <InputNumber
                          aria-label="Channels count"
                          value={settings.salute_speech_channels_count}
                          onChange={(value) =>
                            setSettings({
                              ...settings,
                              salute_speech_channels_count: Number(value) || 0,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        SalutSpeech authorization key
                        <Input.Password
                          value={salutSpeechAuthKey}
                          onChange={(e) => {
                            setSalutSpeechAuthKey(e.target.value);
                            setSalutSpeechSecretState("unknown");
                          }}
                          placeholder="Stored in OS secure storage"
                        />
                      </label>
                    </>
                  )}
                </div>
              </section>

              <section className="settings-subsection">
                <h3>Саммари</h3>
                <div className="settings-tab-grid">
                  <label className="field">
                    Summary URL
                    <Input
                      value={settings.summary_url}
                      onChange={(e) => setSettings({ ...settings, summary_url: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    Summary prompt
                    <Input.TextArea
                      value={settings.summary_prompt}
                      onChange={(e) => setSettings({ ...settings, summary_prompt: e.target.value })}
                      rows={4}
                    />
                  </label>
                  <label className="field">
                    OpenAI model
                    <Input
                      value={settings.openai_model}
                      onChange={(e) => setSettings({ ...settings, openai_model: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    OpenAI API key
                    <Input.Password
                      value={openaiKey}
                      onChange={(e) => {
                        setOpenaiKey(e.target.value);
                        setOpenaiSecretState("unknown");
                      }}
                      placeholder="Stored in OS secure storage"
                    />
                  </label>
                </div>
              </section>
            </div>
          )}

          {settingsTab === "generals" && (
            <div className="settings-tab-grid">
              <label className="field">
                Recording root
                <div className="input-with-action">
                  <Input
                    value={settings.recording_root}
                    onChange={(e) => setSettings({ ...settings, recording_root: e.target.value })}
                  />
                  <Button
                    htmlType="button"
                    className="input-action-button"
                    aria-label="Choose recording root folder"
                    onClick={() => {
                      void pickRecordingRoot();
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.1a2.25 2.25 0 0 1 1.59.66l.84.84h6.47a2.25 2.25 0 0 1 2.25 2.25v7.5A2.25 2.25 0 0 1 18 18H6a2.25 2.25 0 0 1-2.25-2.25v-6a3 3 0 0 1 0-3Z"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </Button>
                </div>
              </label>
              <div className="field">
                <span id={artifactOpenerLabelId}>Artifact opener app (optional)</span>
                <div className="opener-dropdown">
                  <Select
                    aria-labelledby={artifactOpenerLabelId}
                    value={settings.artifact_open_app}
                    virtual={false}
                    options={openerMenuOptions.map((editor) => ({
                      value: editor.id,
                      label: (
                        <span className="opener-dropdown-option-label">
                          {editor.id && (editor.icon_data_url || localIconForEditor(editor.name)) ? (
                            <img
                              className="opener-app-icon"
                              src={editor.icon_data_url || localIconForEditor(editor.name) || ""}
                              alt=""
                              aria-hidden="true"
                            />
                          ) : editor.id ? (
                            <span className="opener-app-fallback-icon" aria-hidden="true">
                              {editor.icon_fallback}
                            </span>
                          ) : null}
                          <span>{editor.name}</span>
                        </span>
                      ),
                    }))}
                    onChange={(value) => setSettings({ ...settings, artifact_open_app: value })}
                  />
                </div>
              </div>
              <label className="field">
                <span>Auto-run pipeline on Stop</span>
                <Switch
                  aria-label="Auto-run pipeline on Stop"
                  checked={Boolean(settings.auto_run_pipeline_on_stop)}
                  onChange={(checked) => setSettings({ ...settings, auto_run_pipeline_on_stop: checked })}
                />
              </label>
              <label className="field">
                <span>Enable API call logging</span>
                <Switch
                  aria-label="Enable API call logging"
                  checked={Boolean(settings.api_call_logging_enabled)}
                  onChange={(checked) => setSettings({ ...settings, api_call_logging_enabled: checked })}
                />
              </label>
            </div>
          )}

          {settingsTab === "audio" && (
            <div className="settings-tab-grid">
              <label className="field">
                Audio format
                <Select
                  aria-label="Audio format"
                  value={settings.audio_format}
                  options={audioFormatOptions.map((value) => ({ value, label: value }))}
                  onChange={(value) => setSettings({ ...settings, audio_format: value })}
                />
              </label>
              <label className="field">
                Opus bitrate kbps
                <InputNumber
                  aria-label="Opus bitrate kbps"
                  value={settings.opus_bitrate_kbps}
                  disabled={!isOpusFormat}
                  onChange={(value) => setSettings({ ...settings, opus_bitrate_kbps: Number(value) || 24 })}
                />
              </label>
              <label className="field">
                Mic device name
                <Input
                  value={settings.mic_device_name}
                  onChange={(e) => setSettings({ ...settings, mic_device_name: e.target.value })}
                />
              </label>
              {isMacosPermissionLoading ? (
                <div className="device-card permission-card">
                  <strong>Checking macOS permission status</strong>
                  <div>Native system audio controls will appear once the status is available.</div>
                </div>
              ) : isMacosPermissionUnsupported ? (
                <>
                  <label className="field">
                    System source device name
                    <Input
                      value={settings.system_device_name}
                      onChange={(e) => setSettings({ ...settings, system_device_name: e.target.value })}
                    />
                  </label>
                  <div className="button-row">
                    <Button onClick={autoDetectSystemSource}>
                      Auto-detect system source
                    </Button>
                  </div>
                  {audioDevices.length > 0 && (
                    <div className="device-card">
                      <strong>Available input devices</strong>
                      <div className="device-list">
                        {audioDevices.map((dev) => (
                          <Button
                            key={dev}
                            htmlType="button"
                            onClick={() =>
                              setSettings((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      mic_device_name: prev.mic_device_name || dev,
                                      system_device_name: prev.system_device_name || dev,
                                    }
                                    : prev
                              )
                            }
                          >
                            {dev}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="device-card permission-card">
                  {macosSystemAudioPermission?.kind === "granted" ? (
                    <>
                      <strong>Permission granted</strong>
                      <div>System audio is captured natively by macOS.</div>
                    </>
                  ) : isMacosPermissionLookupFailed ? (
                    <>
                      <strong>System audio is captured natively by macOS</strong>
                      <div>
                        Could not load permission status. Open System Settings to review Screen &amp; System Audio
                        Recording permission.
                      </div>
                      <div className="button-row">
                        <Button onClick={() => void openMacosSystemAudioSettings()}>
                          Open System Settings
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <strong>System audio is captured natively by macOS</strong>
                      <div>Grant Screen & System Audio Recording permission in System Settings.</div>
                      <div className="button-row">
                        <Button onClick={() => void openMacosSystemAudioSettings()}>
                          Open System Settings
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {nexaraSecretState !== "unknown" && <div>Nexara API key: {formatSecretSaveState(nexaraSecretState)}</div>}
        {salutSpeechSecretState !== "unknown" && (
          <div>SalutSpeech authorization key: {formatSecretSaveState(salutSpeechSecretState)}</div>
        )}
        {openaiSecretState !== "unknown" && <div>OpenAI API key: {formatSecretSaveState(openaiSecretState)}</div>}
        {settingsErrors.length > 0 && (
          <div className="error-list">
            {settingsErrors.map((error) => (
              <div key={error}>{error}</div>
            ))}
          </div>
        )}
        <div className="settings-actions">
          <Button type="primary" onClick={saveSettings} disabled={!canSaveSettings}>
            Save settings
          </Button>
          <Button onClick={saveApiKeys}>
            Save API keys
          </Button>
        </div>
      </div>
    );
  }

  if (isTrayWindow) {
    return <TrayPage />;
  }

  if (isSettingsWindow) {
    return <SettingsPage />;
  }

  return (
    <main className="app-shell mac-window mac-content" ref={appMainRef}>
      <div className="main-tabs" role="tablist" aria-label="Main sections">
        <Button
          htmlType="button"
          role="tab"
          className={`main-tab-button${mainTab === "sessions" ? " is-active" : ""}`}
          aria-selected={mainTab === "sessions"}
          onClick={() => setMainTab("sessions")}
        >
          Sessions
        </Button>
        <Button
          htmlType="button"
          role="tab"
          className={`main-tab-button${mainTab === "settings" ? " is-active" : ""}`}
          aria-selected={mainTab === "settings"}
          onClick={() => setMainTab("settings")}
        >
          Settings
        </Button>
      </div>

      {mainTab === "settings" ? (
        <section className="panel">
          {renderSettingsFields()}
        </section>
      ) : (
        <section className="panel">
          <div className="session-toolbar">
            <div className="session-toolbar-header">
              <label className="field session-search-label" htmlFor="session-search-input">
                Search sessions
              </label>
              <div className="session-toolbar-actions">
                <Button
                  htmlType="button"
                  className="secondary-button session-import-button"
                  onClick={() => void importAudioSession()}
                >
                  Загрузить аудио
                </Button>
                <Button
                  htmlType="button"
                  className="refresh-icon-button"
                  aria-label="Refresh sessions"
                  title="Refresh sessions"
                  onClick={refreshSessions}
                >
                  <svg
                    key={refreshAnimationCount}
                    className={refreshAnimationCount > 0 ? "refresh-icon-spin" : undefined}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      d="M20 12a8 8 0 1 1-2.34-5.66"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                    <path
                      d="M20 4v5h-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Button>
              </div>
            </div>
            <div className="session-toolbar-search">
              <Input.Search
                id="session-search-input"
                ref={sessionSearchInputRef}
                aria-label="Search sessions"
                value={sessionSearchQuery}
                onChange={(e) => setSessionSearchQuery(e.target.value)}
                allowClear
              />
            </div>
          </div>
          <div className="sessions-grid">
            {filteredSessions.map((item) => {
              const detail = getSessionDetail(item);
              const textPending = Boolean(textPendingBySession[item.session_id]);
              const summaryPending = Boolean(summaryPendingBySession[item.session_id]);
              const pipelineState = pipelineStateBySession[item.session_id];
              const query = sessionSearchQuery.trim().toLowerCase();
              const sourceMatch = query !== "" && detail.source.toLowerCase().includes(query);
              const notesMatch = query !== "" && detail.notes.toLowerCase().includes(query);
              const topicMatch = query !== "" && detail.topic.toLowerCase().includes(query);
              const tagsText = detail.tags.join(", ");
              const tagsMatch = query !== "" && tagsText.toLowerCase().includes(query);
              const pathMatch = query !== "" && item.session_dir.toLowerCase().includes(query);
              const statusMatch = query !== "" && item.status.toLowerCase().includes(query);
              const artifactHit = sessionArtifactSearchHits[item.session_id];
              const transcriptMatch = query !== "" && Boolean(artifactHit?.transcript_match);
              const summaryMatch = query !== "" && Boolean(artifactHit?.summary_match);
              const startTimeHm = extractStartTimeHm(item.started_at_iso);
              const sessionTitleMeta = startTimeHm
                ? `(${item.audio_format}) - ${item.display_date_ru} ${startTimeHm}`
                : `(${item.audio_format}) - ${item.display_date_ru}`;
              return (
                <article
                  key={item.session_id}
                  className="session-card"
                  onContextMenu={(event) => openSessionContextMenu(event, item.session_id)}
                >
                  <div className="session-card-header">
                    <div className="session-card-heading">
                      <div className="session-title-line">
                        <h3 className="session-title-heading">{detail.topic || "Без темы"}</h3>
                        <span className="session-title-meta">{sessionTitleMeta}</span>
                      </div>
                      <div className={statusMatch ? "session-status match-hit" : "session-status"}>
                        Status: {formatSessionStatus(item.status)}
                      </div>
                    </div>
                    <div className="session-card-actions">
                      <div className="session-labels">
                        {item.has_transcript_text && (
                          <Button
                            htmlType="button"
                            className={`session-label session-label-action session-label-text${transcriptMatch ? " match-hit" : ""}`}
                            onClick={() => void openSessionArtifact(item.session_id, "transcript")}
                          >
                            текст
                          </Button>
                        )}
                        {item.has_summary_text && (
                          <Button
                            htmlType="button"
                            className={`session-label session-label-action session-label-summary${summaryMatch ? " match-hit" : ""}`}
                            onClick={() => void openSessionArtifact(item.session_id, "summary")}
                          >
                            саммари
                          </Button>
                        )}
                      </div>
                      <div className="session-card-icon-actions">
                        <Button
                          htmlType="button"
                          className="icon-button delete-session-button"
                          aria-label="Удалить сессию"
                          title="Удалить сессию"
                          onClick={() => requestDeleteSession(item.session_id, item.status === "recording")}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 7h2v8h-2v-8zm4 0h2v8h-2v-8zM7 10h2v8H7v-8z"
                              fill="currentColor"
                            />
                          </svg>
                        </Button>
                        <Button
                          htmlType="button"
                          className="icon-button session-folder-link"
                          aria-label="Открыть папку сессии"
                          title="Открыть папку сессии"
                          onClick={() => {
                            void openSessionFolder(item.session_dir);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M14 5h5v5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                            <path
                              d="M19 5 11 13"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                            />
                            <path
                              d="M18 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="session-edit-grid">
                    <label className={`field${sourceMatch ? " match-hit" : ""}`}>
                      Source
                      <Select
                        aria-label="Source"
                        value={detail.source}
                        options={fixedSourceOptions}
                        onChange={(value) =>
                          setSessionDetails((prev) => ({
                            ...prev,
                            [item.session_id]: { ...detail, source: value },
                          }))
                        }
                      />
                    </label>
                    <label className={`field${topicMatch ? " match-hit" : ""}`}>
                      Topic
                      <Input
                        aria-label="Topic"
                        value={detail.topic}
                        onChange={(e) =>
                          setSessionDetails((prev) => ({
                            ...prev,
                            [item.session_id]: { ...detail, topic: e.target.value },
                          }))
                        }
                      />
                    </label>
                    <label className={`field${tagsMatch ? " match-hit" : ""}`}>
                      Tags
                      <Select
                        aria-label="Tags"
                        mode="tags"
                        value={detail.tags}
                        options={knownTagOptions}
                        tokenSeparators={[","]}
                        onChange={(value) =>
                          setSessionDetails((prev) => ({
                            ...prev,
                            [item.session_id]: { ...detail, tags: value },
                          }))
                        }
                      />
                    </label>
                    <label className={`field${notesMatch ? " match-hit" : ""}`}>
                      Notes
                      <Input.TextArea
                        aria-label="Notes"
                        value={detail.notes}
                        autoSize={{ minRows: 1, maxRows: 4 }}
                        onChange={(e) =>
                          setSessionDetails((prev) => ({
                            ...prev,
                            [item.session_id]: { ...detail, notes: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="session-card-footer">
                    <div className="session-card-footer-actions">
                      <div className="button-row">
                        <Button
                          className="secondary-button"
                          onClick={() => getText(item.session_id)}
                          disabled={item.status === "recording" || textPending || summaryPending}
                        >
                          {textPending ? (
                            <span className="button-loading-content">
                              <span className="inline-loader" aria-hidden="true" />
                              Getting text...
                            </span>
                          ) : (
                            "Get text"
                          )}
                        </Button>
                        {textPending && (
                          <span className="visually-hidden" role="status" aria-live="polite" aria-label="Loading text">
                            Loading text
                          </span>
                        )}
                        <Button
                          className="secondary-button"
                          onClick={() => getSummary(item.session_id)}
                          disabled={
                            item.status === "recording" || !item.has_transcript_text || summaryPending || textPending
                          }
                        >
                          {summaryPending ? (
                            <span className="button-loading-content">
                              <span className="inline-loader" aria-hidden="true" />
                              Getting summary...
                            </span>
                          ) : (
                            "Get Summary"
                          )}
                        </Button>
                        <Button
                          htmlType="button"
                          className="icon-button session-summary-prompt-button"
                          aria-label="Настроить промпт саммари"
                          title="Настроить промпт саммари"
                          onClick={() => void openSummaryPromptDialogForSession(detail)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H11l-4.25 3.5A.75.75 0 0 1 5.5 18v-3.3A2.49 2.49 0 0 1 5 13.5v-7Z"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </Button>
                        {summaryPending && (
                          <span
                            className="visually-hidden"
                            role="status"
                            aria-live="polite"
                            aria-label="Loading summary"
                          >
                            Loading summary
                          </span>
                        )}
                        {pipelineState && (
                          <span
                            className={
                              pipelineState.kind === "error"
                                ? "retry-state retry-state-error"
                                : "retry-state retry-state-success"
                            }
                          >
                            {pipelineState.text}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="session-card-footer-media">
                      <SessionAudioPlayer item={item} setStatus={setStatus} />
                      <span className="session-duration-label">{item.audio_duration_hms}</span>
                    </div>
                  </div>
                </article>
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
            <Dropdown
              open
              menu={{ items: [] }}
              dropdownRender={() => (
                <Menu
                  aria-label="Действия сессии"
                  className="session-context-menu-popup"
                  items={sessionContextMenuItems}
                  onClick={({ key }) => runSessionContextMenuItem(String(key))}
                />
              )}
              trigger={["click"]}
              onOpenChange={(open) => {
                if (!open) setSessionContextMenu(null);
              }}
            >
              <span
                ref={sessionContextMenuRef}
                className="session-context-menu"
                style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
              />
            </Dropdown>
          )}
        <Modal
          open={Boolean(deleteTarget)}
          title="Подтверждение удаления"
          closable={false}
          onCancel={() => setDeleteTarget(null)}
          wrapProps={{ onKeyDown: handleDeleteDialogKeyDown }}
          afterOpenChange={(open) => {
            if (open) window.setTimeout(() => deleteCancelButtonRef.current?.focus(), 0);
          }}
          footer={[
            <Button
              key="cancel"
              ref={(button) => {
                deleteCancelButtonRef.current = button;
              }}
              autoFocus
              onClick={() => setDeleteTarget(null)}
              disabled={deletePendingSessionId !== null}
            >
              Отмена
            </Button>,
            <Button
              key="delete"
              ref={(button) => {
                deleteConfirmButtonRef.current = button;
              }}
              danger
              onClick={() => void confirmDeleteSession()}
              loading={deletePendingSessionId !== null}
            >
              Удалить
            </Button>,
          ]}
        >
          <div ref={deleteDialogRef}>
            <p>
              {deleteTarget?.force
                ? "Сессия помечена как активная. Принудительно удалить сессию и все связанные файлы?"
                : "Удалить сессию и все связанные файлы?"}
            </p>
          </div>
        </Modal>
        <Modal
          open={Boolean(artifactPreview)}
          title="Просмотр артефакта"
          closable={false}
          onCancel={closeArtifactPreview}
          footer={[
            <Button key="close" onClick={closeArtifactPreview}>
              Закрыть
            </Button>,
          ]}
          aria-label="Просмотр артефакта"
        >
          {artifactPreview && (
            <div className="artifact-preview-card" ref={artifactDialogRef}>
              <div className="session-title-line">
                <strong>{artifactPreview.artifactKind === "transcript" ? "Текст" : "Саммари"}</strong>
              </div>
              <div className="session-path">{artifactPreview.path}</div>
              <pre ref={artifactPreviewBodyRef} className="artifact-preview-text">
                {renderHighlightedText(artifactPreview.text, artifactPreview.query)}
              </pre>
            </div>
          )}
        </Modal>
        <Modal
          open={Boolean(summaryPromptDialog)}
          title="Промпт саммари"
          closable={false}
          onCancel={() => setSummaryPromptDialog(null)}
          footer={[
            <Button
              key="cancel"
              onClick={() => setSummaryPromptDialog(null)}
              disabled={summaryPromptDialog?.saving}
            >
              Отмена
            </Button>,
            <Button
              key="ok"
              onClick={() => void confirmSummaryPromptDialog()}
              loading={summaryPromptDialog?.saving}
            >
              Ок
            </Button>,
          ]}
        >
          {summaryPromptDialog && (
            <div className="summary-prompt-card" ref={summaryPromptDialogRef}>
              <label className="field">
                <Input.TextArea
                  rows={8}
                  value={summaryPromptDialog.value}
                  onChange={(event) =>
                    setSummaryPromptDialog((prev) =>
                      prev
                        ? {
                            ...prev,
                            value: event.target.value,
                          }
                        : prev
                    )
                  }
                  disabled={summaryPromptDialog.saving}
                />
              </label>
            </div>
          )}
        </Modal>
        </section>
      )}
    </main>
  );
}
