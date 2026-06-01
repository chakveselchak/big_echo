import { memo } from "react";
import { Flex } from "antd";
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

// Both Source and Topic are plain HTML controls (no Antd Input/ConfigProvider).
// The Topic field used to be an Antd <Input>: every keystroke re-rendered it,
// and Antd's per-render cssinjs/context work ran synchronously on the input
// hot-path. During a fast burst of typing that work piled up between keydowns
// and stalled the WebView's event loop, so characters were dropped/lagged on
// slower machines (worse while recording, when the live-level poll adds load).
// A native <input> has zero wrapper/context overhead and keeps typing smooth.
const nativeControlStyle: React.CSSProperties = {
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
    <Flex gap={8}>
      <Flex vertical gap={2} style={sourceColumnStyle}>
        <label htmlFor="tray-source" style={labelStyle}>Source</label>
        <select
          id="tray-source"
          aria-label="Source"
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          disabled={isRecording}
          style={nativeControlStyle}
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
        <input
          id="tray-topic"
          aria-label="Topic (optional)"
          type="text"
          value={topic}
          onChange={(e) => onTopicChange(e.target.value)}
          style={nativeControlStyle}
        />
      </Flex>
    </Flex>
  );
}

// Memoize so the tray's frequent live-level re-renders don't reach down into
// the Topic input. With React.memo and stable callbacks (setTopic/setSource
// from useState are reference-stable), this component only re-renders when
// source/topic/isRecording actually change.
export const RecordingControls = memo(RecordingControlsImpl);
