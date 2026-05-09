import { memo } from "react";
import { ConfigProvider, Flex, Input } from "antd";
import { fixedSources } from "../../types";

type RecordingControlsProps = {
  source: string;
  topic: string;
  isRecording: boolean;
  onSourceChange: (value: string) => void;
  onTopicChange: (value: string) => void;
};

// Shared control height for tray Source select + Topic input — must match.
const TRAY_CONTROL_HEIGHT = 28;

// Hoisted to module scope so this object keeps a stable reference across
// renders. Inlining `{ token: { controlHeightSM: ... } }` was creating a new
// object on every parent render, defeating ConfigProvider memoization and
// forcing every Antd descendant to re-derive styles even when the tray was
// just re-rendering for an audio-level tick.
const trayThemeConfig = {
  token: { controlHeightSM: TRAY_CONTROL_HEIGHT },
};

const nativeSelectStyle: React.CSSProperties = {
  height: TRAY_CONTROL_HEIGHT,
  fontSize: 12,
  padding: "0 6px",
  borderRadius: 6,
  border: "1px solid rgba(140, 151, 165, 0.28)",
  background: "rgba(248, 250, 253, 0.96)",
  width: "100%",
  boxSizing: "border-box",
};

const sourceColumnStyle: React.CSSProperties = { flex: "0 0 auto", minWidth: 100 };
const topicColumnStyle: React.CSSProperties = { flex: 1 };
const labelStyle: React.CSSProperties = { fontSize: 12 };

function RecordingControlsImpl({
  source,
  topic,
  isRecording,
  onSourceChange,
  onTopicChange,
}: RecordingControlsProps) {
  return (
    <ConfigProvider theme={trayThemeConfig}>
      <Flex gap={8}>
        <Flex vertical gap={2} style={sourceColumnStyle}>
          <label htmlFor="tray-source" style={labelStyle}>Source</label>
          <select
            id="tray-source"
            aria-label="Source"
            value={source}
            onChange={(e) => onSourceChange(e.target.value)}
            disabled={isRecording}
            style={nativeSelectStyle}
          >
            {fixedSources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Flex>
        <Flex vertical gap={2} style={topicColumnStyle}>
          <label htmlFor="tray-topic" style={labelStyle}>Topic (optional)</label>
          <Input
            id="tray-topic"
            aria-label="Topic (optional)"
            size="small"
            value={topic}
            onChange={(e) => onTopicChange(e.target.value)}
          />
        </Flex>
      </Flex>
    </ConfigProvider>
  );
}

// Memoize so the tray's frequent live-level re-renders don't reach down into
// the Antd Input. With React.memo and stable callbacks (setTopic/setSource
// from useState are reference-stable), this component only re-renders when
// source/topic/isRecording actually change.
export const RecordingControls = memo(RecordingControlsImpl);
