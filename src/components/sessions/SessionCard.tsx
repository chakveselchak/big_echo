import { memo, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Button, Col, ConfigProvider, Form, Input, Row, Select } from "antd";
import { ClearOutlined, DeleteOutlined, FolderOpenOutlined } from "@ant-design/icons";
import type { PipelineUiState, SessionListItem, SessionMetaView } from "../../types";
import { fixedSources } from "../../types";
import { formatSessionStatus } from "../../lib/status";
import { extractStartTimeHm, resolveSessionAudioPath } from "../../lib/appUtils";
import { AudioPlayer } from "./AudioPlayer";

const fixedSourceOptions = fixedSources.map((s) => ({ value: s, label: s }));

type SessionCardProps = {
  item: SessionListItem;
  detail: SessionMetaView;
  textPending: boolean;
  summaryPending: boolean;
  pipelineState: PipelineUiState | undefined;
  searchQuery: string;
  knownTagOptions: { value: string; label: string }[];
  transcriptMatch: boolean;
  summaryMatch: boolean;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, sessionId: string) => void;
  onDetailChange: (detail: SessionMetaView) => void;
  onOpenArtifact: (sessionId: string, kind: "transcript" | "summary") => void;
  onGetText: (sessionId: string) => void;
  onGetSummary: (sessionId: string) => void;
  onOpenSummaryPrompt: (detail: SessionMetaView) => void;
  onDelete: (sessionId: string, isRecording: boolean) => void;
  onDeleteAudio: (sessionId: string) => void;
  onFieldBlur: (sessionId: string, detail?: SessionMetaView) => void;
  onOpenFolder: (sessionDir: string) => void;
  setStatus: (status: string) => void;
};

