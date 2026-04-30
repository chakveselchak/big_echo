use crate::services::apple_speech::{self, Availability, CheckResult, TranscribeResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn get_apple_speech_availability() -> Availability {
    apple_speech::availability()
}

#[tauri::command]
pub async fn apple_speech_check_locale(locale: String) -> Result<CheckResult, String> {
    apple_speech::check_locale(&locale).await
}

#[tauri::command]
pub async fn apple_speech_transcribe(
    audio_path: String,
    locale: String,
) -> Result<TranscribeResult, String> {
    apple_speech::transcribe(&audio_path, &locale).await
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    locale: String,
    progress: f64,
}

/// Downloads the on-device speech model for `locale`. Emits
/// `apple-speech://download-progress` events with `{locale, progress: 0..1}`
/// while running. Resolves on success or returns a string error.
#[tauri::command]
pub async fn apple_speech_download_locale(
    app: AppHandle,
    locale: String,
) -> Result<(), String> {
    let locale_clone = locale.clone();
    apple_speech::download_locale(&locale, |progress| {
        let _ = app.emit(
            "apple-speech://download-progress",
            DownloadProgress {
                locale: locale_clone.clone(),
                progress,
            },
        );
    })
    .await
}

#[tauri::command]
pub fn apple_speech_open_dictation_settings() -> Result<(), String> {
    apple_speech::open_dictation_settings()
}
