import { RecordingInputChannel, RecordingMuteState } from "../../appTypes";
import { clamp01 } from "../../lib/appUtils";

export const defaultRecordingMuteState: RecordingMuteState = {
  micMuted: false,
  systemMuted: false,
};

export const TRAY_AUDIO_ACTIVE_THRESHOLD = 0.08;

export function shouldAnimateTrayAudio(level: number, muted: boolean): boolean {
  return !muted && clamp01(level) >= TRAY_AUDIO_ACTIVE_THRESHOLD;
}

export function nextRecordingMuteState(
  prev: RecordingMuteState,
  channel: RecordingInputChannel,
  muted: boolean
): RecordingMuteState {
  if (channel === "mic") {
    return {
      micMuted: muted,
      systemMuted: prev.systemMuted,
    };
  }

  return {
    micMuted: prev.micMuted,
    systemMuted: muted,
  };
}
