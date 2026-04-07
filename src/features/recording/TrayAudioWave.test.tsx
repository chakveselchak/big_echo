import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTrayAudioWavePath, getTrayAudioWaveMetrics } from "./trayAudio";
import { TrayAudioWave } from "./TrayAudioWave";

describe("TrayAudioWave", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps animating while the input level changes", () => {
    vi.useFakeTimers();

    const { container, rerender } = render(<TrayAudioWave level={0.18} muted={false} />);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender(<TrayAudioWave level={0.44} muted={false} />);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender(<TrayAudioWave level={0.82} muted={false} />);

    act(() => {
      vi.advanceTimersByTime(50);
    });

    const renderedPath = container.querySelector(".tray-audio-wave-path")?.getAttribute("d");
    const zeroPhasePath = buildTrayAudioWavePath(getTrayAudioWaveMetrics(0.82, false), 0);

    expect(renderedPath).not.toBe(zeroPhasePath);
  });
});
