import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { YandexSyncSettings } from "./YandexSyncSettings";
import type { PublicSettings } from "../../types";

const invokeMock = vi.fn();
vi.mock("../../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => undefined),
}));

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
    ...overrides,
  };
}

describe("YandexSyncSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_has_token") return Promise.resolve(false);
      if (cmd === "yandex_sync_status") return Promise.resolve({ is_running: false, last_run: null });
      return Promise.resolve();
    });
  });

  it("disables interval and remote-folder inputs when master switch is off", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings({ yandex_sync_enabled: false })}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    const folder = await screen.findByLabelText(/Folder on Yandex.Disk/i) as HTMLInputElement;
    expect(folder).toBeDisabled();
  });

  it("Sync now is disabled until a token is saved", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    const btn = await screen.findByRole("button", { name: /Sync now/i });
    expect(btn).toBeDisabled();
  });

  it("Get token button invokes open_external_url with Polygon URL", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Get token/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
        url: "https://yandex.ru/dev/disk/poligon/",
      }),
    );
  });

  it("Save token invokes yandex_sync_set_token with trimmed value", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/OAuth token/i), {
      target: { value: "  abc  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save token/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("yandex_sync_set_token", { token: "abc" }),
    );
  });

  it("renders last_run counters when status has a last_run", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "yandex_sync_has_token") return Promise.resolve(true);
      if (cmd === "yandex_sync_status")
        return Promise.resolve({
          is_running: false,
          last_run: {
            started_at_iso: "2026-04-24T10:00:00Z",
            finished_at_iso: "2026-04-24T10:02:14Z",
            duration_ms: 134_000,
            uploaded: 3,
            skipped: 128,
            failed: 1,
            errors: [{ path: "a/b.opus", message: "network" }],
          },
        });
      return Promise.resolve();
    });
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        enabled
      />,
    );
    await screen.findByText(/Uploaded 3 · Skipped 128 · Failed 1/);
    await screen.findByText(/Show errors/);
  });
});
