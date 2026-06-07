import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionCard } from "./SessionCard";
import type { BrainUploadStatus, PipelineUiState, SessionListItem, SessionMetaView } from "../../types";

function makeItem(
  brainUploadStatus: BrainUploadStatus,
  overrides: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    session_id: "s-brain",
    status: "done",
    primary_tag: "slack",
    topic: "Brain sync",
    display_date_ru: "28.05.2026",
    started_at_iso: "2026-05-28T10:00:00+03:00",
    session_dir: "/tmp/s-brain",
    audio_file: "audio.mp3",
    audio_format: "mp3",
    audio_duration_hms: "00:01:00",
    has_transcript_text: true,
    has_summary_text: true,
    brain_upload_status: brainUploadStatus,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<SessionMetaView> = {}): SessionMetaView {
  return {
    session_id: "s-brain",
    source: "slack",
    notes: "",
    custom_summary_prompt: "",
    custom_summary_prompt_name: "",
    topic: "Brain sync",
    tags: [],
    num_speakers: null,
    ...overrides,
  };
}

function renderCard(
  item: SessionListItem,
  onUploadToBrain = vi.fn(),
  brainSyncReady = true,
  detailOverrides: Partial<SessionMetaView> = {},
) {
  const noop = () => undefined;
  const result = render(
    <SessionCard
      item={item}
      detail={makeDetail(detailOverrides)}
      textPending={false}
      summaryPending={false}
      pipelineState={undefined as PipelineUiState | undefined}
      searchQuery=""
      knownTagOptions={[]}
      transcriptMatch={false}
      summaryMatch={false}
      showNumSpeakers={false}
      brainUploadPending={false}
      brainSyncReady={brainSyncReady}
      onContextMenu={noop}
      onDetailChange={noop}
      onOpenArtifact={noop}
      onGetText={noop}
      onGetSummary={noop}
      onOpenSummaryPrompt={noop}
      onDelete={noop}
      onDeleteAudio={noop}
      onFieldBlur={noop}
      onOpenFolder={noop}
      onUploadToBrain={onUploadToBrain}
      onExportTodoist={noop}
      todoistPending={false}
      setStatus={noop}
    />,
  );
  return { ...result, onUploadToBrain };
}

describe("SessionCard Brain upload status", () => {
  it.each([
    ["uploaded", "Brain: загружено"],
    ["uploading", "Brain: загрузка"],
  ] as const)("renders %s label", (status, label) => {
    renderCard(makeItem(status));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("shows a red dot instead of a label for not-uploaded sessions", () => {
    const { container } = renderCard(makeItem("not_uploaded"));
    expect(screen.queryByText("Brain: не загружено")).not.toBeInTheDocument();
    expect(container.querySelector(".ant-badge-dot")).toBeInTheDocument();
  });

  it("hides the red dot only once the session is uploaded", () => {
    const failed = renderCard(makeItem("failed"));
    expect(failed.container.querySelector(".ant-badge-dot")).toBeInTheDocument();
    failed.unmount();

    const uploaded = renderCard(makeItem("uploaded"));
    expect(uploaded.container.querySelector(".ant-badge-dot")).not.toBeInTheDocument();
  });

  it("renders failed status as a label without leaking error details", () => {
    renderCard(makeItem("failed", {
      brain_upload_last_error: "Bearer eyJhbGciOiJIUzI1NiJ9.shortpayload.signature== was rejected",
    }));

    expect(screen.getByText("Brain: ошибка")).toBeInTheDocument();
    expect(screen.queryByText(/eyJhbGci/)).not.toBeInTheDocument();
  });

  it("hides the upload button when Brain sync is not ready", () => {
    renderCard(makeItem("not_uploaded"), vi.fn(), false);
    expect(screen.queryByRole("button", { name: "Загрузить в Brain" })).not.toBeInTheDocument();
  });

  it("shows upload button for not uploaded sessions with audio and calls callback", async () => {
    const user = userEvent.setup();
    const { onUploadToBrain } = renderCard(makeItem("not_uploaded"));

    await user.click(screen.getByRole("button", { name: "Загрузить в Brain" }));

    expect(onUploadToBrain).toHaveBeenCalledWith("s-brain");
  });

  it("shows upload button for failed sessions with audio", () => {
    renderCard(makeItem("failed"));
    expect(screen.getByRole("button", { name: "Загрузить в Brain" })).toBeEnabled();
  });

  it("disables upload button while uploading", () => {
    renderCard(makeItem("uploading"));
    expect(screen.getByRole("button", { name: "Загрузить в Brain" })).toBeDisabled();
  });

  it("enables retry for failed sessions reconciled by backend", () => {
    renderCard(makeItem("failed", {
      brain_upload_last_error: "Предыдущая загрузка Brain не завершилась. Можно повторить.",
    }));

    expect(screen.getByText("Brain: ошибка")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Загрузить в Brain" })).toBeEnabled();
  });

  it("disables upload button for sessions that are still recording", () => {
    renderCard(makeItem("not_uploaded", { status: "recording" }));
    expect(screen.getByRole("button", { name: "Загрузить в Brain" })).toBeDisabled();
  });

  it("uses local pending state to disable upload before backend refresh", () => {
    const noop = () => undefined;
    render(
      <SessionCard
        item={makeItem("not_uploaded")}
        detail={makeDetail()}
        textPending={false}
        summaryPending={false}
        pipelineState={undefined}
        searchQuery=""
        knownTagOptions={[]}
        transcriptMatch={false}
        summaryMatch={false}
        showNumSpeakers={false}
        brainUploadPending={true}
        brainSyncReady={true}
        onContextMenu={noop}
        onDetailChange={noop}
        onOpenArtifact={noop}
        onGetText={noop}
        onGetSummary={noop}
        onOpenSummaryPrompt={noop}
        onDelete={noop}
        onDeleteAudio={noop}
        onFieldBlur={noop}
        onOpenFolder={noop}
        onUploadToBrain={noop}
        onExportTodoist={noop}
        todoistPending={false}
        setStatus={noop}
      />,
    );

    expect(screen.getByText("Brain: загрузка")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Загрузить в Brain" })).toBeDisabled();
  });

  it("hides upload button for ingested uploaded sessions", () => {
    renderCard(makeItem("uploaded", { brain_server_ingested_once: true }));
    expect(screen.queryByRole("button", { name: "Загрузить в Brain" })).not.toBeInTheDocument();
  });

  it("shows upload button after failed retry even when session was ingested before", () => {
    renderCard(makeItem("failed", { brain_server_ingested_once: true }));
    expect(screen.getByRole("button", { name: "Загрузить в Brain" })).toBeEnabled();
  });

  it("hides upload button for sessions without audio", () => {
    renderCard(makeItem("not_uploaded", { audio_file: "", audio_format: "unknown" }));
    expect(screen.queryByRole("button", { name: "Загрузить в Brain" })).not.toBeInTheDocument();
  });

  it("marks the summary prompt button when a session uses a named prompt", () => {
    const { container } = renderCard(makeItem("uploaded"), vi.fn(), true, {
      custom_summary_prompt_name: "Actions",
    });

    expect(container.querySelector(".summary-prompt-dot")).toBeInTheDocument();
  });
});
