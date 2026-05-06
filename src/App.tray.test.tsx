import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type InvokeMock = (cmd: string, args?: unknown) => Promise<unknown>;

function getAntdSelect(label: string) {
  const combobox = screen.getByRole("combobox", { name: label });
  const select = combobox.closest(".ant-select");
  expect(select).not.toBeNull();
  return { combobox, select: select as HTMLElement };
}

async function selectAntdOption(label: string, optionName: string) {
  const { combobox, select } = getAntdSelect(label);
  const selector = (select.querySelector(".ant-select-selector") as HTMLElement | null) ?? select;
  fireEvent.mouseDown(selector);
  await waitFor(() => {
    expect(combobox).toHaveAttribute("aria-expanded", "true");
  });
  const option = await waitFor(() => {
    const activeDropdown = Array.from(document.body.querySelectorAll<HTMLElement>(".ant-select-dropdown")).find(
      (dropdown) => !dropdown.classList.contains("ant-select-dropdown-hidden")
    );
    expect(activeDropdown).toBeDefined();
    const activeOption = Array.from(
      activeDropdown?.querySelectorAll<HTMLElement>(".ant-select-item-option") ?? []
    ).find((element) => element.textContent?.includes(optionName));
    expect(activeOption).toBeDefined();
    return activeOption as HTMLElement;
  });
  fireEvent.click(option);
  fireEvent.keyDown(combobox, { key: "Escape", code: "Escape" });
  fireEvent.blur(combobox);
  await waitFor(() => {
    expect(select.querySelector(".ant-select-selection-item")).toHaveTextContent(optionName);
  });
}

async function defaultInvokeImplementation(cmd: string, _args?: unknown): Promise<unknown> {
  if (cmd === "get_ui_sync_state") {
    return { source: "slack", topic: "", is_recording: false, active_session_id: null };
  }
  if (cmd === "set_ui_sync_state") {
    return "updated";
  }
  if (cmd === "start_recording") {
    return { session_id: "tray-session", session_dir: "/tmp/tray-session", status: "recording" };
  }
  if (cmd === "stop_recording") {
    return "recorded";
  }
  if (cmd === "list_sessions") {
    return [];
  }
  if (cmd === "get_settings") {
    return {
      recording_root: "./recordings",
      artifact_open_app: "",
      transcription_url: "",
      transcription_task: "transcribe",
      transcription_diarization_setting: "general",
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
    };
  }
  if (cmd === "list_audio_input_devices") {
    return ["Built-in Microphone", "BlackHole 2ch"];
  }
  if (cmd === "save_public_settings") {
    return null;
  }
  if (cmd === "get_live_input_levels") {
    return { mic: 0.42, system: 0.73 };
  }
  return null;
}

const { listeners, invokeMock } = vi.hoisted(() => ({
  listeners: new Map<string, Array<(payload?: unknown) => void | Promise<void>>>(),
  invokeMock: vi.fn<InvokeMock>(defaultInvokeImplementation),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async (event: string, handler: (payload?: unknown) => void | Promise<void>) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(handler);
    return () => {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "tray", hide: vi.fn() }),
}));

import { App } from "./App";

function getTraySourceSelect() {
  const select = screen.getByRole("combobox", { name: "Source" }) as HTMLSelectElement;
  expect(select).not.toBeNull();
  return { combobox: select, select };
}

function expectTraySourceValue(value: string) {
  expect(getTraySourceSelect().select.value).toBe(value);
}

