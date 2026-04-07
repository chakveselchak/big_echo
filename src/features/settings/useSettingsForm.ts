import { useEffect, useMemo, useState } from "react";
import {
  MacosSystemAudioPermissionStatus,
  PublicSettings,
  SecretSaveState,
  SettingsTab,
  TextEditorAppOption,
  TextEditorAppsResponse,
} from "../../appTypes";
import { validateSettings } from "../../lib/validation";
import { tauriInvoke } from "../../lib/tauri";

type UseSettingsFormOptions = {
  enabled?: boolean;
  isTrayWindow: boolean;
  setStatus: (status: string) => void;
};

type MacosSystemAudioPermissionLoadState = "loading" | "ready" | "error";

const frontendFallbackEditors: TextEditorAppOption[] = [
  { id: "TextEdit", name: "TextEdit", icon_fallback: "📝", icon_data_url: null },
  { id: "Visual Studio Code", name: "Visual Studio Code", icon_fallback: "💠", icon_data_url: null },
  { id: "Sublime Text", name: "Sublime Text", icon_fallback: "🟧", icon_data_url: null },
  { id: "Cursor", name: "Cursor", icon_fallback: "🧩", icon_data_url: null },
  { id: "Windsurf", name: "Windsurf", icon_fallback: "🧩", icon_data_url: null },
  { id: "Zed", name: "Zed", icon_fallback: "🧩", icon_data_url: null },
];

const fallbackMacosSystemAudioPermission: MacosSystemAudioPermissionStatus = {
  kind: "unsupported",
  can_request: false,
};

function normalizeMacosSystemAudioPermissionStatus(
  value: unknown
): MacosSystemAudioPermissionStatus {
  if (!value || typeof value !== "object") {
    return fallbackMacosSystemAudioPermission;
  }

  const candidate = value as {
    kind?: unknown;
    can_request?: unknown;
  };

  if (
    candidate.kind === "granted" ||
    candidate.kind === "not_determined" ||
    candidate.kind === "denied" ||
    candidate.kind === "unsupported"
  ) {
    return {
      kind: candidate.kind,
      can_request: candidate.can_request === true,
    };
  }

  return fallbackMacosSystemAudioPermission;
}

