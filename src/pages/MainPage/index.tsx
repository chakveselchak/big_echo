import { useEffect, useRef, useState } from "react";
import type { InputRef } from "antd";
import { useRecordingController } from "../../hooks/useRecordingController";
import { useSessions } from "../../hooks/useSessions";
import { initializeAnalytics } from "../../lib/analytics";
import { getCurrentWindowLabel, tauriInvoke } from "../../lib/tauri";
import type { StartResponse } from "../../types";
import { SessionFilters } from "../../components/sessions/SessionFilters";
import { SessionList } from "../../components/sessions/SessionList";
import { SettingsPage } from "../SettingsPage";

type MainTab = "sessions" | "settings";

export function MainPage() {
  const [mainTab, setMainTab] = useState<MainTab>("sessions");
  const [topic, setTopic] = useState("");
  const [source, setSource] = useState("slack");
  const [session, setSession] = useState<StartResponse | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [refreshKey, setRefreshKey] = useState(0);
  const sessionSearchInputRef = useRef<InputRef | null>(null);
  const loadSessionsRef = useRef<(() => Promise<void>) | null>(null);
  const appMainRef = useRef<HTMLElement | null>(null);

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
    knownTags,
    loadSessions,
    openSessionFolder,
    openSessionArtifact,
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

  useEffect(() => {
    if (mainTab !== "sessions") return;
    loadSessionsRef.current?.().catch((err) => setStatus(`error: ${String(err)}`));
  }, [mainTab]);

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
          <SettingsPage />
        </section>
      ) : (
        <section className="panel">
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
          <SessionList
            sessions={sessions}
            filteredSessions={filteredSessions}
            sessionDetails={sessionDetails}
            setSessionDetails={setSessionDetails}
            sessionSearchQuery={sessionSearchQuery}
            sessionArtifactSearchHits={sessionArtifactSearchHits}
            textPendingBySession={textPendingBySession}
            summaryPendingBySession={summaryPendingBySession}
            pipelineStateBySession={pipelineStateBySession}
            deleteTarget={deleteTarget}
            deletePendingSessionId={deletePendingSessionId}
            audioDeleteTargetSessionId={audioDeleteTargetSessionId}
            audioDeletePendingSessionId={audioDeletePendingSessionId}
            isSearching={isSearching}
            artifactPreview={artifactPreview}
            knownTags={knownTags}
            settings={null}
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
            getText={getText}
            getSummary={getSummary}
            saveSessionDetails={saveSessionDetails}
            flushSessionDetails={flushSessionDetails}
            requestDeleteSession={requestDeleteSession}
            requestDeleteAudio={requestDeleteAudio}
            setStatus={setStatus}
          />
        </section>
      )}
    </main>
  );
}
