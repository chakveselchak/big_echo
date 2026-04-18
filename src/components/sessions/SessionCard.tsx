import type { MouseEvent as ReactMouseEvent } from "react";
import { Button, Col, ConfigProvider, Form, Input, Row, Select } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import type { PipelineUiState, SessionListItem, SessionMetaView } from "../../types";
import { fixedSources } from "../../types";
import { formatSessionStatus } from "../../lib/status";
import { extractStartTimeHm } from "../../lib/appUtils";
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
  onOpenFolder: (sessionDir: string) => void;
  setStatus: (status: string) => void;
};

export function SessionCard({
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
  onOpenFolder,
  setStatus,
}: SessionCardProps) {
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
              className="icon-button delete-session-button"
              aria-label="Удалить сессию"
              title="Удалить сессию"
              danger
              icon={<DeleteOutlined aria-hidden="true" />}
              onClick={() => onDelete(item.session_id, item.status === "recording")}
            />
            <Button
              htmlType="button"
              className="icon-button session-folder-link"
              aria-label="Открыть папку сессии"
              title="Открыть папку сессии"
              onClick={() => onOpenFolder(item.session_dir)}
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
                  value={detail.source}
                  options={fixedSourceOptions}
                  onChange={(value) => onDetailChange({ ...detail, source: value })}
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
                  value={detail.topic}
                  onChange={(e) => onDetailChange({ ...detail, topic: e.target.value })}
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
                  value={detail.tags}
                  options={knownTagOptions}
                  tokenSeparators={[","]}
                  onChange={(value) => onDetailChange({ ...detail, tags: value })}
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
                  value={detail.notes}
                  onChange={(e) => onDetailChange({ ...detail, notes: e.target.value })}
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
              onClick={() => onOpenSummaryPrompt(detail)}
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
          <AudioPlayer item={item} setStatus={setStatus} />
          <span className="session-duration-label">{item.audio_duration_hms}</span>
        </div>
      </div>
    </article>
  );
}
