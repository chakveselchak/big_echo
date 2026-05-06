import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import {
  LiveInputLevels,
  RecordingInputChannel,
  RecordingMuteState,
  StartResponse,
  UiSyncStateView,
} from "../types";
import { captureAnalyticsEvent } from "../lib/analytics";
import { clamp01, parseEventPayload, splitTags } from "../lib/appUtils";
import { tauriEmit, tauriInvoke, tauriListen } from "../lib/tauri";
import { defaultRecordingMuteState, nextRecordingMuteState } from "../lib/trayAudio";

const UI_SYNC_DEBOUNCE_MS = 150;
const TRAY_LEVELS_IDLE_POLL_MS = 280;
const TRAY_LEVELS_RECORDING_POLL_MS = 120;

type Setter<T> = Dispatch<SetStateAction<T>>;

type UseRecordingControllerOptions = {
  enableTrayCommandListeners?: boolean;
  isSettingsWindow: boolean;
  isTrayWindow: boolean;
  topic: string;
  setTopic: Setter<string>;
  tagsInput: string;
  source: string;
  setSource: Setter<string>;
  notesInput: string;
  session: StartResponse | null;
  setSession: Setter<StartResponse | null>;
  lastSessionId: string | null;
  setLastSessionId: Setter<string | null>;
  status: string;
  setStatus: Setter<string>;
  loadSessions: () => Promise<void>;
  flushPendingSessionDetails?: (sessionId: string) => Promise<void>;
};

