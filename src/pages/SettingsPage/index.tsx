import { useState } from "react";
import { Alert, Button, Flex, Tabs } from "antd";
import { readBrainSyncUnlocked } from "../../lib/brainSyncUnlock";
import { useSettingsForm } from "../../hooks/useSettingsForm";
import { useYandexSync } from "../../hooks/useYandexSync";
import { useTodoistSync } from "../../hooks/useTodoistSync";
import type { PublicSettings, SettingsTab } from "../../types";
import { tauriInvoke } from "../../lib/tauri";
import { getErrorMessage } from "../../lib/appUtils";
import { GeneralSettings } from "../../components/settings/GeneralSettings";
import { TranscriptionSettings } from "../../components/settings/TranscriptionSettings";
import { AudioSettings } from "../../components/settings/AudioSettings";
import { YandexSyncSettings } from "../../components/settings/YandexSyncSettings";
import { TodoistSyncSettings } from "../../components/settings/TodoistSyncSettings";
import { BrainSyncSettings } from "../../components/settings/BrainSyncSettings";
import { LoadingPlaceholder } from "../../components/LoadingPlaceholder";
import { useI18n } from "../../i18n";

type SyncSessionsResult = {
  added: number;
  removed: number;
};

export function SettingsPage({ brainUnlocked }: { brainUnlocked?: boolean } = {}) {
  const { t } = useI18n();
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

  const yandexSync = useYandexSync(settingsTab === "yandex");
  const todoistSync = useTodoistSync(settingsTab === "todoist");

  // When embedded in the main window the unlock flag is owned by MainPage and
  // passed in; the standalone settings window falls back to reading storage.
  const isBrainUnlocked = brainUnlocked ?? readBrainSyncUnlocked();

  if (!settings) {
    return (
      <LoadingPlaceholder
        className="settings-loading"
        label={t("settings.loading")}
        ariaLabel={t("settings.loading")}
      />
    );
  }

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
      isDirty("auto_transcribe_on_stop") ||
      isDirty("api_call_logging_enabled") ||
      isDirty("auto_delete_audio_enabled") ||
      isDirty("auto_delete_audio_days"),
    audio:
      isDirty("audio_format") ||
      isDirty("opus_bitrate_kbps") ||
      isDirty("audio_speed_multiplier") ||
      isDirty("mic_device_name") ||
      isDirty("system_device_name"),
    yandex:
      isDirty("yandex_sync_enabled") ||
      isDirty("yandex_sync_interval") ||
      isDirty("yandex_sync_remote_folder"),
    todoist:
      isDirty("todoist_sync_enabled") ||
      isDirty("todoist_auto_add"),
    brain:
      isDirty("brain_sync_enabled") ||
      isDirty("brain_sync_summary_auto_upload_enabled") ||
      isDirty("brain_sync_url"),
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
          {t("settings.tabs.generals")}{dirtyByTab.generals && dirtyDot}
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
          {t("settings.tabs.audioToText")}{dirtyByTab.audiototext && dirtyDot}
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
          {t("settings.tabs.audio")}{dirtyByTab.audio && dirtyDot}
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
    {
      key: "yandex" as SettingsTab,
      label: (
        <>
          {t("settings.tabs.yandex")}{dirtyByTab.yandex && dirtyDot}
        </>
      ),
      children: (
        <YandexSyncSettings
          settings={settings}
          setSettings={setSettings}
          isDirty={isDirty}
          yandexSync={yandexSync}
        />
      ),
    },
    {
      key: "todoist" as SettingsTab,
      label: (
        <>
          {t("settings.tabs.todoist")}{dirtyByTab.todoist && dirtyDot}
        </>
      ),
      children: (
        <TodoistSyncSettings
          settings={settings}
          setSettings={setSettings}
          isDirty={isDirty}
          todoistSync={todoistSync}
        />
      ),
    },
    ...(isBrainUnlocked
      ? [
          {
            key: "brain" as SettingsTab,
            label: (
              <>
                {t("settings.tabs.brain")}{dirtyByTab.brain && dirtyDot}
              </>
            ),
            children: (
              <BrainSyncSettings
                settings={settings}
                setSettings={setSettings}
                isDirty={isDirty}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <div style={{ padding: 20, overflowY: "auto" }}>
      <Tabs
        activeKey={settingsTab}
        aria-label={t("settings.title")}
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
          {t("settings.actions.save")}
        </Button>
        {settingsTab === "yandex" && (
          <Button
            onClick={() => void yandexSync.syncNow()}
            loading={yandexSync.status.is_running}
            disabled={!yandexSync.hasToken || yandexSync.status.is_running}
          >
            {t("settings.actions.syncNow")}
          </Button>
        )}
      </Flex>
    </div>
  );
}
