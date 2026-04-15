import { type ReactNode } from "react";
import { Button } from "antd";

import { TrayAudioWave } from "./TrayAudioWave";

type TrayAudioRowProps = {
  label: string;
  animationLabel: string;
  muteLabel: string;
  icon: "mic" | "system";
  level: number;
  muted: boolean;
  disabled: boolean;
  onToggleMuted: () => void;
  statusText?: string | null;
  trailing?: ReactNode;
  inlineTrailing?: boolean;
};

function TrayAudioIcon({ icon }: { icon: "mic" | "system" }) {
  if (icon === "mic") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="7" y="3" width="6" height="9" rx="3" />
        <path d="M5 9.5a5 5 0 0 0 10 0" />
        <path d="M10 14.5v2.5" />
        <path d="M7.5 17h5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 12.5h3.2l4.3 3V4.5l-4.3 3H4.5z" />
      <path d="M14.2 7.2a4 4 0 0 1 0 5.6" />
      <path d="M15.9 5.5a6.3 6.3 0 0 1 0 9" />
    </svg>
  );
}

export function TrayAudioRow({
  label,
  animationLabel,
  muteLabel,
  icon,
  level,
  muted,
  disabled,
  onToggleMuted,
  statusText,
  trailing,
  inlineTrailing = false,
}: TrayAudioRowProps) {
  const shouldShowVisual = !statusText;

  const buttonLabel = muted ? `Unmute ${muteLabel}` : `Mute ${muteLabel}`;

  return (
    <div className={`tray-audio-row${inlineTrailing && trailing ? " has-inline-trailing" : ""}`}>
      <span className="tray-audio-label">{label}</span>
      <div className="tray-audio-main">
        {statusText ? (
          <div className="tray-audio-status">{statusText}</div>
        ) : (
          <div className="tray-audio-visual" aria-label={animationLabel}>
            <TrayAudioWave level={level} muted={muted} />
          </div>
        )}
        {trailing ? <div className={`tray-audio-trailing${inlineTrailing ? " is-inline" : ""}`}>{trailing}</div> : null}
        <Button
          htmlType="button"
          className={`tray-audio-mute${muted ? " is-muted" : ""}`}
          aria-label={buttonLabel}
          aria-pressed={muted}
          disabled={disabled}
          onClick={onToggleMuted}
        >
          <span className="tray-audio-icon" aria-hidden="true">
            <TrayAudioIcon icon={icon} />
          </span>
          <span className="tray-audio-slash" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
