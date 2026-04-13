import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

type InvokeMock = (cmd: string, args?: unknown) => Promise<unknown>;

const { listeners, invokeMock } = vi.hoisted(() => ({
  listeners: new Map<string, (payload?: unknown) => void | Promise<void>>(),
  invokeMock: vi.fn<InvokeMock>(async (cmd: string, _args?: unknown) => {
    if (cmd === "get_ui_sync_state") {
      return { source: "slack", topic: "", is_recording: false, active_session_id: null };
    }
    if (cmd === "set_ui_sync_state") {
      return "updated";
    }
    if (cmd === "start_recording") {
      return { session_id: "s1", session_dir: "/tmp/s1", status: "recording" };
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
    return null;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (filePath: string) => `asset://${filePath}`,
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async (event: string, handler: (payload?: unknown) => void | Promise<void>) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", hide: vi.fn(async () => undefined) }),
}));

import { App } from "./App";

describe("App main window", () => {
  it("defers settings loading until the Settings tab opens", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "get_settings")).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Settings" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_settings");
    });
  });

  it("shows top-level Sessions and Settings tabs and loads sessions when Sessions opens", async () => {
    const user = userEvent.setup();
    render(<App />);

    const topTabs = screen.getByRole("tablist", { name: "Main sections" });
    expect(topTabs).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "false");

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");

    invokeMock.mockClear();

    await user.click(screen.getByRole("tab", { name: "Sessions" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });
  });

  it("renders the sessions empty state without a live status announcement", async () => {
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "New recordings will appear here with search, transcript, summary, and audio actions."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("syncs source/topic from shared ui events and uses it on tray start", async () => {
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_ui_sync_state");
      expect(listeners.has("ui:sync")).toBe(true);
      expect(listeners.has("ui:recording")).toBe(true);
      expect(listeners.has("tray:start")).toBe(true);
    });

    await act(async () => {
      await listeners.get("ui:sync")?.({
        payload: JSON.stringify({ source: "telegram", topic: "Q1 planning" }),
      });
    });

    await act(async () => {
      await listeners.get("tray:start")?.();
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_recording", {
        payload: {
          tags: ["telegram"],
          topic: "Q1 planning",
          participants: [],
        },
      });
    });
  });

  it("registers tray listeners and reacts to tray start/stop", async () => {
    render(<App />);

    expect(screen.getByRole("main")).toHaveClass("mac-window");
    expect(screen.getByRole("main")).toHaveClass("mac-content");
    await waitFor(() => {
      expect(screen.getByRole("tablist", { name: "Main sections" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Recording")).not.toBeInTheDocument();
    expect(screen.queryByText("При закрытии окно сворачивается в трей")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(listeners.has("tray:start")).toBe(true);
      expect(listeners.has("tray:stop")).toBe(true);
    });

    await act(async () => {
      await listeners.get("tray:start")?.();
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_recording", expect.any(Object));
    });

    await act(async () => {
      await listeners.get("tray:stop")?.();
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("stop_recording", expect.any(Object));
    });
  });

  it("starts recording from tray start event with default source", async () => {
    render(<App />);

    await waitFor(() => {
      expect(listeners.has("tray:start")).toBe(true);
    });

    await act(async () => {
      await listeners.get("tray:start")?.();
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_recording", {
        payload: {
          tags: ["slack"],
          topic: "",
          participants: [],
        },
      });
    });
  });

  it("autosaves session details after edit", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s2",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Initial topic",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/s2",
            audio_duration_hms: "01:02:03",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s2",
          source: "zoom",
          custom_tag: "alpha",
          custom_summary_prompt: "",
          topic: "Initial topic",
          participants: ["Alice"],
        };
      }
      if (cmd === "update_session_details") {
        return "updated";
      }
      if (cmd === "start_recording") {
        return { session_id: "s1", session_dir: "/tmp/s1", status: "recording" };
      }
      if (cmd === "stop_recording") {
        return "recorded";
      }
      return null;
    });

    render(<App />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_session_meta", { sessionId: "s2" });
    });
    expect(screen.getByText("01:02:03")).toBeInTheDocument();

    const editableTopic = screen.getByDisplayValue("Initial topic");
    await user.clear(editableTopic);
    await user.type(editableTopic, "Edited topic");

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("update_session_details", {
        payload: {
          session_id: "s2",
          source: "zoom",
          custom_tag: "alpha",
          custom_summary_prompt: "",
          topic: "Edited topic",
          participants: ["Alice"],
        },
      });
    }, { timeout: 3000 });
  });

  it("opens summary prompt dialog with system default and saves custom prompt on Ok", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
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
          summary_prompt: "Сделай саммари блоками: решения, риски, action items",
          openai_model: "gpt-4.1-mini",
          audio_format: "opus",
          opus_bitrate_kbps: 24,
          mic_device_name: "",
          system_device_name: "",
          auto_run_pipeline_on_stop: false,
          api_call_logging_enabled: false,
        };
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s-prompt",
            status: "recorded",
            primary_tag: "slack",
            topic: "Prompt session",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T12:30:00+03:00",
            session_dir: "/tmp/s-prompt",
            audio_duration_hms: "00:20:00",
            has_transcript_text: true,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s-prompt",
          source: "slack",
          custom_tag: "",
          custom_summary_prompt: "",
          topic: "Prompt session",
          participants: [],
        };
      }
      if (cmd === "update_session_details") {
        return "updated";
      }
      return null;
    });

    render(<App />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_session_meta", { sessionId: "s-prompt" });
    });

    await user.click(screen.getByRole("button", { name: "Настроить промпт саммари" }));

    const dialog = await screen.findByRole("dialog", { name: "Промпт саммари" });
    const textarea = within(dialog).getByRole("textbox");
    expect(textarea).toHaveValue("Сделай саммари блоками: решения, риски, action items");

    await user.clear(textarea);
    await user.type(textarea, "Итог: решения, риски, следующие шаги");
    await user.click(within(dialog).getByRole("button", { name: "Ок" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("update_session_details", {
        payload: {
          session_id: "s-prompt",
          source: "slack",
          custom_tag: "",
          custom_summary_prompt: "Итог: решения, риски, следующие шаги",
          topic: "Prompt session",
          participants: [],
        },
      });
    });

    await user.click(screen.getByRole("button", { name: "Настроить промпт саммари" }));
    const reopenedDialog = await screen.findByRole("dialog", { name: "Промпт саммари" });
    expect(within(reopenedDialog).getByRole("textbox")).toHaveValue(
      "Итог: решения, риски, следующие шаги"
    );
  });

  it("shows audio format in session title meta instead of source", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s-format",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Format demo",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/s-format",
            audio_format: "wav",
            audio_duration_hms: "00:00:10",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s-format",
          source: "zoom",
          custom_tag: "",
          topic: "Format demo",
          participants: [],
        };
      }
      return null;
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("(wav) - 11.03.2026 10:00")).toBeInTheDocument();
    });
    expect(screen.queryByText("(zoom) - 11.03.2026")).not.toBeInTheDocument();
  });

  it("opens the session folder from a session card action", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s-folder",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Folder demo",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/s-folder",
            audio_duration_hms: "00:00:10",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s-folder",
          source: "zoom",
          custom_tag: "",
          topic: "Folder demo",
          participants: [],
        };
      }
      if (cmd === "open_session_folder") {
        return "opened";
      }
      return null;
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Folder demo")).toBeInTheDocument();
    });

    expect(screen.queryByText("открыть")).not.toBeInTheDocument();
    const folderButton = screen.getByRole("button", { name: "Открыть папку сессии" });
    expect(folderButton).toHaveClass("icon-button");
    expect(folderButton).toHaveClass("session-folder-link");
    await user.click(folderButton);

    expect(invokeMock).toHaveBeenCalledWith("open_session_folder", { sessionDir: "/tmp/s-folder" });
  });

  it("renders refresh sessions as an icon button in the sessions header", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    const refreshButton = screen.getByRole("button", { name: "Refresh sessions" });
    expect(refreshButton).toHaveClass("refresh-icon-button");
    expect(refreshButton).not.toHaveClass("icon-button");
    expect(refreshButton.textContent?.trim()).toBe("");

    await user.click(refreshButton);

    expect(refreshButton.querySelector("svg")).toHaveClass("refresh-icon-spin");
  });

  it("imports audio from the sessions header and reloads imported session as native", async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
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
      if (cmd === "list_sessions") {
        listCalls += 1;
        if (listCalls === 1) {
          return [];
        }
        return [
          {
            session_id: "s-imported",
            status: "recorded",
            primary_tag: "other",
            topic: "Voice memo",
            display_date_ru: "06.04.2026",
            started_at_iso: "2026-04-06T10:15:00+03:00",
            session_dir: "/tmp/recordings/other/06.04.2026/meeting_10-15-00",
            audio_file: "audio.m4a",
            audio_format: "m4a",
            audio_duration_hms: "00:01:42",
            has_transcript_text: false,
            has_summary_text: false,
            meta: {
              session_id: "s-imported",
              source: "other",
              custom_tag: "",
              topic: "Voice memo",
              participants: [],
            },
          },
        ];
      }
      if (cmd === "import_audio_session") {
        return {
          session_id: "s-imported",
          session_dir: "/tmp/recordings/other/06.04.2026/meeting_10-15-00",
          status: "recorded",
        };
      }
      return null;
    });

    render(<App />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    await user.click(screen.getByRole("button", { name: "Загрузить аудио" }));

    expect(invokeMock).toHaveBeenCalledWith("import_audio_session");
    await waitFor(() => {
      expect(screen.getByDisplayValue("Voice memo")).toBeInTheDocument();
      expect(screen.getByDisplayValue("other")).toBeInTheDocument();
    });
  });

  it("renders a search icon inside the session search input", async () => {
    const { container } = render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    const searchInput = screen.getByLabelText("Search sessions");
    const searchField = searchInput.closest(".session-toolbar-search");
    expect(searchField).not.toBeNull();
    expect(searchField?.querySelector(".session-search-icon svg")).not.toBeNull();
  });

  it("calls transcription command from Get text and keeps Get Summary disabled without text", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s3",
            status: "recorded",
            primary_tag: "slack",
            topic: "Retry me",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T11:00:00+03:00",
            session_dir: "/tmp/s3",
            audio_duration_hms: "00:15:20",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s3",
          source: "slack",
          custom_tag: "",
          topic: "Retry me",
          participants: [],
        };
      }
      if (cmd === "run_transcription") {
        expect(args).toEqual({ sessionId: "s3" });
        return "transcribed";
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_session_meta", { sessionId: "s3" });
    });

    const getTextButton = screen.getByRole("button", { name: "Get text" });
    const getSummaryButton = screen.getByRole("button", { name: "Get Summary" });
    expect(getTextButton).toBeEnabled();
    expect(getSummaryButton).toBeDisabled();
    await user.click(getTextButton);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("run_transcription", { sessionId: "s3" });
    });
  });

  it("opens a session context menu on right click and runs session actions", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
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
          summary_prompt: "Default summary prompt",
          openai_model: "gpt-4.1-mini",
          audio_format: "opus",
          opus_bitrate_kbps: 24,
          mic_device_name: "",
          system_device_name: "",
          auto_run_pipeline_on_stop: false,
          api_call_logging_enabled: false,
        };
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s-context",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Context menu session",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T11:00:00+03:00",
            session_dir: "/tmp/s-context",
            audio_duration_hms: "00:15:20",
            has_transcript_text: true,
            has_summary_text: true,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s-context",
          source: "zoom",
          custom_tag: "",
          custom_summary_prompt: "",
          topic: "Context menu session",
          participants: [],
        };
      }
      if (cmd === "open_session_folder") return "opened";
      if (cmd === "open_session_artifact") return "opened";
      if (cmd === "run_transcription") return "transcribed";
      if (cmd === "run_summary") return "summarized";
      return args ?? null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Context menu session" })).toBeInTheDocument();
    });

    const openMenu = () => {
      const card = screen.getByRole("heading", { name: "Context menu session" }).closest(".session-card");
      expect(card).not.toBeNull();
      fireEvent.contextMenu(card!, { clientX: 120, clientY: 160 });
      return screen.getByRole("menu", { name: "Действия сессии" });
    };

    let menu = openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Открыть папку сессии" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Открыть текст" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Открыть саммари" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Сгенерировать текст" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Сгенерировать саммари" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Настроить промпт саммари" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Удалить" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "Открыть папку сессии" }));
    expect(invokeMock).toHaveBeenCalledWith("open_session_folder", { sessionDir: "/tmp/s-context" });

    menu = openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Открыть текст" }));
    expect(invokeMock).toHaveBeenCalledWith("open_session_artifact", {
      sessionId: "s-context",
      artifactKind: "transcript",
    });

    menu = openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Открыть саммари" }));
    expect(invokeMock).toHaveBeenCalledWith("open_session_artifact", {
      sessionId: "s-context",
      artifactKind: "summary",
    });

    menu = openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Сгенерировать текст" }));
    expect(invokeMock).toHaveBeenCalledWith("run_transcription", { sessionId: "s-context" });

    await waitFor(() => {
      expect(screen.getByText("Text fetched successfully")).toBeInTheDocument();
    });

    menu = openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Сгенерировать саммари" }));
    expect(invokeMock).toHaveBeenCalledWith("run_summary", { sessionId: "s-context" });

    await waitFor(() => {
      expect(screen.getByText("Summary fetched successfully")).toBeInTheDocument();
    });

    menu = openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Настроить промпт саммари" }));
    expect(screen.getByRole("dialog", { name: "Промпт саммари" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Отмена" }));

    menu = openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Удалить" }));
    expect(screen.getByRole("dialog", { name: "Подтверждение удаления" })).toBeInTheDocument();
  });

  it("searches sessions by one query and highlights matched fields", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
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
        };
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s4",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Budget planning",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/project-alpha/s4",
            audio_duration_hms: "00:12:11",
            has_transcript_text: false,
            has_summary_text: false,
          },
          {
            session_id: "s5",
            status: "recorded",
            primary_tag: "slack",
            topic: "Roadmap",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T11:00:00+03:00",
            session_dir: "/tmp/project-beta/s5",
            audio_duration_hms: "00:10:09",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        if ((args as { sessionId?: string } | undefined)?.sessionId === "s5") {
          return {
            session_id: "s5",
            source: "slack",
            custom_tag: "project-beta",
            topic: "Roadmap",
            participants: ["Bob"],
          };
        }
        return {
          session_id: "s4",
          source: "zoom",
          custom_tag: "project-alpha",
          topic: "Budget planning",
          participants: ["Alice"],
        };
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByDisplayValue("project-alpha")).toBeInTheDocument();
      expect(screen.getByDisplayValue("project-beta")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Search sessions"), "project-alpha");

    expect(screen.getByDisplayValue("Budget planning")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Roadmap")).not.toBeInTheDocument();
    const matchedCustomTagInput = screen
      .getAllByDisplayValue("project-alpha")
      .find((element) => element.closest(".session-edit-grid"));
    expect(matchedCustomTagInput?.closest("label")).toHaveClass("match-hit");
  });

  it("searches sessions by transcript/summary text via global session search", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
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
        };
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s8",
            status: "done",
            primary_tag: "zoom",
            topic: "Product demo",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T10:00:00+03:00",
            session_dir: "/tmp/s8",
            audio_duration_hms: "00:08:10",
            has_transcript_text: true,
            has_summary_text: true,
          },
          {
            session_id: "s9",
            status: "done",
            primary_tag: "slack",
            topic: "Standup",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T11:00:00+03:00",
            session_dir: "/tmp/s9",
            audio_duration_hms: "00:09:05",
            has_transcript_text: true,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        if ((args as { sessionId?: string } | undefined)?.sessionId === "s9") {
          return {
            session_id: "s9",
            source: "slack",
            custom_tag: "",
            topic: "Standup",
            participants: [],
          };
        }
        return {
          session_id: "s8",
          source: "zoom",
          custom_tag: "",
          topic: "Product demo",
          participants: [],
        };
      }
      if (cmd === "search_session_artifacts") {
        if ((args as { query?: string } | undefined)?.query === "acme renewal risk") {
          return {
            s8: { transcript_match: true, summary_match: true },
          };
        }
        return {};
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByDisplayValue("Product demo")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Standup")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Search sessions"), "acme renewal risk");

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("search_session_artifacts", { query: "acme renewal risk" });
      expect(screen.getByDisplayValue("Product demo")).toBeInTheDocument();
      expect(screen.queryByDisplayValue("Standup")).not.toBeInTheDocument();
    });
  });

  it("opens matched artifact in inline viewer and highlights the search query", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
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
        };
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s10",
            status: "done",
            primary_tag: "zoom",
            topic: "Renewal risks",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T12:00:00+03:00",
            session_dir: "/tmp/s10",
            audio_duration_hms: "00:07:42",
            has_transcript_text: true,
            has_summary_text: true,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s10",
          source: "zoom",
          custom_tag: "",
          topic: "Renewal risks",
          participants: [],
        };
      }
      if (cmd === "search_session_artifacts") {
        if ((args as { query?: string } | undefined)?.query === "acme renewal risk") {
          return {
            s10: { transcript_match: true, summary_match: false },
          };
        }
        return {};
      }
      if (cmd === "read_session_artifact") {
        expect(args).toEqual({ sessionId: "s10", artifactKind: "transcript" });
        return {
          path: "/tmp/s10/transcript.txt",
          text: "Agenda\nACME renewal risk blocks legal approval\nNext steps",
        };
      }
      if (cmd === "open_session_artifact") {
        throw new Error("external open should not be used for matched artifact preview");
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await user.type(screen.getByLabelText("Search sessions"), "acme renewal risk");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "текст" })).toHaveClass("match-hit");
    });

    await user.click(screen.getByRole("button", { name: "текст" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("read_session_artifact", {
        sessionId: "s10",
        artifactKind: "transcript",
      });
    });

    expect(await screen.findByRole("dialog", { name: "Просмотр артефакта" })).toBeInTheDocument();
    expect(screen.getByText("/tmp/s10/transcript.txt")).toBeInTheDocument();
    expect(screen.getByText("ACME renewal risk", { selector: "mark" })).toBeInTheDocument();
  });

  it("focuses Search sessions on Cmd/Ctrl+F", async () => {
    const user = userEvent.setup();
    render(<App />);

    const searchInput = screen.getByLabelText("Search sessions");
    expect(searchInput).not.toHaveFocus();

    await user.keyboard("{Meta>}f{/Meta}");
    expect(searchInput).toHaveFocus();

    searchInput.blur();
    expect(searchInput).not.toHaveFocus();

    await user.keyboard("{Control>}f{/Control}");
    expect(searchInput).toHaveFocus();
  });

  it("keeps session path hidden while showing a folder action in session cards", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
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
        };
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s6",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Open folder",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T11:00:00+03:00",
            session_dir: "/tmp/s6",
            audio_duration_hms: "00:03:30",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s6",
          source: "zoom",
          custom_tag: "",
          topic: "Open folder",
          participants: [],
        };
      }
      return null;
    });

    render(<App />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.queryByText("/tmp/s6")).not.toBeInTheDocument();
      expect(screen.queryByText("Path")).not.toBeInTheDocument();
      expect(screen.queryByText("открыть")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Открыть папку сессии" })).toBeInTheDocument();
    });
  });

  it("renders an inline audio player for a session and supports play, pause, and seek", async () => {
    const user = userEvent.setup();
    const playMock = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    const pauseMock = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("pause"));
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s-audio",
            status: "done",
            primary_tag: "slack",
            topic: "Audio demo",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T13:00:00+03:00",
            session_dir: "/tmp/s-audio",
            audio_file: "capture.final.mp3",
            audio_format: "mp3",
            audio_duration_hms: "00:02:00",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s-audio",
          source: "slack",
          custom_tag: "",
          topic: "Audio demo",
          participants: [],
        };
      }
      return null;
    });

    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByDisplayValue("Audio demo")).toBeInTheDocument();
    });

    const sessionCard = screen.getByDisplayValue("Audio demo").closest(".session-card");
    expect(sessionCard?.querySelector(".session-title-line .session-duration-label")).toBeNull();

    const footerMedia = sessionCard?.querySelector(".session-card-footer-media");
    expect(footerMedia).not.toBeNull();
    expect(footerMedia?.querySelector(".session-audio-player")).not.toBeNull();
    expect(footerMedia?.querySelector(".session-duration-label")?.textContent).toBe("00:02:00");

    const audio = container.querySelector('audio[data-session-id="s-audio"]') as HTMLAudioElement | null;
    expect(audio).toBeInTheDocument();
    expect(audio).toHaveAttribute("src", "asset:///tmp/s-audio/capture.final.mp3");

    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: 120,
    });
    act(() => {
      audio?.dispatchEvent(new Event("loadedmetadata"));
    });

    const toggleButton = screen.getByRole("button", { name: "Воспроизвести аудио" });
    await user.click(toggleButton);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Пауза" })).toBeInTheDocument();

    const seekSlider = screen.getByRole("slider", { name: "Позиция аудио" });
    expect(seekSlider).toHaveValue("0");
    expect(seekSlider).toHaveStyle({ "--session-audio-progress": "0%" });

    act(() => {
      if (audio) {
        audio.currentTime = 30;
        audio.dispatchEvent(new Event("timeupdate"));
      }
    });
    await waitFor(() => {
      expect(seekSlider).toHaveValue("25");
    });
    expect(seekSlider).toHaveStyle({ "--session-audio-progress": "25%" });

    fireEvent.change(seekSlider, { target: { value: "50" } });
    expect(seekSlider).toHaveValue("50");
    expect(seekSlider).toHaveStyle({ "--session-audio-progress": "50%" });
    expect(audio?.currentTime).toBe(60);

    await user.click(screen.getByRole("button", { name: "Пауза" }));
    expect(pauseMock).toHaveBeenCalledTimes(1);

    playMock.mockRestore();
    pauseMock.mockRestore();
  });

  it("deletes session only after confirmation", async () => {
    const user = userEvent.setup();
    let sessions = [
      {
        session_id: "s7",
        status: "recorded",
        primary_tag: "zoom",
        topic: "Delete me",
        display_date_ru: "11.03.2026",
        started_at_iso: "2026-03-11T11:30:00+03:00",
        session_dir: "/tmp/s7",
        audio_duration_hms: "00:05:10",
        has_transcript_text: false,
        has_summary_text: false,
      },
    ];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
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
        };
      }
      if (cmd === "list_sessions") {
        return sessions;
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s7",
          source: "zoom",
          custom_tag: "",
          topic: "Delete me",
          participants: [],
        };
      }
      if (cmd === "delete_session") {
        expect(args).toEqual({ sessionId: "s7", force: false });
        sessions = [];
        return "deleted";
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Delete me" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Удалить сессию" }));
    expect(screen.getByText("Удалить сессию и все связанные файлы?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(invokeMock).not.toHaveBeenCalledWith("delete_session", { sessionId: "s7", force: false });
    expect(screen.getByRole("heading", { name: "Delete me" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Удалить сессию" }));
    await user.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("delete_session", { sessionId: "s7", force: false });
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Delete me" })).not.toBeInTheDocument();
    });
  });

  it("restores focus to a stable app control after confirmed delete removes the trigger row", async () => {
    const user = userEvent.setup();
    let sessions = [
      {
        session_id: "s7",
        status: "recorded",
        primary_tag: "zoom",
        topic: "Delete me",
        display_date_ru: "11.03.2026",
        started_at_iso: "2026-03-11T11:30:00+03:00",
        session_dir: "/tmp/s7",
        audio_duration_hms: "00:05:10",
        has_transcript_text: false,
        has_summary_text: false,
      },
    ];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
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
        };
      }
      if (cmd === "list_sessions") {
        return sessions;
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s7",
          source: "zoom",
          custom_tag: "",
          topic: "Delete me",
          participants: [],
        };
      }
      if (cmd === "delete_session") {
        expect(args).toEqual({ sessionId: "s7", force: false });
        sessions = [];
        return "deleted";
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Delete me" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Удалить сессию" }));
    await user.click(screen.getByRole("button", { name: "Удалить" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Delete me" })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Search sessions")).toHaveFocus();
    });
  });

  it("moves focus into the delete confirmation dialog and keeps tab focus inside it", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
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
        };
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s-dialog",
            status: "recorded",
            primary_tag: "zoom",
            topic: "Dialog focus",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T11:30:00+03:00",
            session_dir: "/tmp/s-dialog",
            audio_duration_hms: "00:05:10",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s-dialog",
          source: "zoom",
          custom_tag: "",
          topic: "Dialog focus",
          participants: [],
        };
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Dialog focus" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Удалить сессию" }));

    const cancelButton = screen.getByRole("button", { name: "Отмена" });
    const deleteButton = screen.getByRole("button", { name: "Удалить" });
    await waitFor(() => {
      expect(cancelButton).toHaveFocus();
    });

    await user.tab();
    await waitFor(() => {
      expect(deleteButton).toHaveFocus();
    });

    await user.tab();
    await waitFor(() => {
      expect(cancelButton).toHaveFocus();
    });
  });

  it("forces delete for recording session from confirmation dialog", async () => {
    const user = userEvent.setup();
    let sessions = [
      {
        session_id: "s8",
        status: "recording",
        primary_tag: "slack",
        topic: "Stuck recording",
        display_date_ru: "11.03.2026",
        started_at_iso: "2026-03-11T12:40:00+03:00",
        session_dir: "/tmp/s8",
        audio_duration_hms: "00:00:00",
        has_transcript_text: false,
        has_summary_text: false,
      },
    ];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
      if (cmd === "list_sessions") {
        return sessions;
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s8",
          source: "slack",
          custom_tag: "",
          topic: "Stuck recording",
          participants: [],
        };
      }
      if (cmd === "delete_session") {
        expect(args).toEqual({ sessionId: "s8", force: true });
        sessions = [];
        return "deleted";
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Stuck recording" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Удалить сессию" }));
    expect(
      screen.getByText("Сессия помечена как активная. Принудительно удалить сессию и все связанные файлы?")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("delete_session", { sessionId: "s8", force: true });
    });
  });

  it("shows text loader and success message for session", async () => {
    const user = userEvent.setup();
    let resolveText: (() => void) | null = null;

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s4",
            status: "recorded",
            primary_tag: "slack",
            topic: "Retry loading",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T12:00:00+03:00",
            session_dir: "/tmp/s4",
            has_transcript_text: false,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s4",
          source: "slack",
          custom_tag: "",
          topic: "Retry loading",
          participants: [],
        };
      }
      if (cmd === "run_transcription") {
        return new Promise<string>((resolve) => {
          resolveText = () => resolve("transcribed");
        });
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_session_meta", { sessionId: "s4" });
    });

    await user.click(screen.getByRole("button", { name: "Get text" }));
    expect(screen.getByRole("button", { name: "Getting text..." })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Loading text" })).toBeInTheDocument();

    act(() => {
      resolveText?.();
    });

    await waitFor(() => {
      expect(screen.getByText("Text fetched successfully")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Get text" })).toBeEnabled();
    });
  });

  it("shows summary loader while fetching summary", async () => {
    const user = userEvent.setup();
    let resolveSummary: (() => void) | null = null;

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s9",
            status: "recorded",
            primary_tag: "slack",
            topic: "Summary loading",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T13:20:00+03:00",
            session_dir: "/tmp/s9",
            has_transcript_text: true,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s9",
          source: "slack",
          custom_tag: "",
          topic: "Summary loading",
          participants: [],
        };
      }
      if (cmd === "run_summary") {
        return new Promise<string>((resolve) => {
          resolveSummary = () => resolve("summary complete");
        });
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_session_meta", { sessionId: "s9" });
    });

    await user.click(screen.getByRole("button", { name: "Get Summary" }));
    expect(screen.getByRole("button", { name: "Getting summary..." })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Loading summary" })).toBeInTheDocument();

    act(() => {
      resolveSummary?.();
    });

    await waitFor(() => {
      expect(screen.getByText("Summary fetched successfully")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Get Summary" })).toBeEnabled();
    });
  });

  it("shows summary error message for session", async () => {
    const user = userEvent.setup();

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s5",
            status: "recorded",
            primary_tag: "slack",
            topic: "Retry error",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T12:30:00+03:00",
            session_dir: "/tmp/s5",
            has_transcript_text: true,
            has_summary_text: false,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s5",
          source: "slack",
          custom_tag: "",
          topic: "Retry error",
          participants: [],
        };
      }
      if (cmd === "run_summary") {
        throw new Error("Summary service is unavailable");
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_session_meta", { sessionId: "s5" });
    });

    await user.click(screen.getByRole("button", { name: "Get Summary" }));

    await waitFor(() => {
      expect(screen.getByText("Get summary failed: Summary service is unavailable")).toBeInTheDocument();
    });
  });

  it("opens transcript and summary artifacts by clicking labels", async () => {
    const user = userEvent.setup();

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_ui_sync_state") {
        return { source: "slack", topic: "", is_recording: false, active_session_id: null };
      }
      if (cmd === "set_ui_sync_state") {
        return "updated";
      }
      if (cmd === "list_sessions") {
        return [
          {
            session_id: "s6",
            status: "done",
            primary_tag: "slack",
            topic: "With artifacts",
            display_date_ru: "11.03.2026",
            started_at_iso: "2026-03-11T13:00:00+03:00",
            session_dir: "/tmp/s6",
            has_transcript_text: true,
            has_summary_text: true,
          },
        ];
      }
      if (cmd === "get_session_meta") {
        return {
          session_id: "s6",
          source: "slack",
          custom_tag: "",
          topic: "With artifacts",
          participants: [],
        };
      }
      if (cmd === "open_session_artifact") {
        return "opened";
      }
      return null;
    });

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByText("текст")).toBeInTheDocument();
      expect(screen.getByText("саммари")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "текст" }));
    await user.click(screen.getByRole("button", { name: "саммари" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_session_artifact", {
        sessionId: "s6",
        artifactKind: "transcript",
      });
      expect(invokeMock).toHaveBeenCalledWith("open_session_artifact", {
        sessionId: "s6",
        artifactKind: "summary",
      });
    });
  });
});
