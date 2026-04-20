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

export function RecordingControls({
  source,
  topic,
  isRecording,
  onSourceChange,
  onTopicChange,
}: RecordingControlsProps) {
  return (
    <ConfigProvider theme={{ token: { controlHeightSM: TRAY_CONTROL_HEIGHT } }}>
      <Flex gap={8}>
        <Flex vertical gap={2} style={{ flex: "0 0 auto", minWidth: 100 }}>
          <label htmlFor="tray-source" style={{ fontSize: 12 }}>Source</label>
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
        <Flex vertical gap={2} style={{ flex: 1 }}>
          <label htmlFor="tray-topic" style={{ fontSize: 12 }}>Topic (optional)</label>
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