function formatRecordingError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function useRecordingController({
  enableTrayCommandListeners = true,
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
  flushPendingSessionDetails,
}: UseRecordingControllerOptions) {
  const [liveLevels, setLiveLevels] = useState<LiveInputLevels>({ mic: 0, system: 0 });
  const [muteState, setMuteState] = useState<RecordingMuteState>(defaultRecordingMuteState);
  const [uiSyncReady, setUiSyncReady] = useState(isSettingsWindow);
  const muteStateRef = useRef<RecordingMuteState>(defaultRecordingMuteState);
  const muteMutationTokenRef = useRef(0);
  const topicRef = useRef(topic);
  const sourceRef = useRef(source);
  const sessionRef = useRef<StartResponse | null>(session);
  const trayTopicAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trayTopicSavedSignatureRef = useRef<string>("");
  const uiSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUiSyncPayloadRef = useRef<{ source: string; topic: string } | null>(null);
  const flushPendingSessionDetailsRef = useRef(flushPendingSessionDetails);
  useEffect(() => {
    flushPendingSessionDetailsRef.current = flushPendingSessionDetails;
  }, [flushPendingSessionDetails]);
  const stoppingRef = useRef(false);

  useEffect(() => {
    topicRef.current = topic;
    sourceRef.current = source;
    sessionRef.current = session;
  }, [session, source, topic]);

  useEffect(() => {
    muteStateRef.current = muteState;
  }, [muteState]);

  function resetMuteState() {
    muteMutationTokenRef.current += 1;
    muteStateRef.current = defaultRecordingMuteState;
    setMuteState(defaultRecordingMuteState);
  }

  function applyMuteState(nextMuteState: RecordingMuteState) {
    muteMutationTokenRef.current += 1;
    muteStateRef.current = nextMuteState;
    setMuteState(nextMuteState);
  }

  function setRecordingSession(sessionId: string) {
    if (sessionRef.current?.session_id === sessionId) {
      setLastSessionId(sessionId);
      return;
    }

    const nextSession = {
      session_id: sessionId,
      session_dir: "",
      status: "recording",
    };
    resetMuteState();
    sessionRef.current = nextSession;
    setSession(nextSession);
    setLastSessionId(sessionId);
  }

  async function startRecording(payload: {
    source: string;
    notes?: string;
    topic?: string;
    tags?: string[];
    surface?: string;
  }) {
    void captureAnalyticsEvent("rec_clicked", {
      source: payload.source,
      surface: payload.surface ?? (isTrayWindow ? "tray" : "main"),
      notes_present: Boolean(payload.notes?.trim()),
      topic_present: Boolean(payload.topic?.trim()),
      tags_count: payload.tags?.length ?? 0,
    });
    const response = await tauriInvoke<StartResponse>("start_recording", {
      payload: {
        source: payload.source,
        tags: payload.tags ?? [],
        notes: payload.notes ?? "",
        topic: payload.topic ?? "",
      },
    });
    setRecordingSession(response.session_id);
    setStatus("recording");
    await loadSessions();
  }

  async function start() {
    await startRecording({
      source,
      notes: notesInput,
      topic,
      tags: splitTags(tagsInput),
      surface: "main",
    });
  }

  async function startFromTray() {
    try {
      await startRecording({
        source,
        topic,
        tags: [],
        notes: "",
        surface: "tray",
      });
    } catch (err) {
      setStatus(`error: ${formatRecordingError(err)}`);
    }
  }

  async function stop() {
    if (!session) return;
    const sessionId = session.session_id;
    // Block the tray autosave effect from scheduling a late debounce while
    // we're in the flush → stop_recording sequence. Reset on reject so
    // retries behave normally.
    stoppingRef.current = true;

    // Flush tray-side debounced topic autosave synchronously.
    if (isTrayWindow) {
      if (trayTopicAutosaveTimerRef.current) {
        clearTimeout(trayTopicAutosaveTimerRef.current);
        trayTopicAutosaveTimerRef.current = null;
      }
      const trimmedTopic = topic.trim();
      const signature = `${sessionId}::${source}::${trimmedTopic}`;
      if (signature !== trayTopicSavedSignatureRef.current) {
        try {
          await tauriInvoke<string>("update_session_details", {
            payload: {
              session_id: sessionId,
              source,
              notes: "",
              topic: trimmedTopic,
              tags: [],
              num_speakers: null,
            },
          });
          trayTopicSavedSignatureRef.current = signature;
        } catch {
          // Swallow — recorder must stop even if metadata flush fails.
        }
      }
    }

    if (flushPendingSessionDetails) {
      try {
        await flushPendingSessionDetails(sessionId);
      } catch {
        // Swallow — recorder must stop even if flush fails.
      }
    }

    try {
      await tauriInvoke<string>("stop_recording", { sessionId });
    } catch (err) {
      stoppingRef.current = false;
      throw err;
    }
    resetMuteState();
    setStatus("recorded");
    setSession(null);
    if (isTrayWindow) {
      setTopic("");
    }
    stoppingRef.current = false;
    await loadSessions();
  }

  async function runPipeline() {
    if (!lastSessionId) return;
    await tauriInvoke<string>("run_pipeline", { sessionId: lastSessionId });
    setStatus("done");
    await loadSessions();
  }

  async function toggleInputMuted(channel: RecordingInputChannel) {
    if (status !== "recording") return;
    const sessionId = sessionRef.current?.session_id;
    if (!sessionId) return;
    const requestToken = ++muteMutationTokenRef.current;
    const previousMuteState = muteStateRef.current;
    const muted = channel === "mic" ? !previousMuteState.micMuted : !previousMuteState.systemMuted;
    const optimisticState = nextRecordingMuteState(previousMuteState, channel, muted);
    muteStateRef.current = optimisticState;
    setMuteState(optimisticState);
    try {
      const next = await tauriInvoke<RecordingMuteState>("set_recording_input_muted", {
        sessionId,
        channel,
        muted,
      });
      if (requestToken !== muteMutationTokenRef.current) return;
      if (sessionRef.current?.session_id !== sessionId) return;
      const resolvedState = next ?? optimisticState;
      muteStateRef.current = resolvedState;
      setMuteState(resolvedState);
    } catch (error) {
      if (requestToken !== muteMutationTokenRef.current) return;
      if (sessionRef.current?.session_id !== sessionId) return;
      muteStateRef.current = previousMuteState;
      setMuteState(previousMuteState);
      throw error;
    }
  }

  useEffect(() => {
    if (!isTrayWindow) return;
    let active = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const levels = await tauriInvoke<LiveInputLevels>("get_live_input_levels");
        if (!active) return;
        const nextLevels = {
          mic: clamp01(levels.mic),
          system: clamp01(levels.system),
        };
        setLiveLevels((prev) =>
          prev.mic === nextLevels.mic && prev.system === nextLevels.system ? prev : nextLevels
        );
      } catch {
        if (!active) return;
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const intervalMs = status === "recording" ? TRAY_LEVELS_RECORDING_POLL_MS : TRAY_LEVELS_IDLE_POLL_MS;
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [isTrayWindow, status]);

  useEffect(() => {
    if (isSettingsWindow) return;
    let active = true;
    tauriInvoke<UiSyncStateView>("get_ui_sync_state")
      .then((current) => {
        if (!active) return;
        const syncedSource = current.source?.trim() || sourceRef.current;
        const syncedTopic = current.topic ?? "";
        lastUiSyncPayloadRef.current = {
          source: syncedSource,
          topic: syncedTopic,
        };
        if (current.source?.trim()) setSource(syncedSource);
        setTopic(syncedTopic);
        if (current.is_recording) {
          if (current.active_session_id) {
            setRecordingSession(current.active_session_id);
            applyMuteState(current.mute_state ?? defaultRecordingMuteState);
          } else {
            resetMuteState();
          }
          setStatus("recording");
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setUiSyncReady(true);
      });
    return () => {
      active = false;
    };
  }, [isSettingsWindow, setLastSessionId, setSession, setSource, setStatus, setTopic]);

  useEffect(() => {
    let unlistenStart: (() => void) | undefined;
    let unlistenStop: (() => void) | undefined;
    let unlistenUiSync: (() => void) | undefined;
    let unlistenUiRecording: (() => void) | undefined;

    if (enableTrayCommandListeners) {
      tauriListen("tray:start", async () => {
        try {
          await startRecording({
            source: sourceRef.current,
            topic: topicRef.current,
            tags: [],
            notes: "",
            surface: "tray_event",
          });
        } catch (err) {
          setStatus(`error: ${formatRecordingError(err)}`);
        }
      }).then((fn) => {
        unlistenStart = fn;
      });

      tauriListen("tray:stop", async () => {
        try {
          if (!sessionRef.current) return;
          const sessionId = sessionRef.current.session_id;
          const flush = flushPendingSessionDetailsRef.current;
          if (flush) {
            try {
              await flush(sessionId);
            } catch {
              // Swallow — recorder must stop even if flush fails.
            }
          }
          await tauriInvoke<string>("stop_recording", { sessionId });
          resetMuteState();
          setStatus("recorded");
          setSession(null);
          await loadSessions();
        } catch (err) {
          setStatus(`error: ${formatRecordingError(err)}`);
        }
      }).then((fn) => {
        unlistenStop = fn;
      });
    }

    tauriListen("ui:sync", (event) => {
      const payload = parseEventPayload<{ source?: string; topic?: string }>(event);
      if (!payload) return;
      const nextSource =
        typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : sourceRef.current;
      const nextTopic = typeof payload.topic === "string" ? payload.topic : topicRef.current;
      lastUiSyncPayloadRef.current = {
        source: nextSource,
        topic: nextTopic,
      };
      if (typeof payload.source === "string" && payload.source.trim() && payload.source !== sourceRef.current) {
        setSource(payload.source);
      }
      if (typeof payload.topic === "string" && payload.topic !== topicRef.current) {
        setTopic(payload.topic);
      }
    }).then((fn) => {
      unlistenUiSync = fn;
    });

    tauriListen("ui:recording", (event) => {
      const payload = parseEventPayload<{ recording?: boolean; sessionId?: string | null }>(event);
      if (!payload || typeof payload.recording !== "boolean") return;
      if (payload.recording) {
        const sessionId = payload.sessionId;
        if (!sessionId) return;
        setRecordingSession(sessionId);
        setStatus("recording");
      } else {
        resetMuteState();
        setSession(null);
        setStatus((prev) => (prev === "recording" ? "recorded" : prev));
      }
    }).then((fn) => {
      unlistenUiRecording = fn;
    });

    return () => {
      if (unlistenStart) unlistenStart();
      if (unlistenStop) unlistenStop();
      if (unlistenUiSync) unlistenUiSync();
      if (unlistenUiRecording) unlistenUiRecording();
    };
  }, [enableTrayCommandListeners, loadSessions, setLastSessionId, setSession, setSource, setStatus, setTopic]);

  useEffect(() => {
    if (isSettingsWindow) return;
    const recording = status === "recording";
    tauriEmit("recording:status", { recording }).catch(() => undefined);
    tauriEmit("ui:recording", {
      recording,
      sessionId: recording ? (session?.session_id ?? null) : null,
    }).catch(() => undefined);
  }, [isSettingsWindow, session, status]);

  useEffect(() => {
    if (isSettingsWindow || !uiSyncReady) return;
    if (uiSyncTimerRef.current) clearTimeout(uiSyncTimerRef.current);
    uiSyncTimerRef.current = setTimeout(() => {
      if (
        lastUiSyncPayloadRef.current?.source === source &&
        lastUiSyncPayloadRef.current?.topic === topic
      ) {
        return;
      }
      lastUiSyncPayloadRef.current = { source, topic };
      tauriInvoke("set_ui_sync_state", { source, topic }).catch(() => undefined);
      tauriEmit("ui:sync", { source, topic }).catch(() => undefined);
    }, UI_SYNC_DEBOUNCE_MS);
    return () => {
      if (uiSyncTimerRef.current) clearTimeout(uiSyncTimerRef.current);
    };
  }, [isSettingsWindow, source, topic, uiSyncReady]);

  useEffect(() => {
    if (!isTrayWindow || status !== "recording" || !session?.session_id) return;
    if (stoppingRef.current) return;
    const signature = `${session.session_id}::${source}::${topic}`;
    if (signature === trayTopicSavedSignatureRef.current) return;
    if (trayTopicAutosaveTimerRef.current) clearTimeout(trayTopicAutosaveTimerRef.current);

    trayTopicAutosaveTimerRef.current = setTimeout(async () => {
      try {
        await tauriInvoke<string>("update_session_details", {
          payload: {
            session_id: session.session_id,
            source,
            notes: "",
            topic: topic.trim(),
            tags: [],
            num_speakers: null,
          },
        });
        trayTopicSavedSignatureRef.current = signature;
      } catch {
        // Keep recorder responsive even if metadata update fails.
      }
    }, 450);

    return () => {
      if (trayTopicAutosaveTimerRef.current) clearTimeout(trayTopicAutosaveTimerRef.current);
    };
  }, [isTrayWindow, session?.session_id, source, status, topic]);

  return {
    liveLevels,
    muteState,
    runPipeline,
    start,
    startFromTray,
    toggleInputMuted,
    stop,
    uiSyncReady,
  };
}
