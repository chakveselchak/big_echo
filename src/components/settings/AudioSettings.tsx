import React from "react";
import { Button, Card, Flex, Form, InputNumber, Select } from "antd";
import { Input } from "antd";
import type { MacosSystemAudioPermissionStatus, PublicSettings } from "../../types";
import { audioFormatOptions } from "../../types";

type AudioSettingsProps = {
  settings: PublicSettings;
  setSettings: React.Dispatch<React.SetStateAction<PublicSettings | null>>;
  isDirty: (field: keyof PublicSettings) => boolean;
  audioDevices: string[];
  autoDetectSystemSource: () => void;
  macosSystemAudioPermission: MacosSystemAudioPermissionStatus | null;
  macosSystemAudioPermissionLoadState: string;
  openMacosSystemAudioSettings: () => Promise<void>;
};

export function AudioSettings({
  settings,
  setSettings,
  isDirty,
  audioDevices,
  autoDetectSystemSource,
  macosSystemAudioPermission,
  macosSystemAudioPermissionLoadState,
  openMacosSystemAudioSettings,
}: AudioSettingsProps) {
  const isOpusFormat = settings.audio_format === "opus";
  const isMacosPermissionLoading = macosSystemAudioPermissionLoadState === "loading";
  const isMacosPermissionLookupFailed = macosSystemAudioPermissionLoadState === "error";
  const isMacosPermissionUnsupported =
    macosSystemAudioPermissionLoadState === "ready" &&
    macosSystemAudioPermission?.kind === "unsupported";

  const dirtyDot = (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        backgroundColor: "var(--ant-color-warning, #faad14)",
        marginLeft: 4,
        verticalAlign: "middle",
      }}
      aria-hidden="true"
    />
  );

  return (
    <Form layout="vertical" style={{ maxWidth: 520 }}>
      <Form.Item
        label={
          <span>
            Audio format{isDirty("audio_format") && dirtyDot}
          </span>
        }
      >
        <Select
          aria-label="Audio format"
          value={settings.audio_format}
          options={audioFormatOptions.map((value) => ({ value, label: value }))}
          onChange={(value) => setSettings((prev) => (prev ? { ...prev, audio_format: value } : prev))}
        />
      </Form.Item>

      <Form.Item
        label={
          <span>
            Opus bitrate kbps{isDirty("opus_bitrate_kbps") && dirtyDot}
          </span>
        }
      >
        <InputNumber
          aria-label="Opus bitrate kbps"
          value={settings.opus_bitrate_kbps}
          disabled={!isOpusFormat}
          onChange={(value) =>
            setSettings((prev) => (prev ? { ...prev, opus_bitrate_kbps: Number(value) || 24 } : prev))
          }
        />
      </Form.Item>

      <Form.Item
        label={
          <span>
            Mic device name{isDirty("mic_device_name") && dirtyDot}
          </span>
        }
      >
        <Input
          value={settings.mic_device_name}
          onChange={(e) =>
            setSettings((prev) => (prev ? { ...prev, mic_device_name: e.target.value } : prev))
          }
        />
      </Form.Item>

      {isMacosPermissionLoading ? (
        <Form.Item>
          <Card>
            <strong>Checking macOS permission status</strong>
            <div>Native system audio controls will appear once the status is available.</div>
          </Card>
        </Form.Item>
      ) : isMacosPermissionUnsupported ? (
        <>
          <Form.Item
            label={
              <label htmlFor="system_device_name">
                System source device name{isDirty("system_device_name") && dirtyDot}
              </label>
            }
          >
            <Input
              id="system_device_name"
              value={settings.system_device_name}
              onChange={(e) =>
                setSettings((prev) =>
                  prev ? { ...prev, system_device_name: e.target.value } : prev
                )
              }
            />
          </Form.Item>

          <Form.Item>
            <Button onClick={autoDetectSystemSource}>Auto-detect system source</Button>
          </Form.Item>

          {audioDevices.length > 0 && (
            <Form.Item>
              <Card title="Available input devices">
                <Flex wrap="wrap" gap={8}>
                  {audioDevices.map((dev) => (
                    <Button
                      key={dev}
                      htmlType="button"
                      onClick={() =>
                        setSettings((prev) =>
                          prev
                            ? {
                                ...prev,
                                mic_device_name: prev.mic_device_name || dev,
                                system_device_name: prev.system_device_name || dev,
                              }
                            : prev
                        )
                      }
                    >
                      {dev}
                    </Button>
                  ))}
                </Flex>
              </Card>
            </Form.Item>
          )}
        </>
      ) : (
        <Form.Item>
          <Card>
            {macosSystemAudioPermission?.kind === "granted" ? (
              <>
                <strong>Permission granted</strong>
                <div>System audio is captured natively by macOS.</div>
              </>
            ) : isMacosPermissionLookupFailed ? (
              <>
                <strong>System audio is captured natively by macOS</strong>
                <div>
                  Could not load permission status. Open System Settings to review Screen &amp;
                  System Audio Recording permission.
                </div>
                <div style={{ marginTop: 8 }}>
                  <Button onClick={() => void openMacosSystemAudioSettings()}>
                    Open System Settings
                  </Button>
                </div>
              </>
            ) : (
              <>
                <strong>System audio is captured natively by macOS</strong>
                <div>Grant Screen & System Audio Recording permission in System Settings.</div>
                <div style={{ marginTop: 8 }}>
                  <Button onClick={() => void openMacosSystemAudioSettings()}>
                    Open System Settings
                  </Button>
                </div>
              </>
            )}
          </Card>
        </Form.Item>
      )}
    </Form>
  );
}
