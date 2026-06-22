import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { PublicSettings } from "../../types";
import { AudioSettings } from "./AudioSettings";

function makeSettings(): PublicSettings {
  return {
    recording_root: "./recordings",
    artifact_open_app: "",
    transcription_provider: "nexara",
    transcription_url: "",
    transcription_task: "transcribe",
    transcription_diarization_setting: "general",
    salute_speech_scope: "SALUTE_SPEECH_CORP",
    salute_speech_model: "general",
    salute_speech_language: "ru-RU",
    salute_speech_sample_rate: 48000,
    salute_speech_channels_count: 1,
    apple_speech_locale: "ru_RU",
    summary_url: "",
    summary_prompt: "",
    openai_model: "gpt-5.1-codex-mini",
    audio_format: "opus",
    opus_bitrate_kbps: 24,
    audio_speed_multiplier: 1,
    mic_device_name: "",
    system_device_name: "",
    auto_run_pipeline_on_stop: false,
    auto_transcribe_on_stop: false,
    api_call_logging_enabled: false,
    auto_delete_audio_enabled: false,
    auto_delete_audio_days: 30,
    yandex_sync_enabled: false,
    yandex_sync_interval: "24h",
    yandex_sync_remote_folder: "BigEcho",
    brain_sync_enabled: false,
    brain_sync_summary_auto_upload_enabled: false,
    brain_sync_url: "",
    todoist_sync_enabled: false,
    todoist_auto_add: false,
    show_minitray_overlay: false,
  };
}

function Harness() {
  const [settings, setSettings] = useState<PublicSettings>(makeSettings());

  return (
    <AudioSettings
      settings={settings}
      setSettings={setSettings}
      isDirty={() => false}
      audioDevices={[]}
      autoDetectSystemSource={() => undefined}
      macosSystemAudioPermission={{ kind: "unsupported", can_request: false }}
      macosSystemAudioPermissionLoadState="ready"
      openMacosSystemAudioSettings={async () => undefined}
    />
  );
}

describe("AudioSettings", () => {
  it("selects one speed multiplier with 1x selected by default", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const oneX = screen.getByRole("button", { name: "1x" });
    const oneAndHalf = screen.getByRole("button", { name: "1.5x" });
    const double = screen.getByRole("button", { name: "2x" });

    expect(oneX).toHaveAttribute("aria-pressed", "true");

    await user.click(oneAndHalf);
    expect(oneX).toHaveAttribute("aria-pressed", "false");
    expect(oneAndHalf).toHaveAttribute("aria-pressed", "true");
    expect(double).toHaveAttribute("aria-pressed", "false");

    await user.click(double);
    expect(oneAndHalf).toHaveAttribute("aria-pressed", "false");
    expect(double).toHaveAttribute("aria-pressed", "true");

    await user.click(oneX);
    expect(oneX).toHaveAttribute("aria-pressed", "true");
    expect(double).toHaveAttribute("aria-pressed", "false");
  });
});
