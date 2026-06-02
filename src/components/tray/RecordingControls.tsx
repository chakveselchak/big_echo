import { memo, useEffect, useRef } from "react";
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
  // Topic is an UNCONTROLLED input: keystrokes (including held-Backspace
  // delete) live entirely in the DOM and never trigger a React re-render. We
  // only push the value into React state on blur (`onTopicChange`). This kills
  // the class of bug where a re-render — driven by the live-level poll, the
  // recording session, or React re-applying a lagging controlled `value` — runs
  // on the typing hot-path and drops/reorders characters on slower machines.
  const topicInputRef = useRef<HTMLInputElement>(null);

  // Reflect EXTERNAL topic changes (hydration, ui:sync from another window,
  // the clear-after-stop) into the uncontrolled input — but never while the
  // user is typing in it, so we don't clobber their in-progress edit.
  useEffect(() => {
    const el = topicInputRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (el.value !== topic) el.value = topic;
  }, [topic]);

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
          ref={topicInputRef}
          id="tray-topic"
          aria-label="Topic (optional)"
          type="text"
          defaultValue={topic}
          onBlur={(e) => onTopicChange(e.target.value)}
          style={nativeControlStyle}
        />
      </Flex>
    </Flex>
  );
}

// Memoize so the tray's frequent live-level re-renders don't reach down into
// the Topic input. Combined with the uncontrolled input above, typing causes
// zero re-renders of this subtree.
export const RecordingControls = memo(RecordingControlsImpl);
