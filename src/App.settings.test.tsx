import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type InvokeMock = (cmd: string, args?: unknown) => Promise<unknown>;

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<InvokeMock>(async (cmd: string, _args?: unknown) => {
    if (cmd === "get_settings") {
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
      };
    }
    if (cmd === "detect_system_source_device") {
      return "BlackHole 2ch";
    }
    if (cmd === "list_audio_input_devices") {
      return ["Built-in Microphone", "BlackHole 2ch"];
    }
    if (cmd === "list_text_editor_apps") {
      return {
        apps: [
          { id: "textedit", name: "TextEdit", icon_fallback: "📝", icon_data_url: null },
          { id: "visual_studio_code", name: "Visual Studio Code", icon_fallback: "💠", icon_data_url: null },
        ],
        default_app_id: "textedit",
      };
    }
    if (cmd === "pick_recording_root") {
      return "/Users/test/BigEcho Recordings";
    }
    return null;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "settings" }),
}));

import { App } from "./App";

function getAntdSelect(label: string) {
  const combobox = screen.getByRole("combobox", { name: label });
  const select = combobox.closest(".ant-select");
  expect(select).not.toBeNull();
  return { combobox, select: select as HTMLElement };
}

async function selectAntdOption(_user: ReturnType<typeof userEvent.setup>, label: string, optionName: string) {
  const { combobox, select } = getAntdSelect(label);
  const selector = (select.querySelector(".ant-select-selector") as HTMLElement | null) ?? select;
  fireEvent.mouseDown(selector);
  await waitFor(() => {
    expect(combobox).toHaveAttribute("aria-expanded", "true");
  });
  const optionTexts = await screen.findAllByText(optionName);
  const optionText = optionTexts.find((element) => element.closest(".ant-select-item-option"));
  const option = (optionText?.closest(".ant-select-item-option") as HTMLElement | null) ?? null;
  expect(option).not.toBeNull();
  fireEvent.click(option as HTMLElement);
  await waitFor(() => {
    expectAntdSelectValue(label, optionName);
  });
  fireEvent.keyDown(combobox, { key: "Escape", code: "Escape" });
}

async function openAntdSelect(label: string) {
  const { combobox, select } = getAntdSelect(label);
  const selector = (select.querySelector(".ant-select-selector") as HTMLElement | null) ?? select;
  fireEvent.mouseDown(selector);
  await waitFor(() => {
    expect(combobox).toHaveAttribute("aria-expanded", "true");
  });
}

function expectAntdSelectValue(label: string, value: string) {
  const { select } = getAntdSelect(label);
  expect(select.querySelector(".ant-select-selection-item")).toHaveTextContent(value);
}

function mockSettings() {
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
  };
}

