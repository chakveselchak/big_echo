import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrainSyncSettings } from "./BrainSyncSettings";
import type { PublicSettings } from "../../types";

type TauriEvent<T> = { payload: T };
type BrainArchiveProgress = {
  total: number;
  processed: number;
  uploaded: number;
  skipped: number;
  failed: number;
  current_session_id: string | null;
  current_title: string | null;
  errors: string[];
};

const invokeMock = vi.fn();
let progressHandler: ((event: TauriEvent<BrainArchiveProgress>) => void) | null = null;

vi.mock("../../lib/tauri", () => ({
  tauriInvoke: (...args: unknown[]) => invokeMock(...args),
  tauriListen: vi.fn(async (event: string, handler: (event: TauriEvent<BrainArchiveProgress>) => void) => {
    if (event === "brain-archive-upload-progress") {
      progressHandler = handler;
    }
    return () => {
      progressHandler = null;
    };
  }),
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
    brain_sync_enabled: false,
    brain_sync_url: "https://admin.my2brain.ru/api/v1/meetings/upload",
    show_minitray_overlay: false,
    ...overrides,
  };
}

function renderComponent(settings = baseSettings(), setSettings = vi.fn()) {
  return render(
    <BrainSyncSettings
      settings={settings}
      setSettings={setSettings}
      isDirty={() => false}
    />,
  );
}

describe("BrainSyncSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "brain_sync_has_token") return false;
      if (cmd === "brain_sync_upload_archive") {
        return { total: 0, uploaded: 0, skipped: 0, failed: 0, errors: [] };
      }
      return undefined;
    });
    progressHandler = null;
  });

  it("keeps URL and token controls enabled when auto-upload checkbox is off", async () => {
    renderComponent(baseSettings({ brain_sync_enabled: false }));

    expect(screen.getByLabelText("URL загрузки в Brain")).toBeEnabled();
    expect(screen.getByLabelText("Персональный токен Brain")).toBeEnabled();
    expect(await screen.findByText("Токен не сохранён")).toBeInTheDocument();
  });

  it("enables URL and token controls when master checkbox is on", async () => {
    renderComponent(baseSettings({ brain_sync_enabled: true }));

    expect(screen.getByLabelText("URL загрузки в Brain")).toBeEnabled();
    expect(screen.getByLabelText("Персональный токен Brain")).toBeEnabled();
    expect(await screen.findByText("Токен не сохранён")).toBeInTheDocument();
  });

  it("saves trimmed token and clears the token input", async () => {
    renderComponent(baseSettings({ brain_sync_enabled: true }));

    const tokenInput = screen.getByLabelText("Персональный токен Brain");
    fireEvent.change(tokenInput, { target: { value: "  brain-token  " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить токен" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("brain_sync_set_token", { token: "brain-token" });
    });
    expect(tokenInput).toHaveValue("");
    expect(screen.getByText("Токен сохранён")).toBeInTheDocument();
  });

  it("clears token and updates token state", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "brain_sync_has_token") return true;
      return undefined;
    });
    renderComponent(baseSettings({ brain_sync_enabled: true }));
    expect(await screen.findByText("Токен сохранён")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Очистить токен" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("brain_sync_clear_token");
    });
    expect(screen.getByText("Токен не сохранён")).toBeInTheDocument();
  });

  it("uploads archive when URL is valid and token is saved even if auto-upload is off", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "brain_sync_has_token") return true;
      if (cmd === "brain_sync_upload_archive") {
        return { total: 3, uploaded: 2, skipped: 1, failed: 0, errors: [] };
      }
      return undefined;
    });
    renderComponent(baseSettings({ brain_sync_enabled: false }));

    const button = await screen.findByRole("button", { name: "Загрузить архивные записи" });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("brain_sync_upload_archive");
    });
    expect(await screen.findByText(/Готово: всего 3, загружено 2, пропущено 1, ошибок 0/)).toBeInTheDocument();
  });

  it("disables archive button when token is not saved", async () => {
    renderComponent(baseSettings({ brain_sync_url: "https://brain.example.test/upload" }));

    const button = await screen.findByRole("button", { name: "Загрузить архивные записи" });

    expect(button).toBeDisabled();
  });

  it("disables archive button when URL is invalid", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "brain_sync_has_token") return true;
      return undefined;
    });
    renderComponent(baseSettings({ brain_sync_url: "not-a-url" }));

    const button = await screen.findByRole("button", { name: "Загрузить архивные записи" });

    expect(button).toBeDisabled();
  });

  it("updates archive progress from progress events", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "brain_sync_has_token") return true;
      if (cmd === "brain_sync_upload_archive") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { total: 4, uploaded: 1, skipped: 2, failed: 1, errors: ["one failed"] };
      }
      return undefined;
    });
    renderComponent(baseSettings());
    await screen.findByText("Токен сохранён");
    await waitFor(() => expect(progressHandler).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Загрузить архивные записи" }));
    act(() => {
      progressHandler?.({
        payload: {
          total: 4,
          processed: 2,
          uploaded: 1,
          skipped: 1,
          failed: 0,
          current_session_id: "s2",
          current_title: "Встреча",
          errors: [],
        },
      });
    });

    expect(screen.getByText(/Обработано 2 \/ 4/)).toBeInTheDocument();
    expect(screen.getByText(/Загружено 1 · Пропущено 1 · Ошибок 0/)).toBeInTheDocument();
    expect(screen.getByText(/Встреча/)).toBeInTheDocument();
  });

  it("disables archive button while upload is running", async () => {
    let resolveUpload: (value: unknown) => void = () => undefined;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "brain_sync_has_token") return true;
      if (cmd === "brain_sync_upload_archive") {
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      }
      return undefined;
    });
    renderComponent(baseSettings());
    const button = await screen.findByRole("button", { name: "Загрузить архивные записи" });

    fireEvent.click(button);

    expect(button).toBeDisabled();
    resolveUpload({ total: 0, uploaded: 0, skipped: 0, failed: 0, errors: [] });
    await waitFor(() => expect(button).toBeEnabled());
  });
});
