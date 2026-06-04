import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodoistSyncSettings } from "./TodoistSyncSettings";
import type { UseTodoistSyncReturn } from "../../hooks/useTodoistSync";
import type { PublicSettings } from "../../types";

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
    apple_speech_locale: "en-US",
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
    todoist_sync_enabled: false,
    todoist_auto_add: false,
    ...overrides,
  };
}

function makeTodoistSyncStub(
  overrides: Partial<UseTodoistSyncReturn> = {},
): UseTodoistSyncReturn {
  return {
    hasToken: false,
    tokenState: "unknown",
    refreshHasToken: vi.fn(async () => undefined),
    saveToken: vi.fn(async (_value: string) => true),
    clearToken: vi.fn(async () => true),
    ...overrides,
  };
}

describe("TodoistSyncSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables auto-add when sync is disabled or a token is missing", () => {
    const { rerender } = render(
      <TodoistSyncSettings
        settings={baseSettings({ todoist_sync_enabled: false, todoist_auto_add: false })}
        setSettings={() => undefined}
        isDirty={() => false}
        todoistSync={makeTodoistSyncStub({ hasToken: true })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /Auto-add action items/i })).toBeDisabled();

    rerender(
      <TodoistSyncSettings
        settings={baseSettings({ todoist_sync_enabled: true, todoist_auto_add: false })}
        setSettings={() => undefined}
        isDirty={() => false}
        todoistSync={makeTodoistSyncStub({ hasToken: false })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /Auto-add action items/i })).toBeDisabled();
  });

  it("allows auto-add when sync is enabled and a token exists", () => {
    const setSettings = vi.fn();

    render(
      <TodoistSyncSettings
        settings={baseSettings({ todoist_sync_enabled: true, todoist_auto_add: false })}
        setSettings={setSettings}
        isDirty={() => false}
        todoistSync={makeTodoistSyncStub({ hasToken: true })}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Auto-add action items/i }));

    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ todoist_auto_add: true }),
    );
  });

  it("resets auto-add when Todoist sync is disabled", () => {
    const setSettings = vi.fn();

    render(
      <TodoistSyncSettings
        settings={baseSettings({ todoist_sync_enabled: true, todoist_auto_add: true })}
        setSettings={setSettings}
        isDirty={() => false}
        todoistSync={makeTodoistSyncStub({ hasToken: true })}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Enable Todoist sync/i }));

    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        todoist_sync_enabled: false,
        todoist_auto_add: false,
      }),
    );
  });

  it("saves the token through the hook with trimmed input", async () => {
    const saveToken = vi.fn(async (_value: string) => undefined);

    render(
      <TodoistSyncSettings
        settings={baseSettings({ todoist_sync_enabled: true })}
        setSettings={() => undefined}
        isDirty={() => false}
        todoistSync={makeTodoistSyncStub({ saveToken })}
      />,
    );

    fireEvent.change(screen.getByLabelText(/API token/i), {
      target: { value: "  secret-token  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save token/i }));

    await waitFor(() => expect(saveToken).toHaveBeenCalledWith("secret-token"));
  });

  it("keeps token input when saving fails", async () => {
    const saveToken = vi.fn(async (_value: string) => false);

    render(
      <TodoistSyncSettings
        settings={baseSettings({ todoist_sync_enabled: true })}
        setSettings={() => undefined}
        isDirty={() => false}
        todoistSync={makeTodoistSyncStub({ saveToken, tokenState: "error" })}
      />,
    );

    const input = screen.getByLabelText(/API token/i);
    fireEvent.change(input, {
      target: { value: "retry-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save token/i }));

    await waitFor(() => expect(saveToken).toHaveBeenCalledWith("retry-token"));
    expect(input).toHaveValue("retry-token");
  });

  it("clears the token through the hook", async () => {
    const clearToken = vi.fn(async () => undefined);

    render(
      <TodoistSyncSettings
        settings={baseSettings({ todoist_sync_enabled: true })}
        setSettings={() => undefined}
        isDirty={() => false}
        todoistSync={makeTodoistSyncStub({ hasToken: true, clearToken })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Clear token/i }));

    await waitFor(() => expect(clearToken).toHaveBeenCalled());
  });

  it("resets auto-add after clearing a saved token", async () => {
    const clearToken = vi.fn(async () => true);
    const setSettings = vi.fn();

    render(
      <TodoistSyncSettings
        settings={baseSettings({ todoist_sync_enabled: true, todoist_auto_add: true })}
        setSettings={setSettings}
        isDirty={() => false}
        todoistSync={makeTodoistSyncStub({ hasToken: true, clearToken })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Clear token/i }));

    await waitFor(() => expect(clearToken).toHaveBeenCalled());
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ todoist_auto_add: false }),
    );
  });
});
