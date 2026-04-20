import { type ReactNode } from "react";
import { Button, Flex, Typography } from "antd";
import { AudioMutedOutlined, AudioOutlined } from "@ant-design/icons";
import { AudioWave } from "./AudioWave";

type AudioRowProps = {
  label: string;
  animationLabel: string;
  muteLabel: string;
  level: number;
  muted: boolean;
  disabled: boolean;
  onToggleMuted: () => void;
  statusText?: string | null;
  trailing?: ReactNode;
  inlineTrailing?: boolean;
};

export function AudioRow({
  label,
  animationLabel,
  muteLabel,
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
    <Flex align="center" gap={6} style={{ minHeight: 28 }}>
      <Typography.Text style={{ width: 48, flexShrink: 0, fontSize: 12 }}>
        {label}
      </Typography.Text>
      <Flex flex={1} align="center" gap={6} style={{ minWidth: 0 }}>
        {statusText ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
            {statusText}
          </Typography.Text>
        ) : (
          <div style={{ flex: 1, height: 22 }} aria-label={animationLabel}>
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
        icon={muted ? <AudioMutedOutlined /> : <AudioOutlined />}
        style={{ width: 26, height: 26, padding: 0, flexShrink: 0, opacity: 1 }}
      />
    </Flex>
  );
}
