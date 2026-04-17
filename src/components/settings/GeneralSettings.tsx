import { Button, Flex, Form, Input, Select, Switch } from "antd";
import type { PublicSettings, TextEditorAppOption } from "../../types";
import { localIconForEditor } from "../../lib/appUtils";

type GeneralSettingsProps = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  pickRecordingRoot: () => void;
  textEditorApps: TextEditorAppOption[];
};

export function GeneralSettings({
  settings,
  setSettings,
  isDirty,
  pickRecordingRoot,
  textEditorApps,
}: GeneralSettingsProps) {
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
    { id: "", name: "System default", icon_fallback: "", icon_data_url: null },
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
    <Form layout="vertical" style={{ maxWidth: 520 }}>
      <Form.Item
        label={
          <label htmlFor="recording_root">
            Recording root{isDirty("recording_root") && dirtyDot}
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
            aria-label="Choose recording root folder"
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
        </Flex>
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="artifact_open_app">
            Artifact opener app (optional){isDirty("artifact_open_app") && dirtyDot}
          </label>
        }
      >
        <Select
          id="artifact_open_app"
          aria-label="Artifact opener app (optional)"
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

      <Form.Item
        label={
          <label htmlFor="auto_run_pipeline_on_stop">
            Auto-run pipeline on Stop{isDirty("auto_run_pipeline_on_stop") && dirtyDot}
          </label>
        }
      >
        <Switch
          id="auto_run_pipeline_on_stop"
          aria-label="Auto-run pipeline on Stop"
          checked={Boolean(settings.auto_run_pipeline_on_stop)}
          onChange={(checked) => setSettings({ ...settings, auto_run_pipeline_on_stop: checked })}
        />
      </Form.Item>

      <Form.Item
        label={
          <label htmlFor="api_call_logging_enabled">
            Enable API call logging{isDirty("api_call_logging_enabled") && dirtyDot}
          </label>
        }
      >
        <Switch
          id="api_call_logging_enabled"
          aria-label="Enable API call logging"
          checked={Boolean(settings.api_call_logging_enabled)}
          onChange={(checked) => setSettings({ ...settings, api_call_logging_enabled: checked })}
        />
      </Form.Item>
    </Form>
  );
}
