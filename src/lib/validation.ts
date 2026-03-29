import { PublicSettings } from "../appTypes";

const allowedAudioFormats = new Set(["opus", "mp3", "m4a", "ogg", "wav"]);
const allowedTranscriptionProviders = new Set(["nexara", "salute_speech"]);
const saluteSpeechSupportedAudioFormats = new Set(["opus", "mp3", "wav"]);

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
  return errors;
}
