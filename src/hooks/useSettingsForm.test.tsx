import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

function mockPublicSettings() {
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
  };
}

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (cmd: string, args?: unknown) => {
    if (cmd === "get_settings") {
      return mockPublicSettings();
    }
    if (cmd === "set_api_secret") {
      return null;
    }
    if (cmd === "save_public_settings") {
      return null;
    }
    if (cmd === "list_audio_input_devices") {
      return ["Built-in Microphone"];
    }
    if (cmd === "get_macos_system_audio_permission_status") {
      return { kind: "not_determined", can_request: true };
    }
    if (cmd === "detect_system_source_device") {
      return "BlackHole 2ch";
    }
    return args ?? null;
  }),
}));

vi.mock("../lib/tauri", () => ({
  tauriInvoke: invokeMock,
}));

import { useSettingsForm } from "./useSettingsForm";

describe("useSettingsForm", () => {
  it("loads settings and saves api keys through the tauri adapter", async () => {
    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSettingsForm({ isTrayWindow: false, setStatus })
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
      expect(result.current.settings?.openai_model).toBe("gpt-4.1-mini");
    });

    act(() => {
      result.current.setNexaraKey("nexara-secret");
    });

    await act(async () => {
      await result.current.saveApiKeys();
    });

    expect(invokeMock).toHaveBeenCalledWith("set_api_secret", {
      name: "NEXARA_API_KEY",
      value: "nexara-secret",
    });
  });

  it("loads macOS system audio permission status through the tauri adapter", async () => {
    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSettingsForm({ isTrayWindow: false, setStatus })
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_macos_system_audio_permission_status");
      expect(result.current.macosSystemAudioPermission).toEqual({
        kind: "not_determined",
        can_request: true,
      });
    });
  });

  it("falls back when macOS permission loading fails", async () => {
    const setStatus = vi.fn();
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_settings") {
        return mockPublicSettings();
      }
      return null;
    });
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        throw new Error("bridge unavailable");
      }
      return null;
    });

    const { result } = renderHook(() =>
      useSettingsForm({ isTrayWindow: false, setStatus })
    );

    await waitFor(() => {
      expect(result.current.macosSystemAudioPermissionLoadState).toBe("error");
      expect(result.current.macosSystemAudioPermission).toBeNull();
    });

    expect(setStatus).toHaveBeenCalledWith(
      "error: не удалось загрузить статус разрешения macOS system audio"
    );
  });

  it("normalizes unknown macOS permission payloads to a safe fallback", async () => {
    const setStatus = vi.fn();
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_settings") {
        return mockPublicSettings();
      }
      return null;
    });
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        return { kind: "mystery", can_request: true };
      }
      return null;
    });

    const { result } = renderHook(() =>
      useSettingsForm({ isTrayWindow: false, setStatus })
    );

    await waitFor(() => {
      expect(result.current.macosSystemAudioPermission).toEqual({
        kind: "unsupported",
        can_request: false,
      });
    });
  });

  it("opens macOS system audio settings through the tauri adapter", async () => {
    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSettingsForm({ isTrayWindow: false, setStatus })
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await act(async () => {
      await result.current.openMacosSystemAudioSettings();
    });

    expect(invokeMock).toHaveBeenCalledWith("open_macos_system_audio_settings");
  });

  it("saves SalutSpeech authorization key through the tauri adapter", async () => {
    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useSettingsForm({ isTrayWindow: false, setStatus })
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    act(() => {
      result.current.setSalutSpeechAuthKey("salute-auth-key");
    });

    await act(async () => {
      await result.current.saveApiKeys();
    });

    expect(invokeMock).toHaveBeenCalledWith("set_api_secret", {
      name: "SALUTE_SPEECH_AUTH_KEY",
      value: "salute-auth-key",
    });
  });
});
