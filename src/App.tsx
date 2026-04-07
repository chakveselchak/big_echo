import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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
} from "./appTypes";
import { TrayAudioRow } from "./features/recording/TrayAudioRow";
import { useRecordingController } from "./features/recording/useRecordingController";
import { useSessions } from "./features/sessions/useSessions";
import { useSettingsForm } from "./features/settings/useSettingsForm";
import { formatSecretSaveState, getErrorMessage, splitParticipants } from "./lib/appUtils";
import { getCurrentWindowLabel, tauriConvertFileSrc } from "./lib/tauri";
import { formatAppStatus, formatSessionStatus } from "./status";
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
      <button
        type="button"
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
      </button>
      <input
        className="session-audio-slider"
        type="range"
        min="0"
        max="100"
        step="1"
        aria-label="Позиция аудио"
        value={Math.round(progressPercent)}
        style={{ "--session-audio-progress": `${Math.round(progressPercent)}%` } as CSSProperties}
        onChange={(e) => handleSeek(Number(e.target.value))}
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
  const [participants, setParticipants] = useState("");
  const [source, setSource] = useState("slack");
  const [customTag, setCustomTag] = useState("");
  const [session, setSession] = useState<StartResponse | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [trayMuteError, setTrayMuteError] = useState<string | null>(null);
  const [isOpenerDropdownOpen, setIsOpenerDropdownOpen] = useState(false);
  const [openerActiveIndex, setOpenerActiveIndex] = useState(0);
  const appMainRef = useRef<HTMLElement | null>(null);
  const openerDropdownRef = useRef<HTMLDivElement | null>(null);
  const openerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openerOptionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const wasOpenerDropdownOpenRef = useRef(false);
  const sessionSearchInputRef = useRef<HTMLInputElement | null>(null);
  const artifactPreviewBodyRef = useRef<HTMLPreElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const artifactDialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasDialogOpenRef = useRef(false);
  const loadSessionsRef = useRef<(() => Promise<void>) | null>(null);
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
  } = useSettingsForm({ isTrayWindow, setStatus });
  const openerOptions = textEditorApps.length > 0 ? textEditorApps : openerUiFallback;
  const openerMenuOptions = [
    { id: "", name: "System default", icon_fallback: "", icon_data_url: null },
    ...openerOptions,
  ];
  const selectedOpenerLabel =
    openerMenuOptions.find((app) => app.id === settings?.artifact_open_app)?.name ?? "System default";
  const selectedOpenerIndex = Math.max(
    0,
    openerMenuOptions.findIndex((app) => app.id === settings?.artifact_open_app)
  );
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
    loadSessions,
    openSessionArtifact,
    pipelineStateBySession,
    requestDeleteSession,
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
    isSettingsWindow,
    isTrayWindow,
    topic,
    setTopic,
    participants,
    setParticipants,
    source,
    setSource,
    customTag,
    setCustomTag,
    session,
    setSession,
    lastSessionId,
    setLastSessionId,
    status,
    setStatus,
    loadSessions,
  });

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
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (!isOpenerDropdownOpen) return;
      if (!openerDropdownRef.current) return;
      if (openerDropdownRef.current.contains(event.target as Node)) return;
      closeOpenerDropdown({ restoreFocus: false });
    };
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, [isOpenerDropdownOpen]);

  useEffect(() => {
    if (isTrayWindow || isSettingsWindow) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      sessionSearchInputRef.current?.focus();
      sessionSearchInputRef.current?.select();
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
    const isDialogOpen = Boolean(deleteTarget || artifactPreview);
    const dialogRef = deleteTarget ? deleteDialogRef : artifactPreview ? artifactDialogRef : null;
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
        const fallbackFocusTarget =
          sessionSearchInputRef.current && document.contains(sessionSearchInputRef.current)
            ? sessionSearchInputRef.current
            : getFocusableElements(appMainRef.current)[0] ?? appMainRef.current;
        fallbackFocusTarget?.focus();
      }
      restoreFocusRef.current = null;
    }

    wasDialogOpenRef.current = isDialogOpen;
  }, [artifactPreview, deleteTarget]);

  function closeOpenerDropdown({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    setIsOpenerDropdownOpen(false);
    if (restoreFocus) {
      openerTriggerRef.current?.focus();
    }
  }

  function focusOpenerIndex(index: number) {
    const nextIndex = Math.max(0, Math.min(index, openerMenuOptions.length - 1));
    setOpenerActiveIndex(nextIndex);
    openerOptionRefs.current[nextIndex]?.focus();
  }

  function openOpenerDropdown() {
    setOpenerActiveIndex(selectedOpenerIndex);
    setIsOpenerDropdownOpen(true);
  }

  function selectOpenerApp(appId: string) {
    if (!settings) return;
    setSettings({ ...settings, artifact_open_app: appId });
    closeOpenerDropdown();
  }

  function handleOpenerDropdownBlur(event: ReactFocusEvent<HTMLDivElement>) {
    if (!isOpenerDropdownOpen) return;
    const nextFocused = event.relatedTarget;
    if (!(nextFocused instanceof Node)) {
      closeOpenerDropdown({ restoreFocus: false });
      return;
    }
    if (openerDropdownRef.current?.contains(nextFocused)) return;
    closeOpenerDropdown({ restoreFocus: false });
  }

  function handleOpenerTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && isOpenerDropdownOpen) {
      event.preventDefault();
      closeOpenerDropdown();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openOpenerDropdown();
    }
  }

  function handleOpenerMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOpenerDropdown();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOpenerIndex((openerActiveIndex + 1) % openerMenuOptions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOpenerIndex((openerActiveIndex - 1 + openerMenuOptions.length) % openerMenuOptions.length);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusOpenerIndex(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusOpenerIndex(openerMenuOptions.length - 1);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOpenerApp(openerMenuOptions[openerActiveIndex]?.id ?? "");
    }
  }

  function handleDialogKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    dialogNode: HTMLElement | null,
    closeDialog: () => void
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }

    if (event.key !== "Tab") return;

    const focusables = getFocusableElements(dialogNode);
    if (focusables.length === 0) {
      event.preventDefault();
      dialogNode?.focus();
      return;
    }

    const currentIndex = focusables.findIndex((element) => element === document.activeElement);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusables.length - 1
        : currentIndex - 1
      : currentIndex === focusables.length - 1
        ? 0
        : currentIndex + 1;

    event.preventDefault();
    (focusables[nextIndex] ?? dialogNode)?.focus();
  }

  useEffect(() => {
    if (isOpenerDropdownOpen && !wasOpenerDropdownOpenRef.current) {
      focusOpenerIndex(selectedOpenerIndex);
    }
    wasOpenerDropdownOpenRef.current = isOpenerDropdownOpen;
  }, [isOpenerDropdownOpen, selectedOpenerIndex]);

  useEffect(() => {
    if (isTrayWindow || isSettingsWindow || mainTab !== "sessions") return;
    loadSessionsRef.current?.().catch((err) => {
      setStatus(`error: ${String(err)}`);
    });
  }, [isSettingsWindow, isTrayWindow, mainTab]);

  function renderSettingsFields() {
    if (!settings) return null;
    const isOpusFormat = settings.audio_format === "opus";
    const isNexaraProvider = settings.transcription_provider === "nexara";
    const openerOptions = textEditorApps.length > 0 ? textEditorApps : openerUiFallback;
    const selectedOpenerApp = openerOptions.find((app) => app.id === settings.artifact_open_app) ?? null;
    const artifactOpenerLabelId = "artifact-opener-label";
    const artifactOpenerValueId = "artifact-opener-value";
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

    return (
      <div className="settings-tabs settings-layout">
        <div className="settings-tab-list" role="tablist" aria-label="Settings sections">
          {tabButtons.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={`settings-tab-button${settingsTab === tab.id ? " is-active" : ""}`}
              aria-selected={settingsTab === tab.id}
              onClick={() => setSettingsTab(tab.id)}
            >
              {tab.label}
              {dirtyByTab[tab.id] && <span className="settings-tab-dirty-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>

        <div className="settings-tab-panel" role="tabpanel">
          {settingsTab === "audiototext" && (
            <div className="settings-subsections">
              <section className="settings-subsection">
                <h3>Транскрибация</h3>
                <div className="settings-tab-grid">
                  <label className="field">
                    Transcription provider
                    <select
                      value={settings.transcription_provider}
                      onChange={(e) => setSettings({ ...settings, transcription_provider: e.target.value })}
                    >
                      {transcriptionProviderOptions.map((value) => (
                        <option key={value} value={value}>
                          {value === "nexara" ? "nexara" : "SalutSpeechAPI"}
                        </option>
                      ))}
                    </select>
                  </label>
                  {isNexaraProvider ? (
                    <>
                      <label className="field">
                        Transcription URL
                        <input
                          value={settings.transcription_url}
                          onChange={(e) => setSettings({ ...settings, transcription_url: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        Task
                        <select
                          value={settings.transcription_task}
                          onChange={(e) => setSettings({ ...settings, transcription_task: e.target.value })}
                        >
                          {transcriptionTaskOptions.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        Diarization setting
                        <select
                          value={settings.transcription_diarization_setting}
                          onChange={(e) =>
                            setSettings({ ...settings, transcription_diarization_setting: e.target.value })
                          }
                        >
                          {diarizationSettingOptions.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        Nexara API key
                        <input
                          type="password"
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
                        <select
                          value={settings.salute_speech_scope}
                          onChange={(e) => setSettings({ ...settings, salute_speech_scope: e.target.value })}
                        >
                          {saluteSpeechScopeOptions.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        Recognition model
                        <select
                          value={settings.salute_speech_model}
                          onChange={(e) => setSettings({ ...settings, salute_speech_model: e.target.value })}
                        >
                          {saluteSpeechRecognitionModelOptions.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        Language
                        <input
                          value={settings.salute_speech_language}
                          onChange={(e) => setSettings({ ...settings, salute_speech_language: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        Sample rate
                        <input
                          type="number"
                          value={settings.salute_speech_sample_rate}
                          onChange={(e) =>
                            setSettings({ ...settings, salute_speech_sample_rate: Number(e.target.value) || 0 })
                          }
                        />
                      </label>
                      <label className="field">
                        Channels count
                        <input
                          type="number"
                          value={settings.salute_speech_channels_count}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              salute_speech_channels_count: Number(e.target.value) || 0,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        SalutSpeech authorization key
                        <input
                          type="password"
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
                    <input
                      value={settings.summary_url}
                      onChange={(e) => setSettings({ ...settings, summary_url: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    Summary prompt
                    <textarea
                      value={settings.summary_prompt}
                      onChange={(e) => setSettings({ ...settings, summary_prompt: e.target.value })}
                      rows={4}
                    />
                  </label>
                  <label className="field">
                    OpenAI model
                    <input
                      value={settings.openai_model}
                      onChange={(e) => setSettings({ ...settings, openai_model: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    OpenAI API key
                    <input
                      type="password"
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
                  <input
                    value={settings.recording_root}
                    onChange={(e) => setSettings({ ...settings, recording_root: e.target.value })}
                  />
                  <button
                    type="button"
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
                  </button>
                </div>
              </label>
              <div className="field">
                <span id={artifactOpenerLabelId}>Artifact opener app (optional)</span>
                <div className="opener-dropdown" ref={openerDropdownRef} onBlur={handleOpenerDropdownBlur}>
                  <button
                    ref={openerTriggerRef}
                    type="button"
                    className="opener-dropdown-trigger"
                    aria-labelledby={`${artifactOpenerLabelId} ${artifactOpenerValueId}`}
                    aria-haspopup="listbox"
                    aria-expanded={isOpenerDropdownOpen}
                    aria-controls="artifact-opener-listbox"
                    onClick={() => {
                      if (isOpenerDropdownOpen) {
                        closeOpenerDropdown();
                        return;
                      }
                      openOpenerDropdown();
                    }}
                    onKeyDown={handleOpenerTriggerKeyDown}
                  >
                    {selectedOpenerApp ? (
                      <>
                        {(selectedOpenerApp.icon_data_url || localIconForEditor(selectedOpenerApp.name)) ? (
                          <img
                            className="opener-app-icon"
                            src={selectedOpenerApp.icon_data_url || localIconForEditor(selectedOpenerApp.name) || ""}
                            alt=""
                            aria-hidden="true"
                          />
                        ) : (
                          <span className="opener-app-fallback-icon" aria-hidden="true">
                            {selectedOpenerApp.icon_fallback}
                          </span>
                        )}
                        <span id={artifactOpenerValueId}>{selectedOpenerApp.name}</span>
                      </>
                    ) : (
                      <span id={artifactOpenerValueId}>{selectedOpenerLabel}</span>
                    )}
                  </button>

                  {isOpenerDropdownOpen && (
                    <div
                      id="artifact-opener-listbox"
                      className="opener-dropdown-menu"
                      role="listbox"
                      aria-label="Artifact opener app options"
                      onKeyDown={handleOpenerMenuKeyDown}
                    >
                      {openerMenuOptions.map((editor, index) => (
                        <div
                          key={editor.id || "system-default"}
                          ref={(node) => {
                            openerOptionRefs.current[index] = node;
                          }}
                          role="option"
                          tabIndex={-1}
                          aria-selected={settings.artifact_open_app === editor.id}
                          className={`opener-dropdown-option${
                            settings.artifact_open_app === editor.id ? " is-active" : ""
                          }`}
                          onClick={() => selectOpenerApp(editor.id)}
                          onMouseEnter={() => setOpenerActiveIndex(index)}
                        >
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
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <label className="field">
                <span>Auto-run pipeline on Stop</span>
                <input
                  type="checkbox"
                  checked={Boolean(settings.auto_run_pipeline_on_stop)}
                  onChange={(e) => setSettings({ ...settings, auto_run_pipeline_on_stop: e.target.checked })}
                />
              </label>
              <label className="field">
                <span>Enable API call logging</span>
                <input
                  type="checkbox"
                  checked={Boolean(settings.api_call_logging_enabled)}
                  onChange={(e) => setSettings({ ...settings, api_call_logging_enabled: e.target.checked })}
                />
              </label>
            </div>
          )}

          {settingsTab === "audio" && (
            <div className="settings-tab-grid">
              <label className="field">
                Audio format
                <select
                  value={settings.audio_format}
                  onChange={(e) => setSettings({ ...settings, audio_format: e.target.value })}
                >
                  {audioFormatOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Opus bitrate kbps
                <input
                  type="number"
                  value={settings.opus_bitrate_kbps}
                  disabled={!isOpusFormat}
                  onChange={(e) => setSettings({ ...settings, opus_bitrate_kbps: Number(e.target.value) || 24 })}
                />
              </label>
              <label className="field">
                Mic device name
                <input
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
                    <input
                      value={settings.system_device_name}
                      onChange={(e) => setSettings({ ...settings, system_device_name: e.target.value })}
                    />
                  </label>
                  <div className="button-row">
                    <button className="secondary-button" onClick={autoDetectSystemSource}>
                      Auto-detect system source
                    </button>
                  </div>
                  {audioDevices.length > 0 && (
                    <div className="device-card">
                      <strong>Available input devices</strong>
                      <div className="device-list">
                        {audioDevices.map((dev) => (
                          <button
                            key={dev}
                            type="button"
                            className="secondary-button"
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
                          </button>
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
                        <button className="secondary-button" onClick={() => void openMacosSystemAudioSettings()}>
                          Open System Settings
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <strong>System audio is captured natively by macOS</strong>
                      <div>Grant Screen & System Audio Recording permission in System Settings.</div>
                      <div className="button-row">
                        <button className="secondary-button" onClick={() => void openMacosSystemAudioSettings()}>
                          Open System Settings
                        </button>
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
          <button className="primary-button" onClick={saveSettings} disabled={!canSaveSettings}>
            Save settings
          </button>
          <button className="secondary-button" onClick={saveApiKeys}>
            Save API keys
          </button>
        </div>
      </div>
    );
  }

  if (isTrayWindow) {
    const isMacosSystemAudioUnsupported =
      macosSystemAudioPermissionLoadState === "ready" && macosSystemAudioPermission?.kind === "unsupported";
    const isMacosSystemAudioLoading = macosSystemAudioPermissionLoadState === "loading";
    const isMacosSystemAudioLookupFailed = macosSystemAudioPermissionLoadState === "error";
    const isMacosSystemAudioPermissionPendingReview =
      macosSystemAudioPermissionLoadState === "ready" &&
      macosSystemAudioPermission?.kind !== "granted" &&
      macosSystemAudioPermission?.kind !== "unsupported";
    const showMacosSystemAudioSettingsShortcut =
      isMacosSystemAudioPermissionPendingReview || isMacosSystemAudioLookupFailed;
    const handleToggleTrayInputMuted = async (channel: "mic" | "system") => {
      setTrayMuteError(null);
      try {
        await toggleInputMuted(channel);
      } catch (err) {
        setTrayMuteError(`Mute update failed: ${getErrorMessage(err)}`);
      }
    };
    const handleStartFromTray = async () => {
      setTrayMuteError(null);
      await startFromTray();
    };
    const handleStopFromTray = async () => {
      setTrayMuteError(null);
      await stop();
    };
    return (
      <main className="tray-shell" ref={appMainRef}>
        <div className="tray-top-bar">
          <p className="status-line">Status: {formatAppStatus(status)}</p>
          {showMacosSystemAudioSettingsShortcut && (
            <button className="tray-settings-link" onClick={() => void openMacosSystemAudioSettings()}>
              Open System Settings
            </button>
          )}
        </div>
        {trayMuteError && (
          <p className="tray-inline-error" role="alert">
            {trayMuteError}
          </p>
        )}
        <div className="tray-meta-grid">
          <label className="field tray-source-field">
            Source
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {fixedSources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="field tray-topic-field">
            Topic (optional)
            <input value={topic} onChange={(e) => setTopic(e.target.value)} />
          </label>
        </div>
        <div className="tray-audio-rows">
          <TrayAudioRow
            label="Mic"
            animationLabel="Mic activity"
            muteLabel="microphone"
            icon="mic"
            level={liveLevels.mic}
            muted={muteState.micMuted}
            disabled={status !== "recording"}
            onToggleMuted={() => handleToggleTrayInputMuted("mic")}
            inlineTrailing
            trailing={
              <label className="tray-audio-device">
                <span className="sr-only">Mic device</span>
                <select
                  aria-label="Mic device"
                  value={settings?.mic_device_name ?? ""}
                  onChange={(e) => {
                    void saveSettingsPatch({ mic_device_name: e.target.value }).catch((err) =>
                      setStatus(`error: ${String(err)}`)
                    );
                  }}
                  disabled={status === "recording"}
                >
                  <option value="">Auto</option>
                  {audioDevices.map((dev) => (
                    <option key={`mic-${dev}`} value={dev}>
                      {dev}
                    </option>
                  ))}
                </select>
              </label>
            }
          />
          <TrayAudioRow
            label="System"
            animationLabel="System activity"
            muteLabel="system audio"
            icon="system"
            level={liveLevels.system}
            muted={muteState.systemMuted}
            disabled={
              status !== "recording" ||
              isMacosSystemAudioLoading ||
              isMacosSystemAudioLookupFailed ||
              isMacosSystemAudioPermissionPendingReview
            }
            onToggleMuted={() => handleToggleTrayInputMuted("system")}
            statusText={
              isMacosSystemAudioLoading
                ? "Checking macOS system audio status"
                : isMacosSystemAudioLookupFailed
                  ? "Could not load macOS system audio status. Open System Settings to review the permission."
                  : isMacosSystemAudioPermissionPendingReview
                    ? "Grant Screen & System Audio Recording permission in System Settings."
                    : null
            }
            inlineTrailing
            trailing={
              isMacosSystemAudioUnsupported ? (
                <label className="tray-audio-device">
                  <span className="sr-only">System device</span>
                  <select
                    aria-label="System device"
                    value={settings?.system_device_name ?? ""}
                    onChange={(e) => {
                      void saveSettingsPatch({ system_device_name: e.target.value }).catch((err) =>
                        setStatus(`error: ${String(err)}`)
                      );
                    }}
                    disabled={status === "recording"}
                  >
                    <option value="">Auto</option>
                    {audioDevices.map((dev) => (
                      <option key={`sys-${dev}`} value={dev}>
                        {dev}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null
            }
          />
        </div>
        <div className="button-row">
          <button
            className="primary-button rec-button"
            onClick={() => void handleStartFromTray()}
            disabled={status === "recording"}
          >
            <span className="rec-dot" />
            Rec
          </button>
          <button className="secondary-button" onClick={() => void handleStopFromTray()} disabled={status !== "recording"}>
            <span className="stop-square" />
            Stop
          </button>
        </div>
      </main>
    );
  }

  if (isSettingsWindow) {
    return (
      <main className="app-shell settings-shell mac-window settings-layout" ref={appMainRef}>
        <section className="panel">
          {renderSettingsFields()}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell mac-window mac-content" ref={appMainRef}>
      <div className="main-tabs" role="tablist" aria-label="Main sections">
        <button
          type="button"
          role="tab"
          className={`main-tab-button${mainTab === "sessions" ? " is-active" : ""}`}
          aria-selected={mainTab === "sessions"}
          onClick={() => setMainTab("sessions")}
        >
          Sessions
        </button>
        <button
          type="button"
          role="tab"
          className={`main-tab-button${mainTab === "settings" ? " is-active" : ""}`}
          aria-selected={mainTab === "settings"}
          onClick={() => setMainTab("settings")}
        >
          Settings
        </button>
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
                <button
                  type="button"
                  className="secondary-button session-import-button"
                  onClick={() => void importAudioSession()}
                >
                  Загрузить аудио
                </button>
                <button
                  type="button"
                  className="refresh-icon-button"
                  aria-label="Refresh sessions"
                  title="Refresh sessions"
                  onClick={() => void loadSessions()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
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
                </button>
              </div>
            </div>
            <div className="session-toolbar-search">
              <input
                id="session-search-input"
                ref={sessionSearchInputRef}
                aria-label="Search sessions"
                value={sessionSearchQuery}
                onChange={(e) => setSessionSearchQuery(e.target.value)}
              />
              <span className="session-search-icon" aria-hidden="true">
                <svg viewBox="0 0 20 20">
                  <circle
                    cx="8.5"
                    cy="8.5"
                    r="4.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  />
                  <path
                    d="M12 12l4.25 4.25"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </div>
          </div>
          <div className="sessions-grid">
            {filteredSessions.map((item) => {
              const detail = sessionDetails[item.session_id] ?? {
                session_id: item.session_id,
                source: item.primary_tag,
                custom_tag: "",
                topic: item.topic,
                participants: [],
              };
              const textPending = Boolean(textPendingBySession[item.session_id]);
              const summaryPending = Boolean(summaryPendingBySession[item.session_id]);
              const pipelineState = pipelineStateBySession[item.session_id];
              const query = sessionSearchQuery.trim().toLowerCase();
              const sourceMatch = query !== "" && detail.source.toLowerCase().includes(query);
              const customMatch = query !== "" && detail.custom_tag.toLowerCase().includes(query);
              const topicMatch = query !== "" && detail.topic.toLowerCase().includes(query);
              const participantsText = detail.participants.join(", ");
              const participantsMatch = query !== "" && participantsText.toLowerCase().includes(query);
              const pathMatch = query !== "" && item.session_dir.toLowerCase().includes(query);
              const statusMatch = query !== "" && item.status.toLowerCase().includes(query);
              const artifactHit = sessionArtifactSearchHits[item.session_id];
              const transcriptMatch = query !== "" && Boolean(artifactHit?.transcript_match);
              const summaryMatch = query !== "" && Boolean(artifactHit?.summary_match);
              return (
                <article key={item.session_id} className="session-card">
                  <div className="session-card-header">
                    <div className="session-card-heading">
                      <div className="session-title-line">
                        <h3 className="session-title-heading">{detail.topic || "Без темы"}</h3>
                        <span className="session-title-meta">
                          ({item.audio_format}) - {item.display_date_ru}
                        </span>
                      </div>
                      <div className={statusMatch ? "session-status match-hit" : "session-status"}>
                        Status: {formatSessionStatus(item.status)}
                      </div>
                    </div>
                    <div className="session-card-actions">
                      <div className="session-labels">
                        {item.has_transcript_text && (
                          <button
                            type="button"
                            className={`session-label session-label-action session-label-text${transcriptMatch ? " match-hit" : ""}`}
                            onClick={() => void openSessionArtifact(item.session_id, "transcript")}
                          >
                            текст
                          </button>
                        )}
                        {item.has_summary_text && (
                          <button
                            type="button"
                            className={`session-label session-label-action session-label-summary${summaryMatch ? " match-hit" : ""}`}
                            onClick={() => void openSessionArtifact(item.session_id, "summary")}
                          >
                            саммари
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
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
                      </button>
                    </div>
                  </div>
                  <div className="session-edit-grid">
                    <label className={`field${sourceMatch ? " match-hit" : ""}`}>
                      Source
                      <select
                        value={detail.source}
                        onChange={(e) =>
                          setSessionDetails((prev) => ({
                            ...prev,
                            [item.session_id]: { ...detail, source: e.target.value },
                          }))
                        }
                      >
                        {fixedSources.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={`field${customMatch ? " match-hit" : ""}`}>
                      Custom tag
                      <input
                        value={detail.custom_tag}
                        onChange={(e) =>
                          setSessionDetails((prev) => ({
                            ...prev,
                            [item.session_id]: { ...detail, custom_tag: e.target.value },
                          }))
                        }
                      />
                    </label>
                    <label className={`field${topicMatch ? " match-hit" : ""}`}>
                      Topic
                      <input
                        value={detail.topic}
                        onChange={(e) =>
                          setSessionDetails((prev) => ({
                            ...prev,
                            [item.session_id]: { ...detail, topic: e.target.value },
                          }))
                        }
                      />
                    </label>
                    <label className={`field${participantsMatch ? " match-hit" : ""}`}>
                      Participants
                      <input
                        value={participantsText}
                        onChange={(e) =>
                          setSessionDetails((prev) => ({
                            ...prev,
                            [item.session_id]: {
                              ...detail,
                              participants: splitParticipants(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="session-card-footer">
                    <div className="session-card-footer-actions">
                      <div className="button-row">
                        <button
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
                        </button>
                        {textPending && (
                          <span className="visually-hidden" role="status" aria-live="polite" aria-label="Loading text">
                            Loading text
                          </span>
                        )}
                        <button
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
                        </button>
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
        {deleteTarget && (
            <div
              className="confirm-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Подтверждение удаления"
              onKeyDown={(event) => handleDialogKeyDown(event, deleteDialogRef.current, () => setDeleteTarget(null))}
            >
              <div className="confirm-card" ref={deleteDialogRef} tabIndex={-1}>
                <p>
                  {deleteTarget.force
                    ? "Сессия помечена как активная. Принудительно удалить сессию и все связанные файлы?"
                    : "Удалить сессию и все связанные файлы?"}
                </p>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setDeleteTarget(null)}
                    disabled={deletePendingSessionId !== null}
                  >
                    Отмена
                  </button>
                  <button
                    className="secondary-button danger-button"
                    type="button"
                    onClick={() => void confirmDeleteSession()}
                    disabled={deletePendingSessionId !== null}
                  >
                    {deletePendingSessionId !== null ? "Удаление..." : "Удалить"}
                  </button>
                </div>
              </div>
            </div>
        )}
        {artifactPreview && (
            <div
              className="confirm-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Просмотр артефакта"
              onKeyDown={(event) => handleDialogKeyDown(event, artifactDialogRef.current, closeArtifactPreview)}
            >
              <div className="confirm-card artifact-preview-card" ref={artifactDialogRef} tabIndex={-1}>
                <div className="session-title-line">
                  <strong>{artifactPreview.artifactKind === "transcript" ? "Текст" : "Саммари"}</strong>
                </div>
                <div className="session-path">{artifactPreview.path}</div>
                <pre ref={artifactPreviewBodyRef} className="artifact-preview-text">
                  {renderHighlightedText(artifactPreview.text, artifactPreview.query)}
                </pre>
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={closeArtifactPreview}>
                    Закрыть
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
