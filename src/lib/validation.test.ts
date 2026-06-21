import { describe, expect, it } from "vitest";
import type { PublicSettings } from "../types";
import { validateSettings } from "./validation";

function baseSettings(overrides: Partial<PublicSettings> = {}): PublicSettings {
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
    openai_model: "gpt-4.1-mini",
    audio_format: "opus",
    opus_bitrate_kbps: 24,
    mic_device_name: "",
    system_device_name: "",
    auto_run_pipeline_on_stop: false,
    api_call_logging_enabled: false,
    auto_delete_audio_enabled: false,
    auto_delete_audio_days: 30,
    yandex_sync_enabled: false,
    yandex_sync_interval: "24h",
    yandex_sync_remote_folder: "BigEcho",
    show_minitray_overlay: false,
    brain_sync_enabled: false,
    brain_sync_summary_auto_upload_enabled: false,
    brain_sync_url: "https://admin.my2brain.ru/api/v1/meetings/upload",
    ...overrides,
  };
}

describe("validateSettings", () => {
  it("allows empty Brain sync URL when sync is disabled", () => {
    expect(
      validateSettings(baseSettings({ brain_sync_enabled: false, brain_sync_url: "   " }))
    ).not.toContain("Неверный URL Brain sync");
  });

  it("rejects enabled Brain sync with a non-http URL", () => {
    expect(
      validateSettings(baseSettings({ brain_sync_enabled: true, brain_sync_url: "ftp://example.com/upload" }))
    ).toContain("Неверный URL Brain sync");
  });

  it("rejects enabled Brain summary auto-upload without a URL", () => {
    expect(
      validateSettings(baseSettings({
        brain_sync_enabled: false,
        brain_sync_summary_auto_upload_enabled: true,
        brain_sync_url: "   ",
      }))
    ).toContain("Неверный URL Brain sync");
  });

  it("accepts enabled Brain sync with an HTTPS URL after trimming", () => {
    expect(
      validateSettings(baseSettings({ brain_sync_enabled: true, brain_sync_url: "  https://example.com/upload  " }))
    ).toEqual([]);
  });
});
