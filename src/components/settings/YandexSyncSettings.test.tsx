import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { YandexSyncSettings } from "./YandexSyncSettings";
import type { PublicSettings, YandexSyncLastRun, YandexSyncStatus } from "../../types";
import type { UseYandexSyncReturn } from "../../hooks/useYandexSync";

const invokeMock = vi.fn();
vi.mock("../../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
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

function makeYandexSyncStub(overrides: Partial<UseYandexSyncReturn> = {}): UseYandexSyncReturn {
  const defaultStatus: YandexSyncStatus = { is_running: false, last_run: null };
  return {
    hasToken: false,
    tokenState: "unknown",
    status: defaultStatus,
    progress: null,
    preflight: null,
    refreshHasToken: vi.fn(async () => undefined),
    refreshStatus: vi.fn(async () => defaultStatus),
    saveToken: vi.fn(async (_v: string) => undefined),
    clearToken: vi.fn(async () => undefined),
    syncNow: vi.fn(async (): Promise<YandexSyncLastRun | null> => null),
    ...overrides,
  };
}

describe("YandexSyncSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("disables interval and remote-folder inputs when master switch is off", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings({ yandex_sync_enabled: false })}
        setSettings={() => undefined}
        isDirty={() => false}
        yandexSync={makeYandexSyncStub()}
      />,
    );
    const folder = (await screen.findByLabelText(/Folder on Yandex.Disk/i)) as HTMLInputElement;
    expect(folder).toBeDisabled();

    const selectContainer = screen.getByRole("combobox").closest(".ant-select")!;
    expect(selectContainer).toHaveClass("ant-select-disabled");
  });

  it("Get token button invokes open_external_url with Polygon URL", async () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        yandexSync={makeYandexSyncStub()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Get token/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
        url: "https://yandex.ru/dev/disk/poligon/",
      }),
    );
  });

  it("Save token calls yandexSync.saveToken with trimmed value", async () => {
    const saveToken = vi.fn(async (_v: string) => undefined);
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        yandexSync={makeYandexSyncStub({ saveToken })}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/OAuth token/i), {
      target: { value: "  abc  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save token/i }));
    await waitFor(() => expect(saveToken).toHaveBeenCalledWith("abc"));
  });

  it("renders last_run counters when status has a last_run", () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        yandexSync={makeYandexSyncStub({
          hasToken: true,
          status: {
            is_running: false,
            last_run: {
              started_at_iso: "2026-04-24T10:00:00Z",
              finished_at_iso: "2026-04-24T10:02:14Z",
              duration_ms: 134_000,
              total_objects: 131,
              not_synced: 4,
              uploaded: 3,
              skipped: 128,
              failed: 1,
              errors: [{ path: "a/b.opus", message: "network" }],
            },
          },
        })}
      />,
    );
    expect(
      screen.getByText(/Всего объектов: 131, не синхронизировано: 4/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Uploaded 3 · Skipped 128 · Failed 1/)).toBeInTheDocument();
    expect(screen.getByText(/Show errors/)).toBeInTheDocument();
  });

  it("renders pre-flight status while sync is running", () => {
    render(
      <YandexSyncSettings
        settings={baseSettings()}
        setSettings={() => undefined}
        isDirty={() => false}
        yandexSync={makeYandexSyncStub({
          hasToken: true,
          status: { is_running: true, last_run: null },
          preflight: { total_objects: 42, not_synced: 7 },
        })}
      />,
    );
    expect(
      screen.getByText(/Всего объектов: 42, не синхронизировано: 7/),
    ).toBeInTheDocument();
  });
});
