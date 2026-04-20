import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Flex, Typography } from "antd";
import { useRecordingController } from "../../hooks/useRecordingController";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import type { StartResponse } from "../../types";
import { formatAppStatus } from "../../lib/status";
import { getErrorMessage } from "../../lib/appUtils";
import { AudioRow } from "../../components/tray/AudioRow";
import { RecordingControls } from "../../components/tray/RecordingControls";
import { initializeAnalytics } from "../../lib/analytics";
import { getCurrentWindowLabel, tauriInvoke } from "../../lib/tauri";

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
    const windowLabel = getCurrentWindowLabel();
    tauriInvoke<string>("get_computer_name")
      .then((computerName) => {
        initializeAnalytics({ window_label: windowLabel, computer_name: computerName });
      })
      .catch(() => {
        initializeAnalytics({ window_label: windowLabel });
      });
  }, []);

  // Mark html/body with tray-window-* classes so CSS can disable opaque page
  // background — this is what lets the rounded corners of .tray-shell sit on a
  // transparent Tauri window instead of a grey square.
  useEffect(() => {
    document.documentElement.classList.add("tray-window-html");
    document.body.classList.add("tray-window-body");
    return () => {
      document.documentElement.classList.remove("tray-window-html");
      document.body.classList.remove("tray-window-body");
    };
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
      className="tray-shell"
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
            <select
              aria-label="Mic device"
              value={settings?.mic_device_name ?? ""}
              onChange={(e) => {
                void saveSettingsPatch({ mic_device_name: e.target.value }).catch((err) =>
                  setStatus(`error: ${String(err)}`)
                );
              }}
              disabled={isRecording}
              style={{
                minWidth: 80,
                height: 24,
                fontSize: 12,
                padding: "0 6px",
                borderRadius: 6,
                border: "1px solid rgba(140, 151, 165, 0.28)",
                background: "rgba(248, 250, 253, 0.96)",
                boxSizing: "border-box",
              }}
            >
              <option value="">Auto</option>
              {audioDevices.map((dev) => (
                <option key={dev} value={dev}>
                  {dev}
                </option>
              ))}
            </select>
          </label>
        }
      />

      {/* System row */}
      <AudioRow
        label="System"
        animationLabel="System activity"
        muteLabel="system audio"
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
              <select
                aria-label="System device"
                value={settings?.system_device_name ?? ""}
                onChange={(e) => {
                  void saveSettingsPatch({ system_device_name: e.target.value }).catch((err) =>
                    setStatus(`error: ${String(err)}`)
                  );
                }}
                disabled={isRecording}
                style={{
                  minWidth: 80,
                  height: 24,
                  fontSize: 12,
                  padding: "0 6px",
                  borderRadius: 6,
                  border: "1px solid rgba(140, 151, 165, 0.28)",
                  background: "rgba(248, 250, 253, 0.96)",
                  boxSizing: "border-box",
                }}
              >
                <option value="">Auto</option>
                {audioDevices.map((dev) => (
                  <option key={dev} value={dev}>
                    {dev}
                  </option>
                ))}
              </select>
            </label>
          ) : null
        }
      />

      {/* Rec / Stop */}
      <Flex gap={8} style={{ marginTop: "auto" }} /* pushes buttons to bottom in compact tray */>
        <Button
          type="primary"
          onClick={() => void startFromTray()}
          disabled={isRecording}
          style={{ flex: 1 }}
        >
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "currentColor",
              marginRight: 6,
              opacity: 1,
              backgroundColor: "rgb(224, 55, 55)",
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