describe("App settings window", () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it("loads settings and auto-detects system source", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await user.click(await screen.findByRole("tab", { name: "Audio" }));
    await user.click(screen.getByRole("button", { name: "Auto-detect system source" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("detect_system_source_device");
    });

    const input = screen.getByDisplayValue("BlackHole 2ch");
    expect(input).toBeInTheDocument();
  });

  it("shows a pending macOS permission state before lookup resolves", async () => {
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_settings") {
        return mockSettings();
      }
      return null;
    });
    invokeMock.mockImplementationOnce(
      () =>
        new Promise(() => {
          // keep the permission lookup pending for this assertion
        })
    );

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_macos_system_audio_permission_status");
    });

    await user.click(await screen.findByRole("tab", { name: "Audio" }));

    expect(screen.getByText(/checking macos permission status/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("System source device name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto-detect system source" })).not.toBeInTheDocument();
  });

  it("keeps legacy system source controls when macOS permission status is unsupported", async () => {
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_settings") {
        return mockSettings();
      }
      return null;
    });
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        return { kind: "unsupported", can_request: false };
      }
      return null;
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_macos_system_audio_permission_status");
    });

    await user.click(await screen.findByRole("tab", { name: "Audio" }));

    expect(screen.getByLabelText("System source device name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auto-detect system source" })).toBeInTheDocument();
    expect(screen.queryByText(/system audio is captured natively/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).not.toBeInTheDocument();
  });

  it("shows the native macOS permission card when system audio permission is not granted", async () => {
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_settings") {
        return mockSettings();
      }
      return null;
    });
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        return { kind: "denied", can_request: false };
      }
      return null;
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_macos_system_audio_permission_status");
    });

    await user.click(await screen.findByRole("tab", { name: "Audio" }));

    expect(screen.getByText(/system audio is captured natively/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(invokeMock).toHaveBeenCalledWith("open_macos_system_audio_settings");
    expect(screen.queryByLabelText("System source device name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto-detect system source" })).not.toBeInTheDocument();
  });

  it("shows native macOS permission UI when permission lookup fails", async () => {
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_settings") {
        return mockSettings();
      }
      return null;
    });
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        throw new Error("bridge unavailable");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_macos_system_audio_permission_status");
    });

    await user.click(await screen.findByRole("tab", { name: "Audio" }));

    expect(screen.getByText(/could not load permission status/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
    expect(screen.queryByLabelText("System source device name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto-detect system source" })).not.toBeInTheDocument();
  });

  it("shows a granted macOS permission state without the permission-required guidance", async () => {
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_settings") {
        return mockSettings();
      }
      return null;
    });
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        return { kind: "granted", can_request: false };
      }
      return null;
    });

    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_macos_system_audio_permission_status");
    });

    await user.click(await screen.findByRole("tab", { name: "Audio" }));

    expect(screen.getByText(/permission granted/i)).toBeInTheDocument();
    expect(screen.queryByText(/grant screen & system audio recording permission/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).not.toBeInTheDocument();
  });

  it("disables saving when settings are invalid", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    const saveButton = screen.getByRole("button", { name: "Save settings" });
    expect(saveButton).toBeEnabled();

    await user.clear(screen.getByLabelText("Transcription URL"));
    await user.type(screen.getByLabelText("Transcription URL"), "not-url");

    expect(screen.getByText("Неверный URL транскрибации")).toBeInTheDocument();
    expect(saveButton).toBeDisabled();

    await user.clear(screen.getByLabelText("Transcription URL"));
    await user.type(screen.getByLabelText("Transcription URL"), "https://example.com/transcribe");

    expect(screen.queryByText("Неверный URL транскрибации")).not.toBeInTheDocument();
    expect(saveButton).toBeEnabled();
  });

  it("treats non-http urls as invalid", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    const saveButton = screen.getByRole("button", { name: "Save settings" });
    await user.clear(screen.getByLabelText("Transcription URL"));
    await user.type(screen.getByLabelText("Transcription URL"), "file:///tmp/transcribe");

    expect(screen.getByText("Неверный URL транскрибации")).toBeInTheDocument();
    expect(saveButton).toBeDisabled();
  });

  it("saves settings and api keys", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    const keyInputs = screen.getAllByPlaceholderText("Stored in OS secure storage");
    await selectAntdOption(user, "Task", "diarize");
    await selectAntdOption(user, "Diarization setting", "meeting");
    await user.type(screen.getByLabelText("Summary prompt"), "Сделай саммари блоками: решения, риски, action items");
    await user.type(keyInputs[0], "nexara-secret");
    await user.type(keyInputs[1], "openai-secret");

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_public_settings", expect.any(Object));
      expect(invokeMock).toHaveBeenCalledWith("save_public_settings", {
        payload: expect.objectContaining({
          transcription_task: "diarize",
          transcription_diarization_setting: "meeting",
          summary_prompt: "Сделай саммари блоками: решения, риски, action items",
        }),
      });
      expect(invokeMock).toHaveBeenCalledWith("set_api_secret", {
        name: "NEXARA_API_KEY",
        value: "nexara-secret",
      });
      expect(invokeMock).toHaveBeenCalledWith("set_api_secret", {
        name: "OPENAI_API_KEY",
        value: "openai-secret",
      });
    });

    expect(screen.getByText("Nexara API key: обновлён")).toBeInTheDocument();
    expect(screen.getByText("OpenAI API key: обновлён")).toBeInTheDocument();
  });

  it("switches to SalutSpeechAPI fields and saves SalutSpeech auth key", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await selectAntdOption(user, "Transcription provider", "SalutSpeechAPI");
    await selectAntdOption(user, "Scope", "SALUTE_SPEECH_B2B");
    await selectAntdOption(user, "Recognition model", "general");
    await user.clear(screen.getByLabelText("Language"));
    await user.type(screen.getByLabelText("Language"), "ru-RU");
    await user.clear(screen.getByLabelText("Sample rate"));
    await user.type(screen.getByLabelText("Sample rate"), "48000");
    await user.clear(screen.getByLabelText("Channels count"));
    await user.type(screen.getByLabelText("Channels count"), "1");
    await user.type(screen.getByLabelText("SalutSpeech authorization key"), "salute-auth-key");

    expect(screen.queryByLabelText("Nexara API key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_public_settings", {
        payload: expect.objectContaining({
          transcription_provider: "salute_speech",
          salute_speech_scope: "SALUTE_SPEECH_B2B",
          salute_speech_model: "general",
          salute_speech_language: "ru-RU",
          salute_speech_sample_rate: 48000,
          salute_speech_channels_count: 1,
        }),
      });
      expect(invokeMock).toHaveBeenCalledWith("set_api_secret", {
        name: "SALUTE_SPEECH_AUTH_KEY",
        value: "salute-auth-key",
      });
    });

    expect(screen.getByText("SalutSpeech authorization key: обновлён")).toBeInTheDocument();
  });

  it("renders SalutSpeech scope and model as selects with documented options", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await selectAntdOption(user, "Transcription provider", "SalutSpeechAPI");

    expect(getAntdSelect("Scope").select).toHaveClass("ant-select");
    expect(getAntdSelect("Recognition model").select).toHaveClass("ant-select");

    await openAntdSelect("Scope");
    expect(await screen.findByRole("option", { name: "SALUTE_SPEECH_PERS" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "SALUTE_SPEECH_CORP" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "SALUTE_SPEECH_B2B" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "SBER_SPEECH" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await openAntdSelect("Recognition model");
    expect(await screen.findByRole("option", { name: "general" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "callcenter" })).toBeInTheDocument();
  });

  it("saves auto pipeline setting", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await user.click(screen.getByRole("tab", { name: "Generals" }));
    const checkbox = screen.getByRole("checkbox", { name: "Auto-run pipeline on Stop" });
    const apiLoggingCheckbox = screen.getByRole("checkbox", { name: "Enable API call logging" });
    expect(checkbox).not.toBeChecked();
    expect(apiLoggingCheckbox).not.toBeChecked();
    await user.click(checkbox);
    await user.click(apiLoggingCheckbox);
    expect(checkbox).toBeChecked();
    expect(apiLoggingCheckbox).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_public_settings", {
        payload: expect.objectContaining({
          auto_run_pipeline_on_stop: true,
          api_call_logging_enabled: true,
        }),
      });
    });
  });

  it("saves selected audio format from audio tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await user.click(screen.getByRole("tab", { name: "Audio" }));
    await selectAntdOption(user, "Audio format", "mp3");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_public_settings", {
        payload: expect.objectContaining({
          audio_format: "mp3",
        }),
      });
    });
  });

  it("saves artifact opener app from generals tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await user.click(screen.getByRole("tab", { name: "Generals" }));
    await waitFor(() => {
      expectAntdSelectValue("Artifact opener app (optional)", "TextEdit");
    });
    await selectAntdOption(user, "Artifact opener app (optional)", "Visual Studio Code");
    expectAntdSelectValue("Artifact opener app (optional)", "Visual Studio Code");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_public_settings", {
        payload: expect.objectContaining({
          artifact_open_app: "visual_studio_code",
        }),
      });
    });
  });

  it("shows selected artifact opener option and closes the popup", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await user.click(screen.getByRole("tab", { name: "Generals" }));
    await waitFor(() => {
      expectAntdSelectValue("Artifact opener app (optional)", "TextEdit");
    });
    const { combobox } = getAntdSelect("Artifact opener app (optional)");
    await openAntdSelect("Artifact opener app (optional)");

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();

    const textEditOption = screen.getByRole("option", { name: "TextEdit" });
    expect(textEditOption).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("option", { name: "Visual Studio Code" }));

    await waitFor(() => {
      expect(combobox).toHaveAttribute("aria-expanded", "false");
    });
    expectAntdSelectValue("Artifact opener app (optional)", "Visual Studio Code");
  });

  it("closes the artifact opener popup when focus tabs away", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await user.click(screen.getByRole("tab", { name: "Generals" }));
    await waitFor(() => {
      expectAntdSelectValue("Artifact opener app (optional)", "TextEdit");
    });
    await openAntdSelect("Artifact opener app (optional)");
    const { combobox } = getAntdSelect("Artifact opener app (optional)");

    await waitFor(() => {
      expect(combobox).toHaveAttribute("aria-expanded", "true");
    });

    fireEvent.blur(combobox, {
      relatedTarget: screen.getByRole("checkbox", { name: "Auto-run pipeline on Stop" }),
    });
    await waitFor(() => {
      expect(combobox).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("picks recording root folder and only saves it on Save settings", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await user.click(screen.getByRole("tab", { name: "Generals" }));
    const recordingRootInput = screen.getByLabelText("Recording root");
    expect(recordingRootInput).toHaveValue("./recordings");

    await user.click(screen.getByRole("button", { name: "Choose recording root folder" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("pick_recording_root");
    });

    expect(recordingRootInput).toHaveValue("/Users/test/BigEcho Recordings");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "save_public_settings",
      expect.objectContaining({
        payload: expect.objectContaining({
          recording_root: "/Users/test/BigEcho Recordings",
        }),
      })
    );

    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_public_settings", {
        payload: expect.objectContaining({
          recording_root: "/Users/test/BigEcho Recordings",
        }),
      });
    });
  });

  it("marks api keys as unchanged when they are empty", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_public_settings", expect.any(Object));
    });

    expect(screen.getByText("Nexara API key: не изменён")).toBeInTheDocument();
    expect(screen.getByText("OpenAI API key: не изменён")).toBeInTheDocument();
  });
});
