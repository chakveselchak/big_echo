import { memo, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Badge, Button, Col, ConfigProvider, Dropdown, Form, Input, InputNumber, Row, Select } from "antd";
import type { MenuProps } from "antd";
import { CheckOutlined, CheckSquareOutlined, ClearOutlined, DeleteOutlined, DeploymentUnitOutlined, ExportOutlined, FolderOpenOutlined, MessageOutlined } from "@ant-design/icons";
import type { BrainUploadStatus, PipelineUiState, SessionListItem, SessionMetaView } from "../../types";
import { audioSpeedMultiplierOptions, fixedSources } from "../../types";
import { formatSessionStatus } from "../../lib/status";
import { extractStartTimeHm, parseDurationHms, resolveSessionAudioPath } from "../../lib/appUtils";
import { AudioPlayer } from "./AudioPlayer";
import { useI18n } from "../../i18n";

const fixedSourceOptions = fixedSources.map((s) => ({ value: s, label: s }));
const sessionSpeedOptions = audioSpeedMultiplierOptions;

function SpeedometerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 46 45" aria-hidden="true" focusable="false">
      <g transform="translate(0.338000, 0.000000)" fill="currentColor" fillRule="nonzero">
        <path d="M41.318,14.422 L44.464,10.672 C44.771,10.308 44.722,9.764 44.359,9.458 L41.822,7.328 C41.457,7.024 40.914,7.071 40.609,7.436 L37.679,10.927 C35.257,9.157 32.4,7.965 29.29,7.538 L29.29,4.444 L33.032,4.444 C33.452,4.444 33.792,4.103 33.792,3.682 L33.792,0.76 C33.792,0.339 33.452,0 33.032,0 L20.498,0 C20.078,0 19.738,0.339 19.738,0.76 L19.738,3.682 C19.738,4.103 20.078,4.444 20.498,4.444 L24.24,4.444 L24.24,7.526 C21.16,7.946 18.285,9.126 15.838,10.91 L12.924,7.437 C12.617,7.072 12.076,7.025 11.711,7.329 L9.174,9.459 C8.809,9.765 8.762,10.309 9.067,10.673 L12.202,14.409 C11.188,15.696 10.327,17.122 9.669,18.68 C9.343,19.446 9.702,20.33 10.468,20.655 C11.236,20.981 12.118,20.62 12.443,19.854 C14.881,14.086 20.504,10.36 26.767,10.36 C35.339,10.36 42.314,17.333 42.314,25.907 C42.314,34.477 35.339,41.451 26.767,41.451 C24.261,41.451 21.871,40.874 19.66,39.737 C18.922,39.354 18.014,39.645 17.633,40.385 C17.25,41.124 17.541,42.031 18.281,42.413 C20.885,43.755 23.82,44.463 26.767,44.463 C36.999,44.463 45.326,36.139 45.326,25.906 C45.324,21.571 43.818,17.586 41.318,14.422 Z" />
        <path d="M29.951,26.481 C35.025,20.445 35.328,18.7 34.984,18.356 C34.64,18.014 32.896,18.315 26.861,23.391 C23.988,25.805 24.892,27.19 25.521,27.819 C26.15,28.45 27.537,29.354 29.951,26.481 Z" />
        <path d="M17.73,24.225 C17.73,23.512 17.154,22.934 16.439,22.934 L1.291,22.934 C0.576,22.934 0,23.512 0,24.225 C0,24.938 0.576,25.516 1.291,25.516 L16.439,25.516 C17.154,25.516 17.73,24.938 17.73,24.225 Z" />
        <path d="M16.439,29.461 L7.666,29.461 C6.953,29.461 6.373,30.039 6.373,30.752 C6.373,31.465 6.953,32.043 7.666,32.043 L16.439,32.043 C17.154,32.043 17.73,31.465 17.73,30.752 C17.73,30.039 17.154,29.461 16.439,29.461 Z" />
        <path d="M16.439,35.989 L3.793,35.989 C3.078,35.989 2.5,36.566 2.5,37.28 C2.5,37.993 3.078,38.571 3.793,38.571 L16.439,38.571 C17.154,38.571 17.73,37.993 17.73,37.28 C17.73,36.566 17.154,35.989 16.439,35.989 Z" />
      </g>
    </svg>
  );
}

