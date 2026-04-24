import { PublicSettings } from "../types";

const allowedAudioFormats = new Set(["opus", "mp3", "m4a", "ogg", "wav"]);
const allowedTranscriptionProviders = new Set(["nexara", "salute_speech"]);
const saluteSpeechSupportedAudioFormats = new Set(["opus", "mp3", "wav"]);
const saluteSpeechAllowedScopes = new Set([
  "SALUTE_SPEECH_PERS",
  "SALUTE_SPEECH_CORP",
  "SALUTE_SPEECH_B2B",
  "SBER_SPEECH",
]);
const saluteSpeechAllowedModels = new Set(["general", "callcenter"]);

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateSettings(settings: PublicSettings | null): string[] {
  if (!settings) return [];
  const errors: string[] = [];
  if (!allowedTranscriptionProviders.has(settings.transcription_provider)) {
    errors.push("Неверный провайдер транскрибации");
  }
  if (
    settings.transcription_provider === "nexara" &&
    settings.transcription_url.trim() &&
    !isValidHttpUrl(settings.transcription_url.trim())
  ) {
    errors.push("Неверный URL транскрибации");
  }
  if (settings.summary_url.trim() && !isValidHttpUrl(settings.summary_url.trim())) {
    errors.push("Неверный URL саммари");
  }
  if (!allowedAudioFormats.has(settings.audio_format)) {
    errors.push("Неверный формат аудио");
  }
  if (settings.audio_format === "opus" && (settings.opus_bitrate_kbps < 12 || settings.opus_bitrate_kbps > 128)) {
    errors.push("Битрейт Opus должен быть от 12 до 128 kbps");
  }
  if (settings.transcription_provider === "salute_speech") {
    if (!saluteSpeechAllowedScopes.has(settings.salute_speech_scope)) {
      errors.push("Неверный scope SalutSpeech");
    }
    if (!saluteSpeechAllowedModels.has(settings.salute_speech_model)) {
      errors.push("Неверная модель распознавания SalutSpeech");
    }
    if (!saluteSpeechSupportedAudioFormats.has(settings.audio_format)) {
      errors.push("Формат аудио не поддерживается SalutSpeech");
    }
    if (settings.salute_speech_sample_rate < 1) {
      errors.push("Частота дискретизации SalutSpeech должна быть больше 0");
    }
    if (settings.salute_speech_channels_count < 1) {
      errors.push("Количество каналов SalutSpeech должно быть больше 0");
    }
  }
  const rawFolder = settings.yandex_sync_remote_folder ?? "";
  const trimmedFolder = rawFolder.trim().replace(/^\/+|\/+$/g, "");
  if (
    trimmedFolder.length === 0 ||
    trimmedFolder === ".." ||
    /\.\./.test(trimmedFolder) ||
    /\\/.test(trimmedFolder) ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(trimmedFolder)
  ) {
    errors.push(
      "Yandex.Disk folder must not be empty or contain ..\\ or control characters"
    );
  }
  return errors;
}
