import { Form, Input, InputNumber, Select } from "antd";
import type { PublicSettings, SecretSaveState } from "../../types";
import {
  transcriptionProviderOptions,
  transcriptionTaskOptions,
  diarizationSettingOptions,
  saluteSpeechScopeOptions,
  saluteSpeechRecognitionModelOptions,
} from "../../types";
import { formatSecretSaveState } from "../../lib/appUtils";

type TranscriptionSettingsProps = {
  settings: PublicSettings;
  setSettings: (s: PublicSettings) => void;
  isDirty: (field: keyof PublicSettings) => boolean;
  nexaraKey: string;
  setNexaraKey: (v: string) => void;
  nexaraSecretState: SecretSaveState;
  setNexaraSecretState: (v: SecretSaveState) => void;
  salutSpeechAuthKey: string;
  setSalutSpeechAuthKey: (v: string) => void;
  salutSpeechSecretState: SecretSaveState;
  setSalutSpeechSecretState: (v: SecretSaveState) => void;
  openaiKey: string;
  setOpenaiKey: (v: string) => void;
  openaiSecretState: SecretSaveState;
  setOpenaiSecretState: (v: SecretSaveState) => void;
};

export function TranscriptionSettings({
  settings,
  setSettings,
  isDirty,
  nexaraKey,
  setNexaraKey,
  nexaraSecretState,
  setNexaraSecretState,
  salutSpeechAuthKey,
  setSalutSpeechAuthKey,
  salutSpeechSecretState,
  setSalutSpeechSecretState,
  openaiKey,
  setOpenaiKey,
  openaiSecretState,
  setOpenaiSecretState,
}: TranscriptionSettingsProps) {
  const isNexaraProvider = settings.transcription_provider === "nexara";

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
    <div>
      <section style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 16 }}>Транскрибация</h3>
        <Form layout="vertical" style={{ maxWidth: 520 }}>
          <Form.Item
            label={
              <label htmlFor="transcription_provider">
                Transcription provider{isDirty("transcription_provider") && dirtyDot}
              </label>
            }
          >
            <Select
              id="transcription_provider"
              aria-label="Transcription provider"
              value={settings.transcription_provider}
              options={transcriptionProviderOptions.map((value) => ({
                value,
                label: value === "nexara" ? "nexara" : "SalutSpeechAPI",
              }))}
              onChange={(value) => setSettings({ ...settings, transcription_provider: value })}
            />
          </Form.Item>

          {isNexaraProvider ? (
            <>
              <Form.Item
                label={
                  <label htmlFor="transcription_url">
                    Transcription URL{isDirty("transcription_url") && dirtyDot}
                  </label>
                }
              >
                <Input
                  id="transcription_url"
                  value={settings.transcription_url}
                  onChange={(e) => setSettings({ ...settings, transcription_url: e.target.value })}
                />
              </Form.Item>

              <Form.Item
                label={
                  <label htmlFor="transcription_task">
                    Task{isDirty("transcription_task") && dirtyDot}
                  </label>
                }
              >
                <Select
                  id="transcription_task"
                  aria-label="Task"
                  value={settings.transcription_task}
                  options={transcriptionTaskOptions.map((value) => ({ value, label: value }))}
                  onChange={(value) => setSettings({ ...settings, transcription_task: value })}
                />
              </Form.Item>

              <Form.Item
                label={
                  <label htmlFor="transcription_diarization_setting">
                    Diarization setting{isDirty("transcription_diarization_setting") && dirtyDot}
                  </label>
                }
              >
                <Select
                  id="transcription_diarization_setting"
                  aria-label="Diarization setting"
                  value={settings.transcription_diarization_setting}
                  options={diarizationSettingOptions.map((value) => ({ value, label: value }))}
                  onChange={(value) =>
                    setSettings({ ...settings, transcription_diarization_setting: value })
                  }
                />
              </Form.Item>

              <Form.Item
                label={
                  <label htmlFor="nexara_api_key">
                    Nexara API key
                    {nexaraKey.trim().length > 0 && dirtyDot}
                  </label>
                }
                extra={
                  nexaraSecretState !== "unknown" ? (
                    <span>Nexara API key: {formatSecretSaveState(nexaraSecretState)}</span>
                  ) : undefined
                }
              >
                <Input.Password
                  id="nexara_api_key"
                  aria-label="Nexara API key"
                  value={nexaraKey}
                  onChange={(e) => {
                    setNexaraKey(e.target.value);
                    setNexaraSecretState("unknown");
                  }}
                  placeholder="Stored in OS secure storage"
                />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item
                label={
                  <label htmlFor="salute_speech_scope">
                    Scope{isDirty("salute_speech_scope") && dirtyDot}
                  </label>
                }
              >
                <Select
                  id="salute_speech_scope"
                  aria-label="Scope"
                  value={settings.salute_speech_scope}
                  virtual={false}
                  options={saluteSpeechScopeOptions.map((value) => ({ value, label: value }))}
                  onChange={(value) => setSettings({ ...settings, salute_speech_scope: value })}
                />
              </Form.Item>

              <Form.Item
                label={
                  <label htmlFor="salute_speech_model">
                    Recognition model{isDirty("salute_speech_model") && dirtyDot}
                  </label>
                }
              >
                <Select
                  id="salute_speech_model"
                  aria-label="Recognition model"
                  value={settings.salute_speech_model}
                  virtual={false}
                  options={saluteSpeechRecognitionModelOptions.map((value) => ({
                    value,
                    label: value,
                  }))}
                  onChange={(value) => setSettings({ ...settings, salute_speech_model: value })}
                />
              </Form.Item>

              <Form.Item
                label={
                  <label htmlFor="salute_speech_language">
                    Language{isDirty("salute_speech_language") && dirtyDot}
                  </label>
                }
              >
                <Input
                  id="salute_speech_language"
                  value={settings.salute_speech_language}
                  onChange={(e) =>
                    setSettings({ ...settings, salute_speech_language: e.target.value })
                  }
                />
              </Form.Item>

              <Form.Item
                label={
                  <label htmlFor="salute_speech_sample_rate">
                    Sample rate{isDirty("salute_speech_sample_rate") && dirtyDot}
                  </label>
                }
              >
                <InputNumber
                  id="salute_speech_sample_rate"
                  aria-label="Sample rate"
                  value={settings.salute_speech_sample_rate}
                  onChange={(value) =>
                    setSettings({ ...settings, salute_speech_sample_rate: Number(value) || 0 })
                  }
                />
              </Form.Item>

              <Form.Item
                label={
                  <label htmlFor="salute_speech_channels_count">
                    Channels count{isDirty("salute_speech_channels_count") && dirtyDot}
                  </label>
                }
              >
                <InputNumber
                  id="salute_speech_channels_count"
                  aria-label="Channels count"
                  value={settings.salute_speech_channels_count}
                  onChange={(value) =>
                    setSettings({
                      ...settings,
                      salute_speech_channels_count: Number(value) || 0,
                    })
                  }
                />
              </Form.Item>

              <Form.Item
                label={
                  <label htmlFor="salute_speech_auth_key">
                    SalutSpeech authorization key
                    {salutSpeechAuthKey.trim().length > 0 && dirtyDot}
                  </label>
                }
                extra={
                  salutSpeechSecretState !== "unknown" ? (
                    <span>
                      SalutSpeech authorization key:{" "}
                      {formatSecretSaveState(salutSpeechSecretState)}
                    </span>
                  ) : undefined
                }
              >
                <Input.Password
                  id="salute_speech_auth_key"
                  aria-label="SalutSpeech authorization key"
                  value={salutSpeechAuthKey}
                  onChange={(e) => {
                    setSalutSpeechAuthKey(e.target.value);
                    setSalutSpeechSecretState("unknown");
                  }}
                  placeholder="Stored in OS secure storage"
                />
              </Form.Item>
            </>
          )}
        </Form>
      </section>

      <section>
        <h3 style={{ marginBottom: 16 }}>Саммари</h3>
        <Form layout="vertical" style={{ maxWidth: 520 }}>
          <Form.Item
            label={
              <label htmlFor="summary_url">
                Summary URL{isDirty("summary_url") && dirtyDot}
              </label>
            }
          >
            <Input
              id="summary_url"
              value={settings.summary_url}
              onChange={(e) => setSettings({ ...settings, summary_url: e.target.value })}
            />
          </Form.Item>

          <Form.Item
            label={
              <label htmlFor="summary_prompt">
                Summary prompt{isDirty("summary_prompt") && dirtyDot}
              </label>
            }
          >
            <Input.TextArea
              id="summary_prompt"
              value={settings.summary_prompt}
              onChange={(e) => setSettings({ ...settings, summary_prompt: e.target.value })}
              rows={4}
            />
          </Form.Item>

          <Form.Item
            label={
              <label htmlFor="openai_model">
                OpenAI model{isDirty("openai_model") && dirtyDot}
              </label>
            }
          >
            <Input
              id="openai_model"
              value={settings.openai_model}
              onChange={(e) => setSettings({ ...settings, openai_model: e.target.value })}
            />
          </Form.Item>

          <Form.Item
            label={
              <label htmlFor="openai_api_key">
                OpenAI API key{openaiKey.trim().length > 0 && dirtyDot}
              </label>
            }
            extra={
              openaiSecretState !== "unknown" ? (
                <span>OpenAI API key: {formatSecretSaveState(openaiSecretState)}</span>
              ) : undefined
            }
          >
            <Input.Password
              id="openai_api_key"
              aria-label="OpenAI API key"
              value={openaiKey}
              onChange={(e) => {
                setOpenaiKey(e.target.value);
                setOpenaiSecretState("unknown");
              }}
              placeholder="Stored in OS secure storage"
            />
          </Form.Item>
        </Form>
      </section>
    </div>
  );
}
