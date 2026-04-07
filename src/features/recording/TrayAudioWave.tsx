import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  buildTrayAudioWavePath,
  getTrayAudioWaveMetrics,
  TRAY_AUDIO_WAVE_VIEWBOX_HEIGHT,
  TRAY_AUDIO_WAVE_VIEWBOX_WIDTH,
} from "./trayAudio";

type TrayAudioWaveProps = {
  level: number;
  muted: boolean;
};

export function TrayAudioWave({ level, muted }: TrayAudioWaveProps) {
  const metrics = getTrayAudioWaveMetrics(level, muted);
  const [phase, setPhase] = useState(0);
  const metricsRef = useRef(metrics);
  const isAnimated = metrics.mode !== "flat";

  metricsRef.current = metrics;

  useEffect(() => {
    if (!isAnimated) {
      setPhase(0);
      return;
    }

    const intervalMs = 16;
    const timer = window.setInterval(() => {
      setPhase((current) => (current + getPhaseStep(metricsRef.current)) % (Math.PI * 2));
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [isAnimated]);

  const flatPath = buildTrayAudioWavePath(
    {
      mode: "flat",
      amplitude: 0,
      secondaryAmplitude: 0,
      frequency: 0,
      speed: 0,
      strokeWidth: metrics.strokeWidth,
    },
    0
  );
  const wavePath = buildTrayAudioWavePath(metrics, phase);

  return (
    <div className="tray-audio-lottie" data-wave-mode={metrics.mode}>
      <svg
        className="tray-audio-wave-svg"
        viewBox={`0 0 ${TRAY_AUDIO_WAVE_VIEWBOX_WIDTH} ${TRAY_AUDIO_WAVE_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className="tray-audio-wave-baseline" d={flatPath} vectorEffect="non-scaling-stroke" />
        <path
          className="tray-audio-wave-glow"
          d={wavePath}
          vectorEffect="non-scaling-stroke"
          style={{ "--tray-audio-wave-stroke-width": `${metrics.strokeWidth + 1.2}px` } as CSSProperties}
        />
        <path
          className="tray-audio-wave-path"
          d={wavePath}
          vectorEffect="non-scaling-stroke"
          style={{ "--tray-audio-wave-stroke-width": `${metrics.strokeWidth}px` } as CSSProperties}
        />
      </svg>
    </div>
  );
}

function getPhaseStep(metrics: ReturnType<typeof getTrayAudioWaveMetrics>) {
  const modeMultiplier = metrics.mode === "strong" ? 0.16 : 0.11;
  return metrics.speed * modeMultiplier;
}