function SessionCardImpl({
  item,
  detail,
  textPending,
  summaryPending,
  pipelineState,
  searchQuery,
  knownTagOptions,
  transcriptMatch,
  summaryMatch,
  onContextMenu,
  onDetailChange,
  onOpenArtifact,
  onGetText,
  onGetSummary,
  onOpenSummaryPrompt,
  onDelete,
  onDeleteAudio,
  onFieldBlur,
  onOpenFolder,
  setStatus,
}: SessionCardProps) {
  const hasAudio = resolveSessionAudioPath(item) !== null;

  // Local draft state — edits update only this card, not the whole
  // sessionDetails Record in the parent. This keeps the keystroke path
  // O(1) re-render (only this card + Ant Design input) instead of O(N)
  // for every session. The parent is synced on blur via commitDraft().
  const [draftDetail, setDraftDetail] = useState<SessionMetaView>(detail);
  const draftRef = useRef(draftDetail);
  draftRef.current = draftDetail;

  // When the parent's committed detail changes (reload from disk, external
  // update, etc.) and it no longer matches what we have locally, refresh the
  // draft. We check via fields to avoid refs that changed without value-level
  // diffs (e.g. new object from Object.fromEntries in useSessions).
  useEffect(() => {
    const local = draftRef.current;
    if (
      detail.source === local.source &&
      detail.notes === local.notes &&
      detail.topic === local.topic &&
      (detail.custom_summary_prompt ?? "") === (local.custom_summary_prompt ?? "") &&
      detail.tags.length === local.tags.length &&
      detail.tags.every((t, i) => t === local.tags[i])
    ) {
      return;
    }
    setDraftDetail(detail);
  }, [detail]);

  const commitDraft = () => {
    const current = draftRef.current;
    // Only push to parent if something actually changed vs the committed
    // detail — avoids spurious setState in the parent tree on simple focus
    // changes with no edits.
    if (
      detail.source === current.source &&
      detail.notes === current.notes &&
      detail.topic === current.topic &&
      (detail.custom_summary_prompt ?? "") === (current.custom_summary_prompt ?? "") &&
      detail.tags.length === current.tags.length &&
      detail.tags.every((t, i) => t === current.tags[i])
    ) {
      return;
    }
    onDetailChange(current);
  };

  const handleBlur = () => {
    const current = draftRef.current;
    commitDraft();
    // Pass the draft explicitly — otherwise the hook reads from a stale
    // closure since commitDraft's setSessionDetails hasn't committed yet.
    onFieldBlur(item.session_id, current);
  };

  // Reading draft* throughout the render below so the UI reflects typing
  // immediately even though the parent doesn't know about each keystroke.
  const working = draftDetail;
  const query = searchQuery.trim().toLowerCase();
  const sourceMatch = query !== "" && detail.source.toLowerCase().includes(query);
  const notesMatch = query !== "" && detail.notes.toLowerCase().includes(query);
  const topicMatch = query !== "" && detail.topic.toLowerCase().includes(query);
  const tagsText = detail.tags.join(", ");
  const tagsMatch = query !== "" && tagsText.toLowerCase().includes(query);
  const statusMatch = query !== "" && item.status.toLowerCase().includes(query);

  const startTimeHm = extractStartTimeHm(item.started_at_iso);
  const sessionTitleMeta = startTimeHm
    ? `(${item.audio_format}) - ${item.display_date_ru} ${startTimeHm}`
    : `(${item.audio_format}) - ${item.display_date_ru}`;

  return (
    <article
      className="session-card"
      onContextMenu={(event) => onContextMenu(event, item.session_id)}
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
                style={{ height: 23 }}
                className={`session-label session-label-action session-label-text${transcriptMatch ? " match-hit" : ""}`}
                onClick={() => onOpenArtifact(item.session_id, "transcript")}
              >
                текст
              </Button>
            )}
            {item.has_summary_text && (
              <Button
                htmlType="button"
                style={{ height: 23 }}
                className={`session-label session-label-action session-label-summary${summaryMatch ? " match-hit" : ""}`}
                onClick={() => onOpenArtifact(item.session_id, "summary")}
              >
                саммари
              </Button>
            )}
          </div>
          <div className="session-card-icon-actions">
            <Button
              htmlType="button"
              type="text"
              size="small"
              shape="circle"
              className="icon-button delete-session-button"
              aria-label="Удалить сессию"
              title="Удалить сессию"
              danger
              icon={<DeleteOutlined aria-hidden="true" />}
              onClick={() => onDelete(item.session_id, item.status === "recording")}
            />
            {hasAudio && (
              <Button
                htmlType="button"
                type="text"
                size="small"
                shape="circle"
                className="icon-button delete-session-audio-button"
                aria-label="Удалить аудио"
                title="Удалить аудио"
                icon={<ClearOutlined aria-hidden="true" />}
                onClick={() => onDeleteAudio(item.session_id)}
              />
            )}
            <Button
              htmlType="button"
              type="text"
              size="small"
              shape="circle"
              className="icon-button session-folder-link"
              aria-label="Открыть папку сессии"
              title="Открыть папку сессии"
              icon={<FolderOpenOutlined aria-hidden="true" />}
              onClick={() => onOpenFolder(item.session_dir)}
            />
          </div>
        </div>
      </div>
      <ConfigProvider
        theme={{
          token: {
            controlHeight: 30,
            fontSize: 13,
            borderRadius: 6,
          },
          components: {
            Select: {
              multipleItemHeight: 20,
            },
            Form: {
              itemMarginBottom: 0,
              labelColonMarginInlineEnd: 0,
              verticalLabelPadding: "0 0 4px",
            },
          },
        }}
      >
        <Form component="div" layout="vertical" colon={false}>
          <Row gutter={[12, 12]} align="top" className="session-edit-grid">
            <Col span={6}>
              <Form.Item
                label="Source"
                htmlFor="session-source"
                className={sourceMatch ? "match-hit" : undefined}
              >
                <Select
                  id="session-source"
                  aria-label="Source"
                  value={working.source}
                  options={fixedSourceOptions}
                  onChange={(value) => setDraftDetail((prev) => ({ ...prev, source: value }))}
                  onBlur={handleBlur}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="Topic"
                htmlFor="session-topic"
                className={topicMatch ? "match-hit" : undefined}
              >
                <Input
                  id="session-topic"
                  aria-label="Topic"
                  value={working.topic}
                  onChange={(e) => setDraftDetail((prev) => ({ ...prev, topic: e.target.value }))}
                  onBlur={handleBlur}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="Tags"
                htmlFor="session-tags"
                className={tagsMatch ? "match-hit" : undefined}
              >
                <Select
                  id="session-tags"
                  aria-label="Tags"
                  mode="tags"
                  value={working.tags}
                  options={knownTagOptions}
                  tokenSeparators={[","]}
                  onChange={(value) => setDraftDetail((prev) => ({ ...prev, tags: value }))}
                  onBlur={handleBlur}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="Notes"
                htmlFor="session-notes"
                className={notesMatch ? "match-hit" : undefined}
              >
                <Input
                  id="session-notes"
                  aria-label="Notes"
                  value={working.notes}
                  onChange={(e) => setDraftDetail((prev) => ({ ...prev, notes: e.target.value }))}
                  onBlur={handleBlur}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </ConfigProvider>
      <div className="session-card-footer">
        <div className="session-card-footer-actions">
          <div className="button-row">
            <Button
              className="secondary-button"
              onClick={() => onGetText(item.session_id)}
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
              onClick={() => onGetSummary(item.session_id)}
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
              onClick={() => {
                commitDraft();
                onOpenSummaryPrompt(draftRef.current);
              }}
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
          {hasAudio && <AudioPlayer item={item} setStatus={setStatus} />}
          <span className="session-duration-label">{item.audio_duration_hms}</span>
        </div>
      </div>
    </article>
  );
}

// React.memo skips re-render when props are shallow-equal. Combined with the
// local-draft pattern above this means typing in one card's Notes does NOT
// re-render the other 50+ cards.
export const SessionCard = memo(SessionCardImpl);
