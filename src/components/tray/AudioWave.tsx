import { useEffect, useMemo, useRef, type CSSProperties } from "react";

import {
  buildTrayAudioWavePath,
  getTrayAudioWaveMetrics,
  TRAY_AUDIO_WAVE_VIEWBOX_HEIGHT,
  TRAY_AUDIO_WAVE_VIEWBOX_WIDTH,
} from "../../lib/trayAudio";

import styles from "./AudioWave.module.css";

type AudioWaveProps = {
  level: number;
  muted: boolean;
};

/**
 * Live audio wave.
 *
 * Performance notes:
 *   - `metrics` is memoized on `level`/`muted` (instead of recomputed every
 *     render).
 *   - Animation runs via `requestAnimationFrame` (paused when tab is
 *     hidden, ~60fps browser-synced) instead of a 16ms `setInterval`.
 *   - The oscillating phase lives in a ref, not React state — the SVG
 *     `<path>` `d` attribute is mutated imperatively each frame, so React
 *     does NOT re-render the component tree on every tick. The only React
 *     renders happen when `metrics.mode` changes (e.g. flat ↔ gentle).
 */
export function AudioWave({ level, muted }: AudioWaveProps) {
  const metrics = useMemo(
    () => getTrayAudioWaveMetrics(level, muted),
    [level, muted],
  );
  const isAnimated = metrics.mode !== "flat";

  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  const phaseRef = useRef(0);
  const wavePathRef = useRef<SVGPathElement | null>(null);
  const glowPathRef = useRef<SVGPathElement | null>(null);

  const flatPath = useMemo(
    () =>
      buildTrayAudioWavePath(
        {
          mode: "flat",
          amplitude: 0,
          secondaryAmplitude: 0,
          frequency: 0,
          speed: 0,
          strokeWidth: metrics.strokeWidth,
        },
        0,
      ),
    [metrics.strokeWidth],
  );

  // Initial `d` attribute before the first RAF frame runs. Subsequent
  // frames overwrite this via refs without a React render.
  const initialWavePath = useMemo(
    () => buildTrayAudioWavePath(metrics, phaseRef.current),
    [metrics],
  );

  useEffect(() => {
    if (!isAnimated) {
      phaseRef.current = 0;
      // Snap paths back to the baseline in case we cut an in-flight RAF.
      if (wavePathRef.current) wavePathRef.current.setAttribute("d", flatPath);
      if (glowPathRef.current) glowPathRef.current.setAttribute("d", flatPath);
      return;
    }

    let rafId = 0;
    const tick = () => {
      phaseRef.current =
        (phaseRef.current + getPhaseStep(metricsRef.current)) % (Math.PI * 2);
      const nextPath = buildTrayAudioWavePath(metricsRef.current, phaseRef.current);
      if (wavePathRef.current) wavePathRef.current.setAttribute("d", nextPath);
      if (glowPathRef.current) glowPathRef.current.setAttribute("d", nextPath);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isAnimated, flatPath]);

  return (
    <div style={{ width: "100%", height: "100%" }} data-wave-mode={metrics.mode}>
      <svg
        className={styles.container}
        viewBox={`0 0 ${TRAY_AUDIO_WAVE_VIEWBOX_WIDTH} ${TRAY_AUDIO_WAVE_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className={styles.baseline} d={flatPath} vectorEffect="non-scaling-stroke" />
        <path
          ref={glowPathRef}
          className={styles.glow}
          d={initialWavePath}
          vectorEffect="non-scaling-stroke"
          style={{ "--wave-sw": `${metrics.strokeWidth + 1.2}px` } as CSSProperties}
        />
        <path
          ref={wavePathRef}
          className={styles.path}
          d={initialWavePath}
          vectorEffect="non-scaling-stroke"
          style={{ "--wave-sw": `${metrics.strokeWidth}px` } as CSSProperties}
          data-testid="wave-path"
        />
      </svg>
    </div>
  );
}

function getPhaseStep(metrics: ReturnType<typeof getTrayAudioWaveMetrics>) {
  const modeMultiplier = metrics.mode === "strong" ? 0.16 : 0.11;
  return metrics.speed * modeMultiplier;
}
