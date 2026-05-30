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

function makeDetail(): SessionMetaView {
  return {
    session_id: "s-brain",
    source: "slack",
    notes: "",
    custom_summary_prompt: "",
    topic: "Brain sync",
    tags: [],
    num_speakers: null,
  };
}

function renderCard(item: SessionListItem, onUploadToBrain = vi.fn()) {
  const noop = () => undefined;
  const result = render(
    <SessionCard
      item={item}
      detail={makeDetail()}
      textPending={false}
      summaryPending={false}
      pipelineState={undefined as PipelineUiState | undefined}
      searchQuery=""
      knownTagOptions={[]}
      transcriptMatch={false}
      summaryMatch={false}
      showNumSpeakers={false}
      brainUploadPending={false}
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
      setStatus={noop}
    />,
  );
  return { ...result, onUploadToBrain };
}

describe("SessionCard Brain upload status", () => {
  it.each([
    ["uploaded", "Brain: загружено"],
    ["uploading", "Brain: загрузка"],
    ["not_uploaded", "Brain: не загружено"],
  ] as const)("renders %s label", (status, label) => {
    renderCard(makeItem(status));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("renders failed label with the last error as title", () => {
    renderCard(makeItem("failed", { brain_upload_last_error: "Network unavailable" }));
    expect(screen.getByText("Brain: ошибка")).toHaveAttribute("title", "Network unavailable");
    expect(screen.getByText("Brain: ошибка")).toHaveAccessibleName(
      "Brain: ошибка. Network unavailable",
    );
    expect(screen.getByText("Network unavailable")).toHaveClass("visually-hidden");
  });

  it("redacts token-like values from failed Brain upload details", () => {
    renderCard(makeItem("failed", {
      brain_upload_last_error: "Bearer eyJhbGciOiJIUzI1NiJ9.shortpayload.signature== was rejected",
    }));

    expect(screen.getByText("Brain: ошибка")).toHaveAttribute(
      "title",
      "Bearer [redacted] was rejected",
    );
    expect(screen.queryByText(/eyJhbGci/)).not.toBeInTheDocument();
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
});
