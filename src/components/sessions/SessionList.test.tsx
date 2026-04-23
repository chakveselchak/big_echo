import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { SessionList } from "./SessionList";
import type { SessionListItem } from "../../types";

vi.mock("./SessionCard", () => ({
  SessionCard: ({ item }: { item: SessionListItem }) => (
    <div data-testid="session-card" data-session-id={item.session_id} />
  ),
}));

vi.mock("./DeleteConfirmModal", () => ({
  DeleteConfirmModal: () => null,
}));

vi.mock("./ArtifactModal", () => ({
  ArtifactModal: () => null,
}));

vi.mock("./SummaryPromptModal", () => ({
  SummaryPromptModal: () => null,
}));

type IOInstance = {
  cb: IntersectionObserverCallback;
  opts?: IntersectionObserverInit;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

const ioInstances: IOInstance[] = [];

class MockIntersectionObserver {
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    const inst: IOInstance = {
      cb,
      opts,
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
    ioInstances.push(inst);
    Object.assign(this, inst);
  }
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}

beforeEach(() => {
  ioInstances.length = 0;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeSession(i: number): SessionListItem {
  return {
    session_id: `s-${i}`,
    status: "done",
    primary_tag: "slack",
    topic: `Topic ${i}`,
    display_date_ru: "01.01.2026",
    started_at_iso: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    session_dir: `/tmp/s-${i}`,
    audio_file: "",
    audio_format: "unknown",
    audio_duration_hms: "00:00:00",
    has_transcript_text: false,
    has_summary_text: false,
  };
}

function renderList(
  sessions: SessionListItem[],
  overrides: Partial<ComponentProps<typeof SessionList>> = {},
) {
  const noop = () => undefined;
  const noopAsync = async () => undefined;
  const props: ComponentProps<typeof SessionList> = {
    sessions,
    filteredSessions: sessions,
    sessionDetails: {},
    setSessionDetails: noop,
    sessionSearchQuery: "",
    sessionArtifactSearchHits: {},
    textPendingBySession: {},
    summaryPendingBySession: {},
    pipelineStateBySession: {},
    deleteTarget: null,
    deletePendingSessionId: null,
    audioDeleteTargetSessionId: null,
    audioDeletePendingSessionId: null,
    isSearching: false,
    isInitialLoading: false,
    artifactPreview: null,
    knownTags: [],
    settings: null,
    setDeleteTarget: noop,
    setAudioDeleteTargetSessionId: noop,
    confirmDeleteSession: noopAsync,
    confirmDeleteAudio: noopAsync,
    closeArtifactPreview: noop,
    openSessionFolder: noop,
    openSessionArtifact: noop,
    getText: noop,
    getSummary: noop,
    saveSessionDetails: async () => true,
    flushSessionDetails: noop,
    requestDeleteSession: noop,
    requestDeleteAudio: noop,
    setStatus: noop,
    ...overrides,
  };
  return render(<SessionList {...props} />);
}

describe("SessionList lazy loading", () => {
  it("renders only the first 20 cards when there are more than 20 sessions", () => {
    const sessions = Array.from({ length: 25 }, (_, i) => makeSession(i));
    renderList(sessions);
    expect(screen.getAllByTestId("session-card")).toHaveLength(20);
  });

  it("loads 40 more cards when the sentinel intersects the viewport", () => {
    const sessions = Array.from({ length: 100 }, (_, i) => makeSession(i));
    renderList(sessions);
    expect(screen.getAllByTestId("session-card")).toHaveLength(20);
    expect(ioInstances).toHaveLength(1);

    act(() => {
      ioInstances[0].cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        ioInstances[0] as unknown as IntersectionObserver,
      );
    });

    expect(screen.getAllByTestId("session-card")).toHaveLength(60);
    // Observer is reused across batch loads — not torn down on visibleCount
    // change. Locks in that we don't fall back to per-render observer
    // recreation (which is the WebKit drop-callback failure mode).
    expect(ioInstances).toHaveLength(1);
  });

  it("clamps the next batch to filteredSessions.length", () => {
    const sessions = Array.from({ length: 25 }, (_, i) => makeSession(i));
    renderList(sessions);
    expect(screen.getAllByTestId("session-card")).toHaveLength(20);

    act(() => {
      ioInstances[0].cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        ioInstances[0] as unknown as IntersectionObserver,
      );
    });

    expect(screen.getAllByTestId("session-card")).toHaveLength(25);
  });

  it("renders all filtered sessions and creates no observer when search is active", () => {
    const sessions = Array.from({ length: 50 }, (_, i) => makeSession(i));
    const filtered = sessions.slice(0, 30);
    renderList(sessions, {
      filteredSessions: filtered,
      sessionSearchQuery: "topic",
    });
    expect(screen.getAllByTestId("session-card")).toHaveLength(30);
    expect(ioInstances).toHaveLength(0);
  });

  it("renders no sentinel and no observer when filteredSessions.length === INITIAL_VISIBLE", () => {
    renderList(Array.from({ length: 20 }, (_, i) => makeSession(i)));
    expect(screen.getAllByTestId("session-card")).toHaveLength(20);
    expect(ioInstances).toHaveLength(0);
  });

  it("does not over-render when filteredSessions shrinks below visibleCount", () => {
    const sessions = Array.from({ length: 100 }, (_, i) => makeSession(i));
    const { rerender } = renderList(sessions);

    act(() => {
      ioInstances[0].cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        ioInstances[0] as unknown as IntersectionObserver,
      );
    });
    expect(screen.getAllByTestId("session-card")).toHaveLength(60);

    const noop = () => undefined;
    const noopAsync = async () => undefined;
    const shrunk = sessions.slice(0, 30);
    rerender(
      <SessionList
        sessions={sessions}
        filteredSessions={shrunk}
        sessionDetails={{}}
        setSessionDetails={noop}
        sessionSearchQuery=""
        sessionArtifactSearchHits={{}}
        textPendingBySession={{}}
        summaryPendingBySession={{}}
        pipelineStateBySession={{}}
        deleteTarget={null}
        deletePendingSessionId={null}
        audioDeleteTargetSessionId={null}
        audioDeletePendingSessionId={null}
        isSearching={false}
        isInitialLoading={false}
        artifactPreview={null}
        knownTags={[]}
        settings={null}
        setDeleteTarget={noop}
        setAudioDeleteTargetSessionId={noop}
        confirmDeleteSession={noopAsync}
        confirmDeleteAudio={noopAsync}
        closeArtifactPreview={noop}
        openSessionFolder={noop}
        openSessionArtifact={noop}
        getText={noop}
        getSummary={noop}
        saveSessionDetails={async () => true}
        flushSessionDetails={noop}
        requestDeleteSession={noop}
        requestDeleteAudio={noop}
        setStatus={noop}
      />,
    );

    expect(screen.getAllByTestId("session-card")).toHaveLength(30);
  });
});
