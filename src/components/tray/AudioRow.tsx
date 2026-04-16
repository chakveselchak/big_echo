import { type ReactNode } from "react";
import { Button, Flex, Typography } from "antd";
import { AudioWave } from "./AudioWave";

type AudioRowProps = {
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

function AudioIcon({ icon }: { icon: "mic" | "system" }) {
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

export function AudioRow({
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
}: AudioRowProps) {
  const buttonLabel = muted ? `Unmute ${muteLabel}` : `Mute ${muteLabel}`;

  return (
    <Flex align="center" gap={6} style={{ minHeight: 36 }}>
      <Typography.Text style={{ width: 48, flexShrink: 0, fontSize: 13 }}>
        {label}
      </Typography.Text>
      <Flex flex={1} align="center" gap={6} style={{ minWidth: 0 }}>
        {statusText ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
            {statusText}
          </Typography.Text>
        ) : (
          <div style={{ flex: 1, height: 28 }} aria-label={animationLabel}>
            <AudioWave level={level} muted={muted} />
          </div>
        )}
        {trailing && (
          <div style={inlineTrailing ? { flexShrink: 0 } : { width: "100%", marginTop: 4 }}>
            {trailing}
          </div>
        )}
      </Flex>
      <Button
        htmlType="button"
        type={muted ? "default" : "text"}
        aria-label={buttonLabel}
        aria-pressed={muted}
        disabled={disabled}
        onClick={onToggleMuted}
        style={{ position: "relative", width: 32, height: 32, padding: 0, flexShrink: 0 }}
      >
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AudioIcon icon={icon} />
          {muted && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <svg viewBox="0 0 20 20" width={20} height={20} aria-hidden="true">
                <line x1="4" y1="4" x2="16" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
          )}
        </span>
      </Button>
    </Flex>
  );
}