export function useSettingsForm({ enabled = true, isTrayWindow, setStatus }: UseSettingsFormOptions) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [savedSettingsSnapshot, setSavedSettingsSnapshot] = useState<PublicSettings | null>(null);
  const [nexaraKey, setNexaraKey] = useState("");
  const [salutSpeechAuthKey, setSalutSpeechAuthKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [nexaraSecretState, setNexaraSecretState] = useState<SecretSaveState>("unknown");
  const [salutSpeechSecretState, setSalutSpeechSecretState] = useState<SecretSaveState>("unknown");
  const [openaiSecretState, setOpenaiSecretState] = useState<SecretSaveState>("unknown");
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [macosSystemAudioPermissionLoadState, setMacosSystemAudioPermissionLoadState] =
    useState<MacosSystemAudioPermissionLoadState>("loading");
  const [macosSystemAudioPermission, setMacosSystemAudioPermission] =
    useState<MacosSystemAudioPermissionStatus | null>(null);
  const [textEditorApps, setTextEditorApps] = useState<TextEditorAppOption[]>([]);
  const [textEditorAppsLoaded, setTextEditorAppsLoaded] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("audiototext");

  const settingsErrors = useMemo(() => validateSettings(settings), [settings]);
  const canSaveSettings = Boolean(settings) && settingsErrors.length === 0;

  async function loadSettings() {
    const data = await tauriInvoke<PublicSettings>("get_settings");
    setSettings(data);
    setSavedSettingsSnapshot(data);
  }

  async function loadAudioDevices() {
    const list = await tauriInvoke<string[]>("list_audio_input_devices");
    setAudioDevices(list);
  }

  async function loadMacosSystemAudioPermission() {
    try {
      const status = await tauriInvoke<unknown>("get_macos_system_audio_permission_status");
      setMacosSystemAudioPermission(normalizeMacosSystemAudioPermissionStatus(status));
      setMacosSystemAudioPermissionLoadState("ready");
    } catch {
      setMacosSystemAudioPermission(null);
      setMacosSystemAudioPermissionLoadState("error");
      setStatus("error: не удалось загрузить статус разрешения macOS system audio");
    }
  }

  async function autoDetectSystemSource() {
    const detected = await tauriInvoke<string | null>("detect_system_source_device");
    if (!detected) {
      setStatus("system_source_not_detected");
      return;
    }
    setSettings((prev) => (prev ? { ...prev, system_device_name: detected } : prev));
    setStatus(`system_source_detected:${detected}`);
  }

  async function openMacosSystemAudioSettings() {
    try {
      await tauriInvoke("open_macos_system_audio_settings");
    } catch (err) {
      setStatus(`error: не удалось открыть системные настройки macOS (${String(err)})`);
    }
  }

  async function pickRecordingRoot() {
    try {
      const picked = await tauriInvoke<string | null>("pick_recording_root");
      if (!picked) return;
      setSettings((prev) => (prev ? { ...prev, recording_root: picked } : prev));
    } catch (err) {
      setStatus(`error: не удалось выбрать каталог (${String(err)})`);
    }
  }

  async function saveApiKeys() {
    let hasSecretError = false;
    let nextNexaraState: SecretSaveState = "unchanged";
    let nextSalutSpeechState: SecretSaveState = "unchanged";
    let nextOpenAiState: SecretSaveState = "unchanged";

    if (nexaraKey.trim()) {
      try {
        await tauriInvoke("set_api_secret", { name: "NEXARA_API_KEY", value: nexaraKey.trim() });
        nextNexaraState = "updated";
      } catch {
        nextNexaraState = "error";
        hasSecretError = true;
      }
    }

    if (salutSpeechAuthKey.trim()) {
      try {
        await tauriInvoke("set_api_secret", {
          name: "SALUTE_SPEECH_AUTH_KEY",
          value: salutSpeechAuthKey.trim(),
        });
        nextSalutSpeechState = "updated";
      } catch {
        nextSalutSpeechState = "error";
        hasSecretError = true;
      }
    }

    if (openaiKey.trim()) {
      try {
        await tauriInvoke("set_api_secret", { name: "OPENAI_API_KEY", value: openaiKey.trim() });
        nextOpenAiState = "updated";
      } catch {
        nextOpenAiState = "error";
        hasSecretError = true;
      }
    }

    setNexaraSecretState(nextNexaraState);
    setSalutSpeechSecretState(nextSalutSpeechState);
    setOpenaiSecretState(nextOpenAiState);

    if (hasSecretError) {
      setStatus("error: не удалось сохранить один или несколько ключей");
      return;
    }

    if (nextNexaraState === "updated") setNexaraKey("");
    if (nextSalutSpeechState === "updated") setSalutSpeechAuthKey("");
    if (nextOpenAiState === "updated") setOpenaiKey("");
    setStatus("keys_saved");
  }

  async function saveSettings() {
    if (!settings) return;
    if (settingsErrors.length === 0) {
      await tauriInvoke("save_public_settings", { payload: settings });
      setSavedSettingsSnapshot(settings);
    }
    await saveApiKeys();
    setStatus(settingsErrors.length > 0 ? "error: исправьте настройки перед сохранением" : "settings_saved");
  }

  async function saveSettingsPatch(patch: Partial<PublicSettings>) {
    const base = settings ?? (await tauriInvoke<PublicSettings>("get_settings"));
    const next = { ...base, ...patch };
    setSettings(next);
    await tauriInvoke("save_public_settings", { payload: next });
  }

  useEffect(() => {
    if (!enabled) return;
    void loadSettings().catch(() => undefined);
    void loadMacosSystemAudioPermission().catch(() => undefined);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (isTrayWindow) {
      void loadAudioDevices().catch(() => undefined);
      return;
    }
    if (settingsTab !== "audio" || audioDevices.length > 0) return;
    void loadAudioDevices().catch(() => undefined);
  }, [audioDevices.length, enabled, isTrayWindow, settingsTab]);

  useEffect(() => {
    if (!enabled) return;
    if (isTrayWindow) return;
    if (settingsTab !== "generals" || textEditorAppsLoaded) return;
    let active = true;
    let loadedSuccessfully = false;
    tauriInvoke<TextEditorAppsResponse>("list_text_editor_apps")
      .then((result) => {
        if (!active) return;
        const detected = Array.isArray(result?.apps) ? result.apps : [];
        const list = detected.length > 0 ? detected : frontendFallbackEditors;
        setTextEditorApps(list);
        loadedSuccessfully = true;
        if (detected.length === 0) {
          setStatus("error: системный список редакторов пуст, использован fallback");
        }
        setSettings((prev) =>
          prev
            ? {
                ...prev,
                artifact_open_app:
                  prev.artifact_open_app?.trim() || result?.default_app_id || list[0]?.id || "",
              }
            : prev
        );
      })
      .catch((err) => {
        if (!active) return;
        setStatus(`error: не удалось загрузить список редакторов (${String(err)})`);
      })
      .finally(() => {
        if (active && loadedSuccessfully) setTextEditorAppsLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [enabled, isTrayWindow, settingsTab, textEditorAppsLoaded]);

  return {
    audioDevices,
    autoDetectSystemSource,
    canSaveSettings,
    loadAudioDevices,
    loadMacosSystemAudioPermission,
    loadSettings,
    nexaraKey,
    nexaraSecretState,
    macosSystemAudioPermission,
    macosSystemAudioPermissionLoadState,
    openaiKey,
    openaiSecretState,
    openMacosSystemAudioSettings,
    pickRecordingRoot,
    salutSpeechAuthKey,
    salutSpeechSecretState,
    saveApiKeys,
    saveSettings,
    saveSettingsPatch,
    savedSettingsSnapshot,
    setNexaraKey,
    setNexaraSecretState,
    setOpenaiKey,
    setOpenaiSecretState,
    setSalutSpeechAuthKey,
    setSalutSpeechSecretState,
    setSettings,
    setSettingsTab,
    settings,
    settingsErrors,
    settingsTab,
    textEditorApps,
  };
}
