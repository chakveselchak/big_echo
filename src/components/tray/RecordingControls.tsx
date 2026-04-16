import { Flex, Input, Select } from "antd";
import { fixedSources } from "../../types";

type RecordingControlsProps = {
  source: string;
  topic: string;
  isRecording: boolean;
  onSourceChange: (value: string) => void;
  onTopicChange: (value: string) => void;
};

export function RecordingControls({
  source,
  topic,
  isRecording,
  onSourceChange,
  onTopicChange,
}: RecordingControlsProps) {
  const fixedSourceOptions = fixedSources.map((s) => ({ value: s, label: s }));

  return (
    <Flex gap={8}>
      <Flex vertical gap={2} style={{ flex: "0 0 auto", minWidth: 100 }}>
        <label htmlFor="tray-source" style={{ fontSize: 12 }}>Source</label>
        <Select
          id="tray-source"
          aria-label="Source"
          size="small"
          value={source}
          options={fixedSourceOptions}
          onChange={onSourceChange}
          disabled={isRecording}
        />
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
  );
}
