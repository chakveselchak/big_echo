import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTrayAudioWavePath, getTrayAudioWaveMetrics } from "../../lib/trayAudio";
import { AudioWave } from "./AudioWave";

describe("AudioWave", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps animating while the input level changes", () => {
    vi.useFakeTimers();

    const { container, rerender } = render(<AudioWave level={0.18} muted={false} />);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender(<AudioWave level={0.44} muted={false} />);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender(<AudioWave level={0.82} muted={false} />);

    act(() => {
      vi.advanceTimersByTime(50);
    });

    const renderedPath = container.querySelector("[data-testid=\"wave-path\"]")?.getAttribute("d");
    const zeroPhasePath = buildTrayAudioWavePath(getTrayAudioWaveMetrics(0.82, false), 0);

    expect(renderedPath).not.toBe(zeroPhasePath);
  });
});
