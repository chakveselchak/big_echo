import { useEffect, useMemo, useRef, useState } from "react";
import {
  DeleteTarget,
  PipelineUiState,
  SessionArtifactPreview,
  SessionListItem,
  SessionMetaView,
  StartResponse,
} from "../types";
import { captureAnalyticsEvent } from "../lib/analytics";
import { getErrorMessage, normalizeTags } from "../lib/appUtils";
import { tauriInvoke } from "../lib/tauri";

type SessionArtifactSearchHit = {
  transcript_match: boolean;
  summary_match: boolean;
};

type SessionArtifactReadResponse = {
  path: string;
  text: string;
};

type UseSessionsOptions = {
  setStatus: (status: string) => void;
  lastSessionId: string | null;
  setLastSessionId: (sessionId: string | null) => void;
};

function sameTags(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSessionMeta(left: SessionMetaView, right: SessionMetaView) {
  return (
    left.session_id === right.session_id &&
    left.source === right.source &&
    left.notes === right.notes &&
    (left.custom_summary_prompt ?? "") === (right.custom_summary_prompt ?? "") &&
    left.topic === right.topic &&
    sameTags(left.tags, right.tags)
  );
}

function sessionMetaSignature(meta: SessionMetaView) {
  return `${meta.session_id}\n${meta.source}\n${meta.notes}\n${meta.custom_summary_prompt ?? ""}\n${meta.topic}\n${meta.tags.join("\u001f")}`;
}

function normalizeSessionMeta(meta: SessionMetaView): SessionMetaView {
  return {
    ...meta,
    notes: meta.notes ?? "",
    custom_summary_prompt: meta.custom_summary_prompt ?? "",
    tags: meta.tags ?? [],
  };
}

function fallbackSessionMeta(item: SessionListItem): SessionMetaView {
  return {
    session_id: item.session_id,
    source: item.primary_tag,
    notes: "",
    custom_summary_prompt: "",
    topic: item.topic,
    tags: [],
  };
}

export function useSessions({ setStatus, lastSessionId, setLastSessionId }: UseSessionsOptions) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionDetails, setSessionDetails] = useState<Record<string, SessionMetaView>>({});
  const [savedSessionDetails, setSavedSessionDetails] = useState<Record<string, SessionMetaView>>({});
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [sessionArtifactSearchHits, setSessionArtifactSearchHits] = useState<Record<string, SessionArtifactSearchHit>>(
    {}
  );
  const [textPendingBySession, setTextPendingBySession] = useState<Record<string, boolean>>({});
  const [summaryPendingBySession, setSummaryPendingBySession] = useState<Record<string, boolean>>({});
  const [pipelineStateBySession, setPipelineStateBySession] = useState<Record<string, PipelineUiState>>({});
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deletePendingSessionId, setDeletePendingSessionId] = useState<string | null>(null);
  const [audioDeleteTargetSessionId, setAudioDeleteTargetSessionId] = useState<string | null>(null);
  const [audioDeletePendingSessionId, setAudioDeletePendingSessionId] = useState<string | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<SessionArtifactPreview | null>(null);
  const autosaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingAutosaveSignatureRef = useRef<Record<string, string>>({});
  const artifactSearchRequestIdRef = useRef(0);
  const knownTagsRequestIdRef = useRef(0);

  async function loadKnownTags() {
    const requestId = knownTagsRequestIdRef.current + 1;
    knownTagsRequestIdRef.current = requestId;
    const tags = await tauriInvoke<string[]>("list_known_tags");
    if (knownTagsRequestIdRef.current !== requestId) return;
    setKnownTags(normalizeTags(tags ?? []));
  }

  async function loadSessions() {
    const data = await tauriInvoke<SessionListItem[]>("list_sessions");
    setSessions(data);
    const details = await Promise.all(
      data.map(async (item) => {
        if (item.meta) {
          return [item.session_id, normalizeSessionMeta(item.meta)] as const;
        }
        try {
          const meta = await tauriInvoke<SessionMetaView>("get_session_meta", { sessionId: item.session_id });
          return [item.session_id, normalizeSessionMeta(meta)] as const;
        } catch {
          return [item.session_id, fallbackSessionMeta(item)] as const;
        }
      })
    );
    const nextDetails = Object.fromEntries(details);
    setSessionDetails(nextDetails);
    setSavedSessionDetails(nextDetails);
    await loadKnownTags().catch(() => undefined);
  }

  async function getText(sessionId: string) {
    void captureAnalyticsEvent("get_text_clicked", {
      session_id: sessionId,
      surface: "sessions",
    });
    setTextPendingBySession((prev) => ({ ...prev, [sessionId]: true }));
    setPipelineStateBySession((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    try {
      await tauriInvoke<string>("run_transcription", { sessionId });
      setPipelineStateBySession((prev) => ({
        ...prev,
        [sessionId]: { kind: "success", text: "Text fetched successfully" },
      }));
      setStatus("transcribed");
      await loadSessions();
    } catch (err) {
      const message = getErrorMessage(err);
      setPipelineStateBySession((prev) => ({
        ...prev,
        [sessionId]: { kind: "error", text: `Get text failed: ${message}` },
      }));
      setStatus(`error: ${message}`);
    } finally {
      setTextPendingBySession((prev) => ({ ...prev, [sessionId]: false }));
    }
  }

  async function getSummary(sessionId: string) {
    void captureAnalyticsEvent("get_summary_clicked", {
      session_id: sessionId,
      surface: "sessions",
      custom_prompt_present: Boolean(sessionDetails[sessionId]?.custom_summary_prompt?.trim()),
    });
    setSummaryPendingBySession((prev) => ({ ...prev, [sessionId]: true }));
    setPipelineStateBySession((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    try {
      const customPrompt = sessionDetails[sessionId]?.custom_summary_prompt?.trim() ?? "";
      await tauriInvoke<string>(
        "run_summary",
        customPrompt ? { sessionId, customPrompt } : { sessionId }
      );
      setPipelineStateBySession((prev) => ({
        ...prev,
        [sessionId]: { kind: "success", text: "Summary fetched successfully" },
      }));
      setStatus("done");
      await loadSessions();
    } catch (err) {
      const message = getErrorMessage(err);
      setPipelineStateBySession((prev) => ({
        ...prev,
        [sessionId]: { kind: "error", text: `Get summary failed: ${message}` },
      }));
      setStatus(`error: ${message}`);
    } finally {
      setSummaryPendingBySession((prev) => ({ ...prev, [sessionId]: false }));
    }
  }

  async function persistSessionDetails(sessionId: string, detail: SessionMetaView) {
    await tauriInvoke<string>("update_session_details", {
      payload: {
        session_id: sessionId,
        source: detail.source,
        notes: detail.notes,
        custom_summary_prompt: detail.custom_summary_prompt ?? "",
        topic: detail.topic,
        tags: detail.tags,
      },
    });
    setSavedSessionDetails((prev) => ({ ...prev, [sessionId]: detail }));
    await loadKnownTags().catch(() => undefined);
  }

  async function saveSessionDetails(sessionId: string, detail: SessionMetaView) {
    const normalized = normalizeSessionMeta(detail);
    const existing = autosaveTimersRef.current[sessionId];
    if (existing) {
      clearTimeout(existing);
      delete autosaveTimersRef.current[sessionId];
    }
    delete pendingAutosaveSignatureRef.current[sessionId];
    setSessionDetails((prev) => ({ ...prev, [sessionId]: normalized }));
    try {
      await persistSessionDetails(sessionId, normalized);
      setStatus("session_details_saved");
      return true;
    } catch (err) {
      setStatus(`error: ${String(err)}`);
      return false;
    }
  }

  /**
   * Immediate flush of the in-memory edit for `sessionId` to disk. Intended
   * to be called on field blur (Source/Topic/Tags/Notes) so that persistence
   * is triggered by the user finishing an edit rather than by mid-typing
   * debounces. No-op if the current meta matches the last saved copy.
   */
  async function flushSessionDetails(sessionId: string) {
    const current = sessionDetails[sessionId];
    const saved = savedSessionDetails[sessionId];
    if (!current) return;
    // Cancel any pending debounced save regardless — we either save now or
    // there's nothing to save.
    const existing = autosaveTimersRef.current[sessionId];
    if (existing) {
      clearTimeout(existing);
      delete autosaveTimersRef.current[sessionId];
    }
    delete pendingAutosaveSignatureRef.current[sessionId];
    if (saved && sameSessionMeta(current, saved)) {
      return;
    }
    try {
      await persistSessionDetails(sessionId, current);
      setStatus("session_details_saved");
    } catch (err) {
      setStatus(`error: ${String(err)}`);
    }
  }

  async function importAudioSession() {
    try {
      const imported = await tauriInvoke<StartResponse | null>("import_audio_session");
      if (!imported) return;
      setLastSessionId(imported.session_id);
      setStatus("audio_imported");
      await loadSessions();
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
    }
  }

  async function openSessionFolder(sessionDir: string) {
    await tauriInvoke<string>("open_session_folder", { sessionDir });
  }

  async function openSessionArtifact(sessionId: string, artifactKind: "transcript" | "summary") {
    const query = sessionSearchQuery.trim();
    const artifactHit = sessionArtifactSearchHits[sessionId];
    const hasArtifactMatch =
      query !== "" &&
      Boolean(
        artifactKind === "transcript" ? artifactHit?.transcript_match : artifactHit?.summary_match
      );

    if (hasArtifactMatch) {
      try {
        const preview = await tauriInvoke<SessionArtifactReadResponse>("read_session_artifact", {
          sessionId,
          artifactKind,
        });
        setArtifactPreview({
          sessionId,
          artifactKind,
          path: preview.path,
          text: preview.text,
          query,
        });
      } catch (err) {
        setStatus(`error: ${getErrorMessage(err)}`);
      }
      return;
    }

    try {
      await tauriInvoke<string>("open_session_artifact", { sessionId, artifactKind });
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
    }
  }

  function requestDeleteSession(sessionId: string, force: boolean) {
    setDeleteTarget({ sessionId, force });
  }

  async function confirmDeleteSession() {
    if (!deleteTarget) return;
    const sessionId = deleteTarget.sessionId;
    setDeletePendingSessionId(sessionId);
    try {
      await tauriInvoke<string>("delete_session", { sessionId, force: deleteTarget.force });
      setSessions((prev) => prev.filter((item) => item.session_id !== sessionId));
      setSessionDetails((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSavedSessionDetails((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setTextPendingBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSummaryPendingBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setPipelineStateBySession((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      if (lastSessionId === sessionId) {
        setLastSessionId(null);
      }
      setDeleteTarget(null);
      setStatus("session_deleted");
      await loadKnownTags().catch(() => undefined);
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
    } finally {
      setDeletePendingSessionId(null);
    }
  }

  function requestDeleteAudio(sessionId: string) {
    setAudioDeleteTargetSessionId(sessionId);
  }

  async function confirmDeleteAudio() {
    if (!audioDeleteTargetSessionId) return;
    const sessionId = audioDeleteTargetSessionId;
    setAudioDeletePendingSessionId(sessionId);
    try {
      await tauriInvoke("delete_session_audio", { sessionId });
      // Refresh the session list so the backend-mutated meta.json propagates
      // to the UI (audio_file becomes empty → AudioPlayer hides itself).
      await loadSessions();
      setAudioDeleteTargetSessionId(null);
      setStatus("audio_deleted");
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
    } finally {
      setAudioDeletePendingSessionId(null);
    }
  }

  useEffect(() => {
    const query = sessionSearchQuery.trim();
    if (!query || sessions.length === 0) {
      setSessionArtifactSearchHits({});
      return;
    }

    const requestId = artifactSearchRequestIdRef.current + 1;
    artifactSearchRequestIdRef.current = requestId;
    const timer = setTimeout(() => {
      void tauriInvoke<Record<string, SessionArtifactSearchHit>>("search_session_artifacts", { query })
        .then((hits) => {
          if (artifactSearchRequestIdRef.current !== requestId) return;
          setSessionArtifactSearchHits(hits ?? {});
        })
        .catch(() => {
          if (artifactSearchRequestIdRef.current !== requestId) return;
          setSessionArtifactSearchHits({});
        });
    }, 180);

    return () => clearTimeout(timer);
  }, [sessionSearchQuery, sessions]);

  useEffect(() => {
    const ids = Object.keys(sessionDetails);
    for (const sessionId of ids) {
      const current = sessionDetails[sessionId];
      const saved = savedSessionDetails[sessionId];
      if (!saved) continue;

      if (sameSessionMeta(current, saved)) {
        delete pendingAutosaveSignatureRef.current[sessionId];
        continue;
      }

      const signature = sessionMetaSignature(current);
      if (pendingAutosaveSignatureRef.current[sessionId] === signature) continue;

      const existing = autosaveTimersRef.current[sessionId];
      if (existing) clearTimeout(existing);
      pendingAutosaveSignatureRef.current[sessionId] = signature;

      // Safety fallback only — the primary trigger for persistence is now
      // `flushSessionDetails(sessionId)` called on field blur (see
      // SessionCard). This long debounce just protects from data loss if the
      // user leaves the app without blurring.
      autosaveTimersRef.current[sessionId] = setTimeout(async () => {
        try {
          await persistSessionDetails(sessionId, current);
          setStatus("session_details_autosaved");
        } catch (err) {
          setStatus(`error: ${String(err)}`);
        } finally {
          delete autosaveTimersRef.current[sessionId];
          delete pendingAutosaveSignatureRef.current[sessionId];
        }
      }, 10_000);
    }

    for (const sessionId of Object.keys(autosaveTimersRef.current)) {
      if (sessionId in sessionDetails) continue;
      clearTimeout(autosaveTimersRef.current[sessionId]);
      delete autosaveTimersRef.current[sessionId];
      delete pendingAutosaveSignatureRef.current[sessionId];
    }
  }, [savedSessionDetails, sessionDetails, setStatus]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(autosaveTimersRef.current)) {
        clearTimeout(timer);
      }
    };
  }, []);

  // Safety: if the user closes the app / tab with unsaved edits, flush every
  // pending change synchronously. Uses `pagehide` + `visibilitychange` which
  // are more reliable than `beforeunload` inside the Tauri WebView.
  useEffect(() => {
    const flushAll = () => {
      for (const sessionId of Object.keys(sessionDetails)) {
        const current = sessionDetails[sessionId];
        const saved = savedSessionDetails[sessionId];
        if (!current) continue;
        if (saved && sameSessionMeta(current, saved)) continue;
        // Fire-and-forget: browser doesn't await pagehide handlers, but the
        // underlying Tauri IPC call is queued and usually completes before
        // the process exits.
        void tauriInvoke<string>("update_session_details", {
          payload: {
            session_id: sessionId,
            source: current.source,
            notes: current.notes,
            custom_summary_prompt: current.custom_summary_prompt ?? "",
            topic: current.topic,
            tags: current.tags,
          },
        }).catch(() => undefined);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushAll();
    };
    window.addEventListener("pagehide", flushAll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flushAll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionDetails, savedSessionDetails]);

  // Prune all per-session Record state whenever the sessions list changes.
  // Without this, keys for deleted or filtered-out sessions stay in
  // sessionDetails/savedSessionDetails/pipelineStateBySession/etc. forever
  // and grow with every delete → reload cycle. At 1000 sessions each Record
  // can easily reach ~100 KB; this effect keeps them bounded to the live set.
  useEffect(() => {
    const validIds = new Set(sessions.map((s) => s.session_id));

    const prune = <T,>(record: Record<string, T>): Record<string, T> | null => {
      let staleKeys: string[] | null = null;
      for (const id of Object.keys(record)) {
        if (!validIds.has(id)) {
          (staleKeys ??= []).push(id);
        }
      }
      if (!staleKeys) return null;
      const next: Record<string, T> = {};
      for (const [id, val] of Object.entries(record)) {
        if (validIds.has(id)) next[id] = val;
      }
      return next;
    };

    // For each state slice: if no stale keys, return the same reference —
    // React skips the re-render (Object.is(prev, next) === true).
    setSessionDetails((prev) => prune(prev) ?? prev);
    setSavedSessionDetails((prev) => prune(prev) ?? prev);
    setSessionArtifactSearchHits((prev) => prune(prev) ?? prev);
    setTextPendingBySession((prev) => prune(prev) ?? prev);
    setSummaryPendingBySession((prev) => prune(prev) ?? prev);
    setPipelineStateBySession((prev) => prune(prev) ?? prev);

    // Refs don't trigger re-renders, but still hold memory. Clear any
    // lingering autosave timers for deleted sessions.
    for (const id of Object.keys(autosaveTimersRef.current)) {
      if (!validIds.has(id)) {
        clearTimeout(autosaveTimersRef.current[id]);
        delete autosaveTimersRef.current[id];
      }
    }
    for (const id of Object.keys(pendingAutosaveSignatureRef.current)) {
      if (!validIds.has(id)) {
        delete pendingAutosaveSignatureRef.current[id];
      }
    }
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const query = sessionSearchQuery.trim().toLowerCase();
    return sessions.filter((item) => {
      const detail = sessionDetails[item.session_id];
      const sourceValue = (detail?.source ?? item.primary_tag).toLowerCase();
      const notesValue = (detail?.notes ?? "").toLowerCase();
      const topicValue = (detail?.topic ?? item.topic ?? "").toLowerCase();
      const tagsValue = (detail?.tags ?? []).join(", ").toLowerCase();
      const pathValue = item.session_dir.toLowerCase();
      const statusValue = item.status.toLowerCase();
      const dateValue = item.display_date_ru.toLowerCase();
      const artifactHit = sessionArtifactSearchHits[item.session_id];
      const artifactTextMatch = Boolean(artifactHit?.transcript_match || artifactHit?.summary_match);
      if (!query) return true;
      return (
        sourceValue.includes(query) ||
        notesValue.includes(query) ||
        topicValue.includes(query) ||
        tagsValue.includes(query) ||
        pathValue.includes(query) ||
        statusValue.includes(query) ||
        dateValue.includes(query) ||
        artifactTextMatch
      );
    });
  }, [sessionArtifactSearchHits, sessionDetails, sessionSearchQuery, sessions]);

  return {
    artifactPreview,
    audioDeletePendingSessionId,
    audioDeleteTargetSessionId,
    closeArtifactPreview: () => setArtifactPreview(null),
    confirmDeleteAudio,
    confirmDeleteSession,
    deletePendingSessionId,
    deleteTarget,
    filteredSessions,
    flushSessionDetails,
    getSummary,
    getText,
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
  };
}
