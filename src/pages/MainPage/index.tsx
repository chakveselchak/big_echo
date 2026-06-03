import { useCallback, useEffect, useRef, useState } from "react";
import type { InputRef } from "antd";
import { useRecordingController } from "../../hooks/useRecordingController";
import { useSessions } from "../../hooks/useSessions";
import packageJson from "../../../package.json";
import { initializeAnalytics } from "../../lib/analytics";
import { getErrorMessage } from "../../lib/appUtils";
import {
  persistBrainSyncUnlocked,
  readBrainSyncUnlocked,
  registerUnlockTap,
} from "../../lib/brainSyncUnlock";
import { getCurrentWindowLabel, tauriInvoke } from "../../lib/tauri";
import type { StartResponse } from "../../types";
import { NexaraBalance } from "../../components/NexaraBalance";
import { TranscriptionProviderSelect } from "../../components/TranscriptionProviderSelect";
import { SessionFilters } from "../../components/sessions/SessionFilters";
import { SessionList } from "../../components/sessions/SessionList";
import { SettingsPage } from "../SettingsPage";
import { useVersionCheck } from "../../hooks/useVersionCheck";
import { NewVersionPage } from "../NewVersionPage";

type MainTab = "sessions" | "settings" | "new-version";

export function MainPage() {
  const [mainTab, setMainTab] = useState<MainTab>("sessions");
  // Once Settings has been opened, keep its subtree mounted and toggle with
  // `display: none`. The full settings form is only constructed on first
  // click; subsequent switches are a display swap and cost nothing.
  // SettingsPage renders a LoadingPlaceholder until `useSettingsForm`
  // finishes loading, so the user sees the loader immediately on first click.
  const [settingsMounted, setSettingsMounted] = useState(false);
  const handleTabSelect = useCallback((tab: MainTab) => {
    if (tab === "settings") setSettingsMounted(true);
    setMainTab(tab);
  }, []);
  // Tapping the version label five times within ten seconds reveals the hidden
  // Brain sync settings section. The unlock persists across restarts via local
  // storage. We keep only the last few tap timestamps (no timers), so the
  // gesture cannot leak memory.
  const [brainUnlocked, setBrainUnlocked] = useState(readBrainSyncUnlocked);
  const versionTapsRef = useRef<number[]>([]);
  const handleVersionTap = useCallback(() => {
    if (brainUnlocked) return;
    const { taps, unlocked } = registerUnlockTap(versionTapsRef.current, Date.now());
    versionTapsRef.current = taps;
    if (!unlocked) return;
    persistBrainSyncUnlocked();
    setBrainUnlocked(true);
  }, [brainUnlocked]);
  const [topic, setTopic] = useState("");
  const [source, setSource] = useState("slack");
  const [transcriptionProvider, setTranscriptionProvider] = useState<string | null>(null);
  const [session, setSession] = useState<StartResponse | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [refreshKey, setRefreshKey] = useState(0);
  const [brainUploadPendingBySession, setBrainUploadPendingBySession] = useState<Record<string, boolean>>({});
  const { updateInfo } = useVersionCheck();
  const showNewVersionTab = updateInfo?.is_newer === true;
  const sessionSearchInputRef = useRef<InputRef | null>(null);
  const loadSessionsRef = useRef<(() => Promise<void>) | null>(null);
  const appMainRef = useRef<HTMLElement | null>(null);
  const brainUploadPendingRef = useRef<Record<string, boolean>>({});

  const {
    artifactPreview,
    audioDeletePendingSessionId,
    audioDeleteTargetSessionId,
    closeArtifactPreview,
    confirmDeleteAudio,
    confirmDeleteSession,
    deletePendingSessionId,
    deleteTarget,
    filteredSessions,
    flushSessionDetails,
    getSummary,
    getText,
    isSearching,
    importAudioSession,
    isInitialLoading,
    knownTags,
    loadSessions,
    openSessionFolder,
    openSessionArtifact,
    openArtifactInEditor,
    pipelineStateBySession,
    requestDeleteAudio,
    requestDeleteSession,
    saveSessionDetails,
    sessionArtifactSearchHits,
    sessionDetails,
    sessionSearchQuery,
    sessions,
    setAudioDeleteTargetSessionId,
    setDeleteTarget,
    setSessionDetails,
    setSessionSearchQuery,
    summaryPendingBySession,
    textPendingBySession,
  } = useSessions({ setStatus, lastSessionId, setLastSessionId });

  const { start, stop } = useRecordingController({
    enableTrayCommandListeners: true,
    isSettingsWindow: false,
    isTrayWindow: false,
    topic,
    setTopic,
    tagsInput: "",
    source,
    setSource,
    notesInput: "",
    session,
    setSession,
    lastSessionId,
    setLastSessionId,
    status,
    setStatus,
    loadSessions,
    flushPendingSessionDetails: flushSessionDetails,
  });

  // suppress unused warning
  void start;
  void stop;

  useEffect(() => {
    const windowLabel = getCurrentWindowLabel();
    tauriInvoke<string>("get_computer_name")
      .then((computerName) => {
        initializeAnalytics({ window_label: windowLabel, computer_name: computerName });
      })
      .catch(() => {
        initializeAnalytics({ window_label: windowLabel });
      });
  }, []);

  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  }, [loadSessions]);

  const autoDeleteDoneRef = useRef(false);
  useEffect(() => {
    if (autoDeleteDoneRef.current) return;
    autoDeleteDoneRef.current = true;
    void tauriInvoke<{ deleted: number; scanned: number }>(
      "auto_delete_old_session_audio",
    )
      .catch(() => undefined)
      .finally(() => {
        void loadSessionsRef.current?.();
      });
  }, []);

  useEffect(() => {
    if (mainTab !== "sessions") return;
    loadSessionsRef.current?.().catch((err) => setStatus(`error: ${String(err)}`));
  }, [mainTab]);

  const uploadSessionToBrain = useCallback(
    async (sessionId: string) => {
      if (brainUploadPendingRef.current[sessionId]) return;
      brainUploadPendingRef.current = { ...brainUploadPendingRef.current, [sessionId]: true };
      setBrainUploadPendingBySession((prev) => ({ ...prev, [sessionId]: true }));
      try {
        setStatus("brain_uploading");
        await tauriInvoke<string>("brain_sync_upload_session", { sessionId });
        setStatus("brain_uploaded");
        await loadSessions();
      } catch (err) {
        const message = getErrorMessage(err).replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]");
        setStatus(`error: Brain upload failed: ${message}`);
        await loadSessions().catch(() => undefined);
      } finally {
        const next = { ...brainUploadPendingRef.current };
        delete next[sessionId];
        brainUploadPendingRef.current = next;
        setBrainUploadPendingBySession((prev) => {
          const updated = { ...prev };
          delete updated[sessionId];
          return updated;
        });
      }
    },
    [loadSessions],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f") return;
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      sessionSearchInputRef.current?.input?.focus();
      sessionSearchInputRef.current?.input?.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="app-shell mac-window mac-content" ref={appMainRef}>
      <div className="main-sticky-header">
        <div className="main-tabs" role="tablist" aria-label="Main sections">
          <button
            type="button"
            role="tab"
            className={`main-tab-button${mainTab === "sessions" ? " is-active" : ""}`}
            aria-selected={mainTab === "sessions"}
            onClick={() => handleTabSelect("sessions")}
          >
            Sessions
          </button>
          <button
            type="button"
            role="tab"
            className={`main-tab-button${mainTab === "settings" ? " is-active" : ""}`}
            aria-selected={mainTab === "settings"}
            onClick={() => handleTabSelect("settings")}
          >
            Settings
          </button>
          {showNewVersionTab && (
            <button
              type="button"
              role="tab"
              className={`main-tab-button${mainTab === "new-version" ? " is-active" : ""}`}
              aria-selected={mainTab === "new-version"}
              onClick={() => handleTabSelect("new-version")}
            >
              🔥 New version
            </button>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {transcriptionProvider === "nexara" && <NexaraBalance />}
            <TranscriptionProviderSelect onChange={setTranscriptionProvider} />
          </div>
        </div>
        {mainTab === "sessions" && (
          <SessionFilters
            ref={sessionSearchInputRef}
            searchQuery={sessionSearchQuery}
            onSearchChange={setSessionSearchQuery}
            onImportAudio={() => void importAudioSession()}
            onRefresh={() => {
              setRefreshKey((k) => k + 1);
              void loadSessions();
            }}
            refreshKey={refreshKey}
          />
        )}
      </div>

      <section
        className="panel"
        style={mainTab === "sessions" ? undefined : { display: "none" }}
      >
        <SessionList
          sessions={sessions}
          filteredSessions={filteredSessions}
          sessionDetails={sessionDetails}
          setSessionDetails={setSessionDetails}
          sessionSearchQuery={sessionSearchQuery}
          sessionArtifactSearchHits={sessionArtifactSearchHits}
          textPendingBySession={textPendingBySession}
          summaryPendingBySession={summaryPendingBySession}
          brainUploadPendingBySession={brainUploadPendingBySession}
          pipelineStateBySession={pipelineStateBySession}
          deleteTarget={deleteTarget}
          deletePendingSessionId={deletePendingSessionId}
          audioDeleteTargetSessionId={audioDeleteTargetSessionId}
          audioDeletePendingSessionId={audioDeletePendingSessionId}
          isSearching={isSearching}
          isInitialLoading={isInitialLoading}
          artifactPreview={artifactPreview}
          knownTags={knownTags}
          settings={null}
          transcriptionProvider={transcriptionProvider}
          setDeleteTarget={setDeleteTarget}
          setAudioDeleteTargetSessionId={setAudioDeleteTargetSessionId}
          confirmDeleteSession={async () => {
            await confirmDeleteSession();
            sessionSearchInputRef.current?.input?.focus();
          }}
          confirmDeleteAudio={confirmDeleteAudio}
          closeArtifactPreview={closeArtifactPreview}
          openSessionFolder={openSessionFolder}
          openSessionArtifact={openSessionArtifact}
          openArtifactInEditor={openArtifactInEditor}
          getText={getText}
          getSummary={getSummary}
          saveSessionDetails={saveSessionDetails}
          flushSessionDetails={flushSessionDetails}
          requestDeleteSession={requestDeleteSession}
          requestDeleteAudio={requestDeleteAudio}
          onUploadToBrain={(sessionId) => void uploadSessionToBrain(sessionId)}
          setStatus={setStatus}
        />
      </section>

      {settingsMounted && (
        <section
          className="panel"
          style={mainTab === "settings" ? undefined : { display: "none" }}
        >
          <SettingsPage brainUnlocked={brainUnlocked} />
        </section>
      )}
      {showNewVersionTab && updateInfo && (
        <section
          className="panel"
          style={mainTab === "new-version" ? undefined : { display: "none" }}
        >
          <NewVersionPage updateInfo={updateInfo} />
        </section>
      )}
      <div
        onClick={handleVersionTap}
        style={{
          textAlign: "center",
          paddingTop: 4,
          color: "var(--ant-color-text-quaternary, #999)",
          fontSize: 12,
          userSelect: "none",
        }}
      >
        v{packageJson.version}
      </div>
    </main>
  );
}
