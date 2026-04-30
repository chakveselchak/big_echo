import { useEffect, useState } from "react";
import { Select } from "antd";
import { tauriInvoke } from "../lib/tauri";
import type { AppleSpeechAvailability, PublicSettings } from "../types";
import { transcriptionProviderOptions } from "../types";

const PROVIDER_LABELS: Record<string, string> = {
  nexara: "nexara",
  salute_speech: "SalutSpeechAPI",
  apple_speech: "Apple Speech",
};

type TranscriptionProviderSelectProps = {
  onChange?: (provider: string) => void;
};

export function TranscriptionProviderSelect({ onChange }: TranscriptionProviderSelectProps) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [appleSpeechSupported, setAppleSpeechSupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [data, availability] = await Promise.all([
          tauriInvoke<PublicSettings | null>("get_settings"),
          tauriInvoke<AppleSpeechAvailability>("get_apple_speech_availability").catch(() => ({
            supported: false,
          })),
        ]);
        if (cancelled || !data) return;
        setSettings(data);
        setAppleSpeechSupported(availability.supported);
        onChange?.(data.transcription_provider);
      } catch (err) {
        console.warn("Failed to load settings for provider switch:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onChange]);

  const options = transcriptionProviderOptions
    .filter((value) => value !== "apple_speech" || appleSpeechSupported)
    .map((value) => ({ value, label: PROVIDER_LABELS[value] ?? value }));

  async function handleChange(value: string) {
    if (!settings || value === settings.transcription_provider) return;
    const next = { ...settings, transcription_provider: value };
    setSettings(next);
    onChange?.(value);
    setSaving(true);
    try {
      await tauriInvoke("save_public_settings", { payload: next });
    } catch (err) {
      console.warn("Failed to save transcription provider:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select
      size="small"
      aria-label="Transcription provider"
      value={settings?.transcription_provider}
      options={options}
      onChange={handleChange}
      disabled={!settings || saving}
      style={{ minWidth: 140 }}
    />
  );
}
