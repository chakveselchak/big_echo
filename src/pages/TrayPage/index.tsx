import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Flex, Select, Typography } from "antd";
import { useRecordingController } from "../../hooks/useRecordingController";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import type { StartResponse } from "../../types";
import { formatAppStatus } from "../../lib/status";
import { getErrorMessage } from "../../lib/appUtils";
import { AudioRow } from "../../components/tray/AudioRow";
import { RecordingControls } from "../../components/tray/RecordingControls";
import { initializeAnalytics } from "../../lib/analytics";
import { getCurrentWindowLabel } from "../../lib/tauri";

export function TrayPage() {
  const [status, setStatus] = useState("idle");
  const [topic, setTopic] = useState("");
  const [source, setSource] = useState("slack");
  const [session, setSession] = useState<StartResponse | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [trayMuteError, setTrayMuteError] = useState<string | null>(null);

  const {
    audioDevices,
    macosSystemAudioPermission,
    macosSystemAudioPermissionLoadState,
    openMacosSystemAudioSettings,
    saveSettingsPatch,
    settings,
  } = useSettingsForm({ enabled: true, isTrayWindow: true, setStatus });

  const loadSessions = useCallback(async () => {}, []);

  const { liveLevels, muteState, startFromTray, stop, toggleInputMuted } = useRecordingController({
    enableTrayCommandListeners: false,
    isSettingsWindow: false,
    isTrayWindow: true,
    topic,
    setTopic,
    tagsInput: "",
    source,
    setSource,
    notesInput: "",
    session,
    setSession,
    lastSessionId,
    setLastSessionId,
    status,
    setStatus,
    loadSessions,
  });

  useEffect(() => {
    initializeAnalytics({ window_label: getCurrentWindowLabel() });
  }, []);

  // Derived permission booleans
  const isMacosSystemAudioUnsupported =
    macosSystemAudioPermissionLoadState === "ready" &&
    macosSystemAudioPermission?.kind === "unsupported";
  const isMacosSystemAudioLoading = macosSystemAudioPermissionLoadState === "loading";
  const isMacosSystemAudioLookupFailed = macosSystemAudioPermissionLoadState === "error";
  const isMacosSystemAudioPermissionPendingReview =
    macosSystemAudioPermissionLoadState === "ready" &&
    macosSystemAudioPermission?.kind !== "granted" &&
    macosSystemAudioPermission?.kind !== "unsupported";
  const showMacosSystemAudioSettingsShortcut =
    isMacosSystemAudioPermissionPendingReview || isMacosSystemAudioLookupFailed;

  const isRecording = status === "recording";

  async function handleToggleMuted(channel: "mic" | "system") {
    setTrayMuteError(null);
    try {
      await toggleInputMuted(channel);
    } catch (err) {
      setTrayMuteError(`Mute update failed: ${getErrorMessage(err)}`);
    }
  }

  return (
    <Flex
      vertical
      gap={6}
      style={{ height: "100vh", padding: "6px 10px", boxSizing: "border-box" }}
    >
      {/* Status bar */}
      <Flex justify="space-between" align="center">
        <Typography.Text style={{ fontSize: 12 }}>
          Status: {formatAppStatus(status)}
        </Typography.Text>
        {showMacosSystemAudioSettingsShortcut && (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() => void openMacosSystemAudioSettings()}
          >
            Open System Settings
          </Button>
        )}
      </Flex>

      {trayMuteError && (
        <Alert type="error" message={trayMuteError} banner style={{ fontSize: 12 }} />
      )}

      <RecordingControls
        source={source}
        topic={topic}
        isRecording={isRecording}
        onSourceChange={setSource}
        onTopicChange={setTopic}
      />

      {/* Mic row */}
      <AudioRow
        label="Mic"
        animationLabel="Mic activity"
        muteLabel="microphone"
        icon="mic"
        level={liveLevels.mic}
        muted={muteState.micMuted}
        disabled={!isRecording}
        onToggleMuted={() => void handleToggleMuted("mic")}
        inlineTrailing
        trailing={
          <label>
            <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
              Mic device
            </span>
            <Select
              aria-label="Mic device"
              size="small"
              style={{ minWidth: 80 }}
              value={settings?.mic_device_name ?? ""}
              options={[
                { value: "", label: "Auto" },
                ...audioDevices.map((dev) => ({ value: dev, label: dev })),
              ]}
              onChange={(value) => {
                void saveSettingsPatch({ mic_device_name: value }).catch((err) =>
                  setStatus(`error: ${String(err)}`)
                );
              }}
              disabled={isRecording}
            />
          </label>
        }
      />

      {/* System row */}
      <AudioRow
        label="System"
        animationLabel="System activity"
        muteLabel="system audio"
        icon="system"
        level={liveLevels.system}
        muted={muteState.systemMuted}
        disabled={
          !isRecording ||
          isMacosSystemAudioLoading ||
          isMacosSystemAudioLookupFailed ||
          isMacosSystemAudioPermissionPendingReview
        }
        onToggleMuted={() => void handleToggleMuted("system")}
        statusText={
          isMacosSystemAudioLoading
            ? "Checking macOS system audio status"
            : isMacosSystemAudioLookupFailed
              ? "Could not load macOS system audio status. Open System Settings to review the permission."
              : isMacosSystemAudioPermissionPendingReview
                ? "Grant Screen & System Audio Recording permission in System Settings."
                : null
        }
        inlineTrailing
        trailing={
          isMacosSystemAudioUnsupported ? (
            <label>
              <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
                System device
              </span>
              <Select
                aria-label="System device"
                size="small"
                style={{ minWidth: 80 }}
                value={settings?.system_device_name ?? ""}
                options={[
                  { value: "", label: "Auto" },
                  ...audioDevices.map((dev) => ({ value: dev, label: dev })),
                ]}
                onChange={(value) => {
                  void saveSettingsPatch({ system_device_name: value }).catch((err) =>
                    setStatus(`error: ${String(err)}`)
                  );
                }}
                disabled={isRecording}
              />
            </label>
          ) : null
        }
      />

      {/* Rec / Stop */}
      <Flex gap={8} style={{ marginTop: "auto" }}>
        <Button
          type="primary"
          onClick={() => void startFromTray()}
          disabled={isRecording}
          style={{ flex: 1 }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "currentColor",
              marginRight: 6,
              opacity: isRecording ? 0.4 : 1,
            }}
          />
          Rec
        </Button>
        <Button
          onClick={() => void stop()}
          disabled={!isRecording}
          style={{ flex: 1 }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              background: "currentColor",
              marginRight: 6,
              opacity: !isRecording ? 0.4 : 1,
            }}
          />
          Stop
        </Button>
      </Flex>
    </Flex>
  );
}