describe("Tray window", () => {
  afterEach(() => {
    listeners.clear();
    invokeMock.mockClear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(defaultInvokeImplementation);
    vi.useRealTimers();
  });

  it("applies shared ui sync updates", async () => {
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
      expect(listeners.has("ui:sync")).toBe(true);
      expect(listeners.has("ui:recording")).toBe(true);
    });

    await act(async () => {
      const handlers = listeners.get("ui:sync") ?? [];
      await Promise.all(handlers.map((h) => h({ payload: JSON.stringify({ source: "facetime", topic: "1:1" }) })));
    });

    await waitFor(() => {
      expectTraySourceValue("facetime");
      expect(screen.getByLabelText("Topic (optional)")).toHaveValue("1:1");
    });
  });

  it("does not subscribe tray window to global tray start and stop commands", async () => {
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
      expect(listeners.has("ui:sync")).toBe(true);
      expect(listeners.has("ui:recording")).toBe(true);
    });

    expect(listeners.has("tray:start")).toBe(false);
    expect(listeners.has("tray:stop")).toBe(false);
  });

  it("renders mini recorder and starts with optional topic", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByText("Recorder")).not.toBeInTheDocument();
    const sourceField = getTraySourceSelect().combobox;
    const topicField = screen.getByLabelText("Topic (optional)");
    expect(sourceField).toBeInTheDocument();
    expect(topicField).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rec" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();

    await user.type(topicField, "Daily sync");
    await user.click(screen.getByRole("button", { name: "Rec" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_recording", {
        payload: {
          source: "slack",
          tags: [],
          notes: "",
          topic: "Daily sync",
        },
      });
    });
  });

  it("keeps source/topic and tray actions in single rows and shows the pending-review system message", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        return { kind: "denied", can_request: false };
      }
      return defaultInvokeImplementation(cmd);
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<App />));
    });

    const sourceField = getTraySourceSelect().combobox;
    const topicField = screen.getByLabelText("Topic (optional)");

    await waitFor(() => {
      expect(sourceField).toBeInTheDocument();
      expect(topicField).toBeInTheDocument();

      expect(screen.getByRole("button", { name: "Rec" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
      expect(screen.getByText("Grant Screen & System Audio Recording permission in System Settings.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
      expect(screen.queryByLabelText("System activity")).not.toBeInTheDocument();
    });
  });

  it("saves topic edits to active tray recording session", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Rec" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_recording", {
        payload: {
          source: "slack",
          tags: [],
          notes: "",
          topic: "",
        },
      });
    });

    await user.type(screen.getByLabelText("Topic (optional)"), "Daily sync");

    await waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith("update_session_details", {
          payload: {
            session_id: "tray-session",
            source: "slack",
            notes: "",
            topic: "Daily sync",
            tags: [],
            num_speakers: null,
          },
        });
      },
      { timeout: 3000 }
    );
  });

  it("shows a neutral loading status without legacy system controls while macOS permission loads", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") {
        return {
          recording_root: "./recordings",
          artifact_open_app: "",
          transcription_url: "",
          transcription_task: "transcribe",
          transcription_diarization_setting: "general",
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
        };
      }
      if (cmd === "get_macos_system_audio_permission_status") {
        return new Promise(() => undefined);
      }
      return defaultInvokeImplementation(cmd);
    });

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByText("Checking macOS system audio status")).toBeInTheDocument();
    expect(screen.queryByLabelText("System activity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("System level")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("System device")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).not.toBeInTheDocument();
  });

  it("shows a permission status error without legacy system controls when the macOS lookup fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") {
        return {
          recording_root: "./recordings",
          artifact_open_app: "",
          transcription_url: "",
          transcription_task: "transcribe",
          transcription_diarization_setting: "general",
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
        };
      }
      if (cmd === "get_macos_system_audio_permission_status") {
        throw new Error("lookup failed");
      }
      return defaultInvokeImplementation(cmd);
    });

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByText("Could not load macOS system audio status. Open System Settings to review the permission.")
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("System activity")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("System level")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("System device")).not.toBeInTheDocument();
  });

  it("shows an Open System Settings link when macOS system audio permission is missing", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        return { kind: "denied", can_request: false };
      }
      return defaultInvokeImplementation(cmd);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Open System Settings" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_macos_system_audio_settings");
    });
  });

  it("keeps the settings link hidden when tray recording fails but permission state is granted", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_macos_system_audio_permission_status") {
        return { kind: "granted", can_request: false };
      }
      if (cmd === "start_recording") {
        throw new Error("Screen & System Audio Recording permission is required");
      }
      return defaultInvokeImplementation(cmd);
    });

    render(<App />);

    await user.click(screen.getByRole("button", { name: "Rec" }));

    await waitFor(() => {
      expect(screen.getByText("Status: ошибка: требуется разрешение на запись экрана и системного аудио")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open System Settings" })).not.toBeInTheDocument();
    });
  });

  it("shows native macOS system audio status without legacy system controls when permission is available", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") {
        return {
          recording_root: "./recordings",
          artifact_open_app: "",
          transcription_url: "",
          transcription_task: "transcribe",
          transcription_diarization_setting: "general",
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
        };
      }
      if (cmd === "get_macos_system_audio_permission_status") {
        return { kind: "granted", can_request: false };
      }
      return defaultInvokeImplementation(cmd);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText("Mic activity")).toBeInTheDocument();
      expect(screen.getByLabelText("System activity")).toBeInTheDocument();
    });

    expect(screen.queryByText("System audio is captured natively by macOS.")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("System level")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "System device" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Mic device" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).not.toBeInTheDocument();
  });

  it("renders tray audio activity rows and mute controls instead of level bars", async () => {
    render(<App />);

    expect(screen.getByText("Mic")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText("Mic activity")).toBeInTheDocument();
      expect(screen.getByLabelText("System activity")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Mic level")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("System level")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mute system audio" })).toBeDisabled();
    expect(screen.getByLabelText("Mic activity").querySelector("[data-wave-mode]")).toHaveAttribute(
      "data-wave-mode",
      "gentle"
    );
    expect(screen.getByLabelText("System activity").querySelector("[data-wave-mode]")).toHaveAttribute(
      "data-wave-mode",
      "strong"
    );
  });

  it("keeps a flat equalizer line when no audio is present", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_live_input_levels") {
        return { mic: 0, system: 0 };
      }
      return defaultInvokeImplementation(cmd, args);
    });

    render(<App />);

    const micVisual = await screen.findByLabelText("Mic activity");
    const micWaveContainer = micVisual.querySelector("[data-wave-mode]");
    const micPath = micVisual.querySelector("[data-testid='wave-path']");

    expect(micWaveContainer).not.toBeNull();
    expect(micWaveContainer).toHaveAttribute("data-wave-mode", "flat");
    expect(micPath).toHaveAttribute("d", "M 0.00 14.00 L 120.00 14.00");
  });

  it("shows audio device selectors near live levels and saves selected devices", async () => {
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
      expect(invokeMock).toHaveBeenCalledWith("list_audio_input_devices");
    });

    const micSelect = screen.getByRole("combobox", { name: "Mic device" }) as HTMLSelectElement;
    const systemSelect = screen.getByRole("combobox", { name: "System device" }) as HTMLSelectElement;
    expect(micSelect).toBeInTheDocument();
    expect(systemSelect).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(micSelect, "Built-in Microphone");
    await user.selectOptions(systemSelect, "BlackHole 2ch");

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_public_settings",
        expect.objectContaining({
          payload: expect.objectContaining({
            mic_device_name: "Built-in Microphone",
            system_device_name: "BlackHole 2ch",
          }),
        })
      );
    });
  });

  it("keeps the mic selector inline with the tray audio visual and mute control", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText("Mic activity")).toBeInTheDocument();
    });

    const micLabel = screen.getByText("Mic");
    const micMute = screen.getByRole("button", { name: "Mute microphone" });
    const micSelect = screen.getByRole("combobox", { name: "Mic device" });

    // All mic controls should share a common ancestor row
    const micRowAncestor = micLabel.parentElement;
    expect(micRowAncestor).not.toBeNull();
    expect(micRowAncestor!.contains(micMute)).toBe(true);
    expect(micRowAncestor!.contains(micSelect)).toBe(true);
    expect(micRowAncestor!.contains(screen.getByLabelText("Mic activity"))).toBe(true);
  });

  it("toggles tray mute buttons during recording and resets them after stop", async () => {
    const user = userEvent.setup();
    let muteState = { micMuted: false, systemMuted: false };

    invokeMock.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "set_recording_input_muted") {
        muteState =
          args?.channel === "mic"
            ? { ...muteState, micMuted: args.muted }
            : { ...muteState, systemMuted: args.muted };
        return muteState;
      }
      return defaultInvokeImplementation(cmd, args);
    });

    render(<App />);

    await user.click(screen.getByRole("button", { name: "Rec" }));
    await screen.findByRole("button", { name: "Mute microphone" });
    await user.click(await screen.findByRole("button", { name: "Mute microphone" }));

    expect(invokeMock).toHaveBeenCalledWith("set_recording_input_muted", {
      sessionId: "tray-session",
      channel: "mic",
      muted: true,
    });
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Mute microphone" })).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("keeps tray recording controls active when mute rpc fails", async () => {
    const user = userEvent.setup();

    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "set_recording_input_muted") {
        throw new Error("mute failed");
      }
      return defaultInvokeImplementation(cmd, args);
    });

    render(<App />);

    await user.click(screen.getByRole("button", { name: "Rec" }));
    await user.click(await screen.findByRole("button", { name: "Mute microphone" }));

    await waitFor(() => {
      expect(screen.getByText("Mute update failed: mute failed")).toBeInTheDocument();
    });

    expect(screen.getByText("Status: идет запись")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rec" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toHaveAttribute("aria-pressed", "false");
  });
});
