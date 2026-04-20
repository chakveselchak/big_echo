import { useState } from "react";
import { Alert, Button, Flex, Tabs } from "antd";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import type { PublicSettings, SettingsTab } from "../../types";
import { tauriInvoke } from "../../lib/tauri";
import { getErrorMessage } from "../../lib/appUtils";
import { GeneralSettings } from "../../components/settings/GeneralSettings";
import { TranscriptionSettings } from "../../components/settings/TranscriptionSettings";
import { AudioSettings } from "../../components/settings/AudioSettings";

type SyncSessionsResult = {
  added: number;
  removed: number;
};

export function SettingsPage() {
  const [status, setStatus] = useState("idle");
  const [isSyncingSessions, setIsSyncingSessions] = useState(false);

  async function syncSessions() {
    setIsSyncingSessions(true);
    try {
      const result = await tauriInvoke<SyncSessionsResult>("sync_sessions");
      setStatus(`sync_done: added ${result.added}, removed ${result.removed}`);
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
    } finally {
      setIsSyncingSessions(false);
    }
  }

  const {
    audioDevices,
    autoDetectSystemSource,
    canSaveSettings,
    macosSystemAudioPermission,
    macosSystemAudioPermissionLoadState,
    nexaraKey,
    nexaraSecretState,
    openaiKey,
    openaiSecretState,
    openMacosSystemAudioSettings,
    pickRecordingRoot,
    salutSpeechAuthKey,
    salutSpeechSecretState,
    saveSettings,
    savedSettingsSnapshot,
    setNexaraKey,
    setNexaraSecretState,
    setOpenaiKey,
    setOpenaiSecretState,
    setSalutSpeechAuthKey,
    setSalutSpeechSecretState,
    setSettings,
    setSettingsTab,
    settings,
    settingsErrors,
    settingsTab,
    textEditorApps,
  } = useSettingsForm({ enabled: true, isTrayWindow: false, setStatus });

  if (!settings) return null;

  const isDirty = (field: keyof PublicSettings) =>
    Boolean(savedSettingsSnapshot && settings[field] !== savedSettingsSnapshot[field]);

  const dirtyByTab: Record<SettingsTab, boolean> = {
    audiototext:
      isDirty("transcription_provider") ||
      isDirty("transcription_url") ||
      isDirty("transcription_task") ||
      isDirty("transcription_diarization_setting") ||
      isDirty("salute_speech_scope") ||
      isDirty("salute_speech_model") ||
      isDirty("salute_speech_language") ||
      isDirty("salute_speech_sample_rate") ||
      isDirty("salute_speech_channels_count") ||
      isDirty("summary_url") ||
      isDirty("summary_prompt") ||
      isDirty("openai_model") ||
      nexaraKey.trim().length > 0 ||
      salutSpeechAuthKey.trim().length > 0 ||
      openaiKey.trim().length > 0,
    generals:
      isDirty("recording_root") ||
      isDirty("artifact_open_app") ||
      isDirty("auto_run_pipeline_on_stop") ||
      isDirty("api_call_logging_enabled"),
    audio:
      isDirty("audio_format") ||
      isDirty("opus_bitrate_kbps") ||
      isDirty("mic_device_name") ||
      isDirty("system_device_name"),
  };

  const dirtyDot = (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        backgroundColor: "var(--ant-color-warning, #faad14)",
        marginLeft: 6,
        verticalAlign: "middle",
      }}
      aria-hidden="true"
    />
  );

  const tabItems = [
    {
      key: "generals" as SettingsTab,
      label: (
        <>
          Generals{dirtyByTab.generals && dirtyDot}
        </>
      ),
      children: (
        <GeneralSettings
          settings={settings}
          setSettings={(s) => setSettings(s)}
          isDirty={isDirty}
          pickRecordingRoot={() => void pickRecordingRoot()}
          syncSessions={syncSessions}
          isSyncingSessions={isSyncingSessions}
          textEditorApps={textEditorApps}
        />
      ),
    },
    {
      key: "audiototext" as SettingsTab,
      label: (
        <>
          AudioToText{dirtyByTab.audiototext && dirtyDot}
        </>
      ),
      children: (
        <TranscriptionSettings
          settings={settings}
          setSettings={(s) => setSettings(s)}
          isDirty={isDirty}
          nexaraKey={nexaraKey}
          setNexaraKey={setNexaraKey}
          nexaraSecretState={nexaraSecretState}
          setNexaraSecretState={setNexaraSecretState}
          salutSpeechAuthKey={salutSpeechAuthKey}
          setSalutSpeechAuthKey={setSalutSpeechAuthKey}
          salutSpeechSecretState={salutSpeechSecretState}
          setSalutSpeechSecretState={setSalutSpeechSecretState}
          openaiKey={openaiKey}
          setOpenaiKey={setOpenaiKey}
          openaiSecretState={openaiSecretState}
          setOpenaiSecretState={setOpenaiSecretState}
        />
      ),
    },
    {
      key: "audio" as SettingsTab,
      label: (
        <>
          Audio{dirtyByTab.audio && dirtyDot}
        </>
      ),
      children: (
        <AudioSettings
          settings={settings}
          setSettings={setSettings}
          isDirty={isDirty}
          audioDevices={audioDevices}
          autoDetectSystemSource={autoDetectSystemSource}
          macosSystemAudioPermission={macosSystemAudioPermission}
          macosSystemAudioPermissionLoadState={macosSystemAudioPermissionLoadState}
          openMacosSystemAudioSettings={openMacosSystemAudioSettings}
        />
      ),
    },
  ];

  return (
    <div style={{ padding: 20, overflowY: "auto" }}>
      <Tabs
        activeKey={settingsTab}
        aria-label="Settings sections"
        items={tabItems}
        onChange={(key) => setSettingsTab(key as SettingsTab)}
      />

      {settingsErrors.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {settingsErrors.map((error) => (
            <Alert key={error} type="error" message={error} style={{ marginBottom: 8 }} />
          ))}
        </div>
      )}

      {status !== "idle" && status.startsWith("error:") && (
        <Alert type="error" message={status.replace(/^error:\s*/, "")} style={{ marginBottom: 12 }} />
      )}

      {status.startsWith("sync_done:") && (
        <Alert type="success" message={`Sync complete — ${status.replace(/^sync_done:\s*/, "")}`} style={{ marginBottom: 12 }} />
      )}

      <Flex gap={8}>
        <Button type="primary" onClick={() => void saveSettings()} disabled={!canSaveSettings}>
          Save settings
        </Button>
      </Flex>
    </div>
  );
}