function formatDurationHms(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function speedDurationDeltaLabel(durationHms: string, speed: number | null | undefined): string {
  if (!speed || speed <= 1) return "";
  const originalSeconds = parseDurationHms(durationHms);
  if (originalSeconds <= 0) return "";
  return `-${formatDurationHms(originalSeconds - originalSeconds / speed)}`;
}

function sameDraftDetail(left: SessionMetaView, right: SessionMetaView) {
  return (
    left.source === right.source &&
    left.notes === right.notes &&
    left.topic === right.topic &&
    (left.custom_summary_prompt ?? "") === (right.custom_summary_prompt ?? "") &&
    (left.custom_summary_prompt_name ?? "") === (right.custom_summary_prompt_name ?? "") &&
    (left.num_speakers ?? null) === (right.num_speakers ?? null) &&
    left.tags.length === right.tags.length &&
    left.tags.every((t, i) => t === right.tags[i])
  );
}

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
  showNumSpeakers: boolean;
  brainUploadPending: boolean;
  brainSyncReady: boolean;
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
  onUploadToBrain: (sessionId: string) => void;
  onShare: (sessionId: string) => void;
  canShare: boolean;
  onExportTodoist: (sessionId: string) => void;
  todoistPending: boolean;
  onSetTranscriptionSpeed: (sessionId: string, speed: number) => void;
  speedPending: boolean;
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
  showNumSpeakers,
  brainUploadPending,
  brainSyncReady,
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
  onUploadToBrain,
  onShare,
  canShare,
  onExportTodoist,
  todoistPending,
  onSetTranscriptionSpeed,
  speedPending,
  setStatus,
}: SessionCardProps) {
  const { t } = useI18n();
  const hasAudio = resolveSessionAudioPath(item) !== null;

  // Local draft state — edits update only this card, not the whole
  // sessionDetails Record in the parent. This keeps the keystroke path
  // O(1) re-render (only this card + Ant Design input) instead of O(N)
  // for every session. The parent is synced on blur via commitDraft().
  const [draftDetail, setDraftDetail] = useState<SessionMetaView>(detail);
  const draftRef = useRef(draftDetail);
  const acceptedDetailRef = useRef(detail);
  draftRef.current = draftDetail;

  // Orange "dirty" dot on the summary-prompt button when this session overrides
  // the default summary prompt with a non-empty custom one — mirrors the dirty
  // indicator shown in Settings.
  const hasCustomSummaryPrompt = Boolean(
    draftDetail.custom_summary_prompt_name?.trim() || draftDetail.custom_summary_prompt?.trim()
  );

  // When the parent's committed detail changes (reload from disk, external
  // update, etc.), refresh the draft only if the user has no unsaved local
  // edits. We check via fields to avoid refs that changed without value-level
  // diffs (e.g. new object from Object.fromEntries in useSessions).
  useEffect(() => {
    const local = draftRef.current;
    const previouslyAccepted = acceptedDetailRef.current;
    acceptedDetailRef.current = detail;
    if (sameDraftDetail(detail, local)) {
      return;
    }
    if (!sameDraftDetail(local, previouslyAccepted)) {
      return;
    }
    setDraftDetail(detail);
  }, [detail]);

  const commitDraft = () => {
    const current = draftRef.current;
    // Only push to parent if something actually changed vs the committed
    // detail — avoids spurious setState in the parent tree on simple focus
    // changes with no edits.
    if (sameDraftDetail(detail, current)) {
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
  const speedLabel =
    item.speed_adjusted_audio_file?.trim() && item.audio_speed_multiplier
      ? `${Number(item.audio_speed_multiplier).toString()}x`
      : "";
  const selectedSpeed = speedLabel ? item.audio_speed_multiplier ?? 1 : 1;
  const availableSpeeds = new Set(item.available_audio_speed_multipliers ?? (hasAudio ? [1] : []));
  const speedMenuItems: MenuProps["items"] = sessionSpeedOptions.map((speed) => ({
    key: String(speed),
    disabled: speedPending,
    label: (
      <span className="session-speed-menu-item">
        <span className="session-speed-check-slot">
          {selectedSpeed === speed && <CheckOutlined aria-hidden="true" />}
        </span>
        <span className="session-speed-value">{speed}x</span>
        <span className="session-speed-dot-slot">
          {availableSpeeds.has(speed) && <span className="session-speed-available-dot" />}
        </span>
      </span>
    ),
  }));
  const speedDurationDelta = speedLabel
    ? speedDurationDeltaLabel(item.audio_duration_hms, item.audio_speed_multiplier)
    : "";
  const sessionTitleMeta = startTimeHm
    ? `(${item.audio_format}) - ${item.display_date_ru} ${startTimeHm}`
    : `(${item.audio_format}) - ${item.display_date_ru}`;
  const brainUploadStatus = brainUploadPending
    ? "uploading"
    : (item.brain_upload_status ?? "not_uploaded");
  const brainLabelByStatus = {
    uploaded: "Brain: загружено",
    uploading: "Brain: загрузка",
    failed: "Brain: ошибка",
    not_uploaded: "Brain: не загружено",
  } satisfies Record<BrainUploadStatus, string>;
  const showBrainUploadButton =
    hasAudio &&
    brainSyncReady &&
    !(brainUploadStatus === "uploaded" && item.brain_server_ingested_once);
  const brainUploadDisabled =
    brainUploadPending || brainUploadStatus === "uploading" || item.status === "recording";
  const todoistExportLabel = t("sessions.actions.exportTodoist");

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
            {speedLabel && (
              <span className="session-speed-label" title="ускоренное аудио">
                {speedLabel}
              </span>
            )}
            {speedDurationDelta && (
              <span
                className="session-speed-duration-delta"
                title="сохранено время для транскрибации"
              >
                {speedDurationDelta}
              </span>
            )}
          </div>
          <div className={statusMatch ? "session-status match-hit" : "session-status"}>
            {t("sessions.status", { status: formatSessionStatus(item.status) })}
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
            {showBrainUploadButton && (
              <Button
                htmlType="button"
                type="text"
                size="small"
                shape="circle"
                className="session-brain-upload-button"
                aria-label="Загрузить в Brain"
                title="Загрузить в Brain"
                disabled={brainUploadDisabled}
                icon={
                  <Badge
                    dot={brainUploadStatus !== "uploaded"}
                    color="var(--danger)"
                  >
                    <DeploymentUnitOutlined aria-hidden="true" style={{color: "gray"}}/>
                  </Badge>
                }
                onClick={() => onUploadToBrain(item.session_id)}
              />
            )}
            {item.has_summary_text && (
              <Button
                htmlType="button"
                type="text"
                size="small"
                shape="circle"
                className="session-todoist-export-button"
                aria-label={todoistExportLabel}
                title={todoistExportLabel}
                loading={todoistPending}
                icon={<CheckSquareOutlined aria-hidden="true" style={{color: "gray"}} />}
                onClick={() => onExportTodoist(item.session_id)}
              />
            )}
          </div>
          <div className="session-card-icon-actions">
            {hasAudio && (
              <Dropdown
                menu={{
                  items: speedMenuItems,
                  onClick: ({ key }) => {
                    if (speedPending) return;
                    onSetTranscriptionSpeed(item.session_id, Number(key));
                  },
                }}
                trigger={["click"]}
                disabled={speedPending}
              >
                <Button
                  htmlType="button"
                  type="text"
                  size="small"
                  shape="circle"
                  className="session-speed-button"
                  aria-label="Выбрать скорость транскрибации"
                  title="Выбрать скорость транскрибации"
                  loading={speedPending}
                  disabled={speedPending}
                  icon={<SpeedometerIcon />}
                />
              </Dropdown>
            )}
            <Button
              htmlType="button"
              type="text"
              size="small"
              shape="circle"
              className="delete-session-button"
              aria-label="Удалить сессию"
              title="Удалить сессию"
              icon={<DeleteOutlined aria-hidden="true" style={{color: "gray"}}/>}
              onClick={() => onDelete(item.session_id, item.status === "recording")}
            />
            {hasAudio && item.has_summary_text && (
              <Button
                htmlType="button"
                type="text"
                size="small"
                shape="circle"
                className="delete-session-audio-button"
                aria-label="Удалить аудио"
                title="Удалить аудио"
                icon={<ClearOutlined aria-hidden="true" style={{color: "gray"}}/>}
                onClick={() => onDeleteAudio(item.session_id)}
              />
            )}
            <Button
              htmlType="button"
              type="text"
              size="small"
              shape="circle"
              className="session-folder-link"
              aria-label="Открыть папку сессии"
              title="Открыть папку сессии"
              icon={<FolderOpenOutlined aria-hidden="true" style={{color: "gray"}} />}
              onClick={() => onOpenFolder(item.session_dir)}
            />
            {hasAudio && canShare && (
              <Button
                htmlType="button"
                type="text"
                size="small"
                shape="circle"
                className="session-share-button"
                aria-label="Поделиться ссылкой на аудио"
                title="Поделиться ссылкой на аудио (Яндекс.Диск)"
                icon={<ExportOutlined aria-hidden="true" style={{ color: "gray" }} />}
                onClick={() => onShare(item.session_id)}
              />
            )}
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
            <Col span={showNumSpeakers ? 4 : 6}>
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
            {showNumSpeakers && (
              <Col span={3}>
                <Form.Item label="speakers" htmlFor="session-num-speakers">
                  <InputNumber
                    id="session-num-speakers"
                    aria-label="speakers"
                    min={1}
                    max={20}
                    step={1}
                    precision={0}
                    // Ant Design's InputNumber lets users type "-", ".", "e",
                    // and pasted text through unless we strip them in `parser`.
                    // Returning "" tells antd "no value" → onChange fires with
                    // null, which propagates to meta as null and the API skips
                    // the field entirely.
                    parser={(value) => {
                      const digits = (value ?? "").replace(/[^0-9]/g, "");
                      if (digits === "") return "" as unknown as number;
                      return Math.min(Number(digits), 20);
                    }}
                    formatter={(value) => {
                      if (value === undefined || value === null) return "";
                      const n = Number(value);
                      if (!Number.isFinite(n)) return "";
                      return String(Math.trunc(n));
                    }}
                    style={{ width: "100%" }}
                    value={working.num_speakers ?? null}
                    onChange={(value) =>
                      setDraftDetail((prev) => {
                        if (typeof value !== "number" || !Number.isFinite(value)) {
                          return { ...prev, num_speakers: null };
                        }
                        const n = Math.trunc(value);
                        if (n < 1) return { ...prev, num_speakers: null };
                        return { ...prev, num_speakers: Math.min(n, 20) };
                      })
                    }
                    onBlur={handleBlur}
                  />
                </Form.Item>
              </Col>
            )}
            <Col span={showNumSpeakers ? 5 : 6}>
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
                  {t("sessions.actions.gettingText")}
                </span>
              ) : (
                t("sessions.actions.getText")
              )}
            </Button>
            {textPending && (
              <span
                className="visually-hidden"
                role="status"
                aria-live="polite"
                aria-label={t("sessions.loadingText")}
              >
                {t("sessions.loadingText")}
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
                  {t("sessions.actions.gettingSummary")}
                </span>
              ) : (
                t("sessions.actions.getSummary")
              )}
            </Button>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <Button
                htmlType="button"
                type="text"
                size="small"
                shape="circle"
                className="session-summary-prompt-button"
                aria-label="Настроить промпт саммари"
                title="Настроить промпт саммари"
                icon={<MessageOutlined aria-hidden="true" />}
                onClick={() => {
                  commitDraft();
                  onOpenSummaryPrompt(draftRef.current);
                }}
              />
              {hasCustomSummaryPrompt && (
                <span
                  className="summary-prompt-dot"
                  role="img"
                  aria-label="Промпт отличается от базового"
                  title="Промпт отличается от базового"
                  style={{
                    position: "absolute",
                    top: 0,
                    right: -4,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: "var(--ant-color-warning, #ffae14)",
                    pointerEvents: "none",
                  }}
                />
              )}
            </span>
            {summaryPending && (
              <span
                className="visually-hidden"
                role="status"
                aria-live="polite"
                aria-label={t("sessions.loadingSummary")}
              >
                {t("sessions.loadingSummary")}
              </span>
            )}
            {pipelineState ? (
              <span
                className={
                  pipelineState.kind === "error"
                    ? "retry-state retry-state-error"
                    : "retry-state retry-state-success"
                }
              >
                {pipelineState.text}
              </span>
            ) : hasAudio && brainUploadStatus !== "not_uploaded" ? (
              <span
                className={
                  brainUploadStatus === "failed"
                    ? "retry-state retry-state-error"
                    : brainUploadStatus === "uploaded"
                      ? "retry-state retry-state-success"
                      : "retry-state"
                }
              >
                {brainLabelByStatus[brainUploadStatus]}
              </span>
            ) : null}
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
