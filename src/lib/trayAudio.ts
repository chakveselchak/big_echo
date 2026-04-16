import { RecordingInputChannel, RecordingMuteState } from "../types";
import { clamp01 } from "./appUtils";

export type TrayAudioWaveMode = "flat" | "gentle" | "strong";

export type TrayAudioWaveMetrics = {
  mode: TrayAudioWaveMode;
  amplitude: number;
  secondaryAmplitude: number;
  frequency: number;
  speed: number;
  strokeWidth: number;
};

export const defaultRecordingMuteState: RecordingMuteState = {
  micMuted: false,
  systemMuted: false,
};

export const TRAY_AUDIO_ACTIVE_THRESHOLD = 0.08;
export const TRAY_AUDIO_STRONG_THRESHOLD = 0.58;
export const TRAY_AUDIO_WAVE_VIEWBOX_WIDTH = 120;
export const TRAY_AUDIO_WAVE_VIEWBOX_HEIGHT = 28;

export function shouldAnimateTrayAudio(level: number, muted: boolean): boolean {
  return !muted && clamp01(level) >= TRAY_AUDIO_ACTIVE_THRESHOLD;
}

export function getTrayAudioWaveMetrics(level: number, muted: boolean): TrayAudioWaveMetrics {
  if (!shouldAnimateTrayAudio(level, muted)) {
    return {
      mode: "flat",
      amplitude: 0,
      secondaryAmplitude: 0,
      frequency: 0,
      speed: 0,
      strokeWidth: 1.55,
    };
  }

  const normalizedLevel = clamp01(level);
  const activity = clamp01((normalizedLevel - TRAY_AUDIO_ACTIVE_THRESHOLD) / (1 - TRAY_AUDIO_ACTIVE_THRESHOLD));
  const mode: TrayAudioWaveMode = activity >= TRAY_AUDIO_STRONG_THRESHOLD ? "strong" : "gentle";
  const amplitude = 1.4 + Math.pow(activity, 1.18) * 8.6;

  return {
    mode,
    amplitude,
    secondaryAmplitude: amplitude * (mode === "strong" ? 0.42 : 0.2),
    frequency: mode === "strong" ? 2.4 + activity * 1.25 : 1.4 + activity * 0.95,
    speed: 0.85 + activity * 1.95,
    strokeWidth: mode === "strong" ? 1.85 : 1.6,
  };
}

export function buildTrayAudioWavePath(
  metrics: TrayAudioWaveMetrics,
  phase: number,
  width = TRAY_AUDIO_WAVE_VIEWBOX_WIDTH,
  height = TRAY_AUDIO_WAVE_VIEWBOX_HEIGHT
): string {
  const centerY = height / 2;
  if (metrics.mode === "flat" || metrics.amplitude <= 0) {
    return `M 0.00 ${centerY.toFixed(2)} L ${width.toFixed(2)} ${centerY.toFixed(2)}`;
  }

  const samples = 32;
  const step = width / samples;
  let path = `M 0.00 ${centerY.toFixed(2)}`;

  for (let index = 1; index <= samples; index += 1) {
    const progress = index / samples;
    const x = step * index;
    const taper = Math.pow(Math.sin(progress * Math.PI), 0.9);
    const primary = Math.sin(progress * metrics.frequency * Math.PI * 2 + phase);
    const secondary = Math.sin(progress * metrics.frequency * Math.PI * 3.6 - phase * 1.35);
    const offset = taper * (primary * metrics.amplitude + secondary * metrics.secondaryAmplitude);
    const y = clamp(centerY - offset, 2, height - 2);
    path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }

  return path;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
