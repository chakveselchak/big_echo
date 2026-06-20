import { Button, Checkbox, Flex, Form, Input, InputNumber, Select, Tooltip } from "antd";
import { FileSyncOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import type { PublicSettings, TextEditorAppOption } from "../../types";
import { localIconForEditor } from "../../lib/appUtils";
import { useI18n } from "../../i18n";

type GeneralSettingsProps = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  pickRecordingRoot: () => void;
  syncSessions: () => Promise<void>;
  isSyncingSessions: boolean;
  textEditorApps: TextEditorAppOption[];
};

export function GeneralSettings({
  settings,
  setSettings,
  isDirty,
  pickRecordingRoot,
  syncSessions,
  isSyncingSessions,
  textEditorApps,
}: GeneralSettingsProps) {
  const { language, setLanguage, t } = useI18n();
  const openerUiFallback: TextEditorAppOption[] = [
    { id: "TextEdit", name: "TextEdit", icon_fallback: "📝", icon_data_url: null },
    { id: "Visual Studio Code", name: "Visual Studio Code", icon_fallback: "💠", icon_data_url: null },
    { id: "Sublime Text", name: "Sublime Text", icon_fallback: "🟧", icon_data_url: null },
    { id: "Cursor", name: "Cursor", icon_fallback: "🧩", icon_data_url: null },
    { id: "Windsurf", name: "Windsurf", icon_fallback: "🧩", icon_data_url: null },
    { id: "Zed", name: "Zed", icon_fallback: "🧩", icon_data_url: null },
  ];
  const openerOptions = textEditorApps.length > 0 ? textEditorApps : openerUiFallback;
  const openerMenuOptions = [
    { id: "", name: t("settings.artifactOpener.systemDefault"), icon_fallback: "", icon_data_url: null },
    ...openerOptions,
  ];

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
    <Form layout="vertical" style={{ maxWidth: 760 }}>
      <Form.Item label={<label htmlFor="ui_language">{t("settings.language.label")}</label>}>
        <Select
          id="ui_language"
          aria-label={t("settings.language.label")}
          value={language}
          virtual={false}
          options={[
            { value: "ru", label: t("settings.language.ru") },
            { value: "en", label: t("settings.language.en") },
          ]}
          onChange={(value) => setLanguage(value)}
        />
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="recording_root">
            {t("settings.recordingRoot.label")}{isDirty("recording_root") && dirtyDot}
          </label>
        }
      >
        <Flex gap={8}>
          <Input
            id="recording_root"
            value={settings.recording_root}
            onChange={(e) => setSettings({ ...settings, recording_root: e.target.value })}
          />
          <Button
            htmlType="button"
            aria-label={t("settings.recordingRoot.choose")}
            onClick={() => {
              void pickRecordingRoot();
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 16, height: 16 }}>
              <path
                d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.1a2.25 2.25 0 0 1 1.59.66l.84.84h6.47a2.25 2.25 0 0 1 2.25 2.25v7.5A2.25 2.25 0 0 1 18 18H6a2.25 2.25 0 0 1-2.25-2.25v-6a3 3 0 0 1 0-3Z"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            </svg>
          </Button>
          <Tooltip title={t("settings.recordingRoot.sync")}>
            <Button
              htmlType="button"
              aria-label={t("settings.recordingRoot.sync")}
              icon={<FileSyncOutlined aria-hidden="true" />}
              loading={isSyncingSessions}
              onClick={() => void syncSessions()}
            />
          </Tooltip>
        </Flex>
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="artifact_open_app">
            {t("settings.artifactOpener.label")}{isDirty("artifact_open_app") && dirtyDot}
          </label>
        }
      >
        <Select
          id="artifact_open_app"
          aria-label={t("settings.artifactOpener.label")}
          value={settings.artifact_open_app}
          virtual={false}
          options={openerMenuOptions.map((editor) => ({
            value: editor.id,
            label: (
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {editor.id && (editor.icon_data_url || localIconForEditor(editor.name)) ? (
                  <img
                    src={editor.icon_data_url || localIconForEditor(editor.name) || ""}
                    alt=""
                    aria-hidden="true"
                    style={{ width: 16, height: 16, objectFit: "contain" }}
                  />
                ) : editor.id ? (
                  <span aria-hidden="true">{editor.icon_fallback}</span>
                ) : null}
                <span>{editor.name}</span>
              </span>
            ),
          }))}
          onChange={(value) => setSettings({ ...settings, artifact_open_app: value })}
        />
      </Form.Item>

      <Form.Item>
        <Flex align="center" gap={8} wrap="wrap">
          <Checkbox
            id="auto_delete_audio_enabled"
            aria-label={t("settings.autoDelete.label")}
            checked={Boolean(settings.auto_delete_audio_enabled)}
            onChange={(e) =>
              setSettings({ ...settings, auto_delete_audio_enabled: e.target.checked })
            }
          >
            {t("settings.autoDelete.label")}
            {(isDirty("auto_delete_audio_enabled") ||
              isDirty("auto_delete_audio_days")) && dirtyDot}
          </Checkbox>
          <InputNumber
            aria-label={t("settings.autoDelete.inputLabel")}
            min={1}
            max={3650}
            value={settings.auto_delete_audio_days}
            disabled={!settings.auto_delete_audio_enabled}
            onChange={(v) =>
              setSettings({ ...settings, auto_delete_audio_days: Number(v ?? 1) })
            }
            style={{ width: 80 }}
          />
          <span>{t("settings.autoDelete.daysLabel")}</span>
          <Tooltip title={t("settings.autoDelete.tooltip")}>
            <QuestionCircleOutlined style={{ color: "#999", cursor: "help" }} />
          </Tooltip>
        </Flex>
      </Form.Item>

      <Form.Item>
        <Checkbox
          id="auto_run_pipeline_on_stop"
          aria-label={t("settings.autoRunPipeline")}
          checked={Boolean(settings.auto_run_pipeline_on_stop)}
          onChange={(event) =>
            setSettings({
              ...settings,
              auto_run_pipeline_on_stop: event.target.checked,
              auto_transcribe_on_stop: event.target.checked
                ? false
                : settings.auto_transcribe_on_stop,
            })
          }
        >
          {t("settings.autoRunPipeline")}{isDirty("auto_run_pipeline_on_stop") && dirtyDot}
        </Checkbox>
      </Form.Item>

      <Form.Item>
        <Checkbox
          id="auto_transcribe_on_stop"
          aria-label={t("settings.autoTranscribe")}
          checked={Boolean(settings.auto_transcribe_on_stop)}
          onChange={(event) =>
            setSettings({
              ...settings,
              auto_transcribe_on_stop: event.target.checked,
              auto_run_pipeline_on_stop: event.target.checked
                ? false
                : settings.auto_run_pipeline_on_stop,
            })
          }
        >
          {t("settings.autoTranscribe")}
          {isDirty("auto_transcribe_on_stop") && dirtyDot}
        </Checkbox>
      </Form.Item>

      <Form.Item>
        <Checkbox
          id="api_call_logging_enabled"
          aria-label={t("settings.apiLogging")}
          checked={Boolean(settings.api_call_logging_enabled)}
          onChange={(event) =>
            setSettings({ ...settings, api_call_logging_enabled: event.target.checked })
          }
        >
          {t("settings.apiLogging")}{isDirty("api_call_logging_enabled") && dirtyDot}
        </Checkbox>
      </Form.Item>

      <Form.Item>
        <Checkbox
          id="show_minitray_overlay"
          aria-label={t("settings.minitrayOverlay")}
          checked={Boolean(settings.show_minitray_overlay)}
          onChange={(event) =>
            setSettings({ ...settings, show_minitray_overlay: event.target.checked })
          }
        >
          {t("settings.minitrayOverlay")}{isDirty("show_minitray_overlay") && dirtyDot}
        </Checkbox>
      </Form.Item>
    </Form>
  );
}
