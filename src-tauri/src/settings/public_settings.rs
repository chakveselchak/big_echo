use crate::text_editors::default_text_editor_id;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

pub const NEXARA_DEFAULT_TRANSCRIPTION_URL: &str =
    "https://api.nexara.ru/api/v1/audio/transcriptions";

const SALUTE_SPEECH_ALLOWED_SCOPES: &[&str] = &[
    "SALUTE_SPEECH_PERS",
    "SALUTE_SPEECH_CORP",
    "SALUTE_SPEECH_B2B",
    "SBER_SPEECH",
];
const SALUTE_SPEECH_ALLOWED_MODELS: &[&str] = &["general", "callcenter"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PublicSettings {
    pub recording_root: String,
    pub artifact_open_app: String,
    pub transcription_provider: String,
    pub transcription_url: String,
    pub transcription_task: String,
    pub transcription_diarization_setting: String,
    pub salute_speech_scope: String,
    pub salute_speech_model: String,
    pub salute_speech_language: String,
    pub salute_speech_sample_rate: u32,
    pub salute_speech_channels_count: u32,
    pub apple_speech_locale: String,
    pub summary_url: String,
    pub summary_prompt: String,
    pub openai_model: String,
    pub audio_format: String,
    pub opus_bitrate_kbps: u32,
    pub mic_device_name: String,
    pub system_device_name: String,
    pub artifact_opener_app: String,
    pub auto_run_pipeline_on_stop: bool,
    pub api_call_logging_enabled: bool,
    pub auto_delete_audio_enabled: bool,
    pub auto_delete_audio_days: u32,
    pub yandex_sync_enabled: bool,
    pub yandex_sync_interval: String,
    pub yandex_sync_remote_folder: String,
}

impl Default for PublicSettings {
    fn default() -> Self {
        Self {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: NEXARA_DEFAULT_TRANSCRIPTION_URL.to_string(),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_CORP".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
            apple_speech_locale: "ru_RU".to_string(),
            summary_url: "http://127.0.0.1:8317/v1/chat/completions".to_string(),
            summary_prompt: "Есть стенограмма встречи. Подготовь краткое саммари.".to_string(),
            openai_model: "gpt-5.1-codex-mini".to_string(),
            audio_format: "opus".to_string(),
            opus_bitrate_kbps: 24,
            mic_device_name: String::new(),
            system_device_name: String::new(),
            artifact_opener_app: default_text_editor_id().unwrap_or_default().to_string(),
            auto_run_pipeline_on_stop: false,
            api_call_logging_enabled: false,
            auto_delete_audio_enabled: false,
            auto_delete_audio_days: 30,
            yandex_sync_enabled: false,
            yandex_sync_interval: "24h".to_string(),
            yandex_sync_remote_folder: "BigEcho".to_string(),
        }
    }
}

fn sanitized_remote_folder(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('/').trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("..") || trimmed.contains('\\') {
        return None;
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(trimmed.to_string())
}

impl PublicSettings {
    fn parse_http_url(value: &str, field: &str) -> Result<(), String> {
        let parsed = Url::parse(value).map_err(|_| format!("Invalid {field} URL"))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(format!("Invalid {field} URL"));
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), String> {
        const YANDEX_INTERVALS: &[&str] = &["1h", "6h", "24h", "48h"];
        if !YANDEX_INTERVALS.contains(&self.yandex_sync_interval.as_str()) {
            return Err("Invalid Yandex sync interval".to_string());
        }
        if sanitized_remote_folder(&self.yandex_sync_remote_folder).is_none() {
            return Err("Invalid Yandex remote folder".to_string());
        }
        if !matches!(
            self.audio_format.as_str(),
            "opus" | "mp3" | "m4a" | "ogg" | "wav"
        ) {
            return Err("Invalid audio format".to_string());
        }
        if self.transcription_provider != "nexara"
            && self.transcription_provider != "salute_speech"
            && self.transcription_provider != "apple_speech"
        {
            return Err("Invalid transcription provider".to_string());
        }
        if self.transcription_provider == "nexara" && !self.transcription_url.is_empty() {
            Self::parse_http_url(&self.transcription_url, "transcription")?;
        }
        if !self.summary_url.is_empty() {
            Self::parse_http_url(&self.summary_url, "summary")?;
        }
        if self.transcription_task != "transcribe" && self.transcription_task != "diarize" {
            return Err("Invalid transcription task".to_string());
        }
        if self.transcription_diarization_setting != "general"
            && self.transcription_diarization_setting != "meeting"
            && self.transcription_diarization_setting != "telephonic"
        {
            return Err("Invalid diarization setting".to_string());
        }
        if self.opus_bitrate_kbps < 12 || self.opus_bitrate_kbps > 128 {
            return Err("Opus bitrate must be between 12 and 128 kbps".to_string());
        }
        if self.transcription_provider == "salute_speech" {
            if !SALUTE_SPEECH_ALLOWED_SCOPES.contains(&self.salute_speech_scope.as_str()) {
                return Err("Invalid SalutSpeech scope".to_string());
            }
            if !SALUTE_SPEECH_ALLOWED_MODELS.contains(&self.salute_speech_model.as_str()) {
                return Err("Invalid SalutSpeech recognition model".to_string());
            }
            if !matches!(self.audio_format.as_str(), "opus" | "mp3" | "wav") {
                return Err("SalutSpeech supports only opus, mp3, or wav audio".to_string());
            }
            if self.salute_speech_sample_rate == 0 {
                return Err("SalutSpeech sample rate must be > 0".to_string());
            }
            if self.salute_speech_channels_count == 0 {
                return Err("SalutSpeech channels count must be > 0".to_string());
            }
        }
        Ok(())
    }
}

pub fn settings_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("settings.json")
}

pub fn load_settings(app_data_dir: &Path) -> Result<PublicSettings, String> {
    let path = settings_file_path(app_data_dir);
    if !path.exists() {
        return Ok(PublicSettings::default());
    }
    let body = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

pub fn save_settings(app_data_dir: &Path, settings: &PublicSettings) -> Result<(), String> {
    settings.validate()?;
    fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let path = settings_file_path(app_data_dir);
    let body = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_urls() {
        let s = PublicSettings {
            transcription_url: "not-a-url".to_string(),
            ..Default::default()
        };
        assert!(s.validate().is_err());
    }

    #[test]
    fn accepts_valid_urls() {
        let s = PublicSettings {
            transcription_url: "https://example.com/transcribe".to_string(),
            summary_url: "https://example.com/summary".to_string(),
            ..Default::default()
        };
        assert!(s.validate().is_ok());
    }

    #[test]
    fn rejects_non_http_urls() {
        let s = PublicSettings {
            transcription_url: "file:///tmp/transcribe".to_string(),
            ..Default::default()
        };
        assert!(s.validate().is_err());
    }

    #[test]
    fn auto_run_pipeline_on_stop_is_disabled_by_default() {
        assert!(!PublicSettings::default().auto_run_pipeline_on_stop);
    }

    #[test]
    fn api_call_logging_is_disabled_by_default() {
        assert!(!PublicSettings::default().api_call_logging_enabled);
    }

    #[test]
    fn summary_defaults_point_to_local_codex_endpoint() {
        let settings = PublicSettings::default();

        assert_eq!(
            settings.summary_url,
            "http://127.0.0.1:8317/v1/chat/completions"
        );
        assert_eq!(settings.openai_model, "gpt-5.1-codex-mini");
    }

    #[test]
    fn missing_auto_run_pipeline_on_stop_uses_default() {
        let body = r#"{
            "recording_root":"./recordings",
            "artifact_open_app":"",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "transcription_task":"transcribe",
            "transcription_diarization_setting":"general",
            "salute_speech_scope":"SALUTE_SPEECH_CORP",
            "salute_speech_model":"general",
            "salute_speech_language":"ru-RU",
            "salute_speech_sample_rate":48000,
            "salute_speech_channels_count":1,
            "summary_url":"",
            "summary_prompt":"Есть стенограмма встречи. Подготовь краткое саммари.",
            "openai_model":"gpt-4.1-mini",
            "audio_format":"opus",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":""
        }"#;
        let parsed: PublicSettings = serde_json::from_str(body).expect("settings should parse");
        assert!(!parsed.auto_run_pipeline_on_stop);
        assert!(!parsed.api_call_logging_enabled);
        assert_eq!(
            parsed.artifact_opener_app,
            default_text_editor_id().unwrap_or_default().to_string()
        );
    }

    #[test]
    fn missing_transcription_task_fields_use_defaults() {
        let body = r#"{
            "recording_root":"./recordings",
            "artifact_open_app":"",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "summary_url":"",
            "openai_model":"gpt-4.1-mini",
            "audio_format":"opus",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":""
        }"#;
        let parsed: PublicSettings = serde_json::from_str(body).expect("settings should parse");
        assert_eq!(parsed.transcription_provider, "nexara");
        assert_eq!(parsed.transcription_task, "transcribe");
        assert_eq!(parsed.transcription_diarization_setting, "general");
        assert_eq!(parsed.salute_speech_scope, "SALUTE_SPEECH_CORP");
        assert_eq!(parsed.salute_speech_model, "general");
        assert_eq!(parsed.salute_speech_language, "ru-RU");
        assert_eq!(parsed.salute_speech_sample_rate, 48_000);
        assert_eq!(parsed.salute_speech_channels_count, 1);
    }

    #[test]
    fn rejects_invalid_salutespeech_scope() {
        let s = PublicSettings {
            transcription_provider: "salute_speech".to_string(),
            salute_speech_scope: "invalid".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid SalutSpeech scope".to_string()));
    }

    #[test]
    fn rejects_invalid_salutespeech_model() {
        let s = PublicSettings {
            transcription_provider: "salute_speech".to_string(),
            salute_speech_model: "invalid".to_string(),
            ..Default::default()
        };
        assert_eq!(
            s.validate(),
            Err("Invalid SalutSpeech recognition model".to_string())
        );
    }

    #[test]
    fn missing_summary_prompt_uses_default() {
        let body = r#"{
            "recording_root":"./recordings",
            "artifact_open_app":"",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "transcription_task":"transcribe",
            "transcription_diarization_setting":"general",
            "salute_speech_scope":"SALUTE_SPEECH_CORP",
            "salute_speech_model":"general",
            "salute_speech_language":"ru-RU",
            "salute_speech_sample_rate":48000,
            "salute_speech_channels_count":1,
            "summary_url":"",
            "openai_model":"gpt-4.1-mini",
            "audio_format":"opus",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":""
        }"#;
        let parsed: PublicSettings = serde_json::from_str(body).expect("settings should parse");
        assert_eq!(
            parsed.summary_prompt,
            "Есть стенограмма встречи. Подготовь краткое саммари."
        );
    }

    #[test]
    fn missing_summary_endpoint_fields_use_defaults() {
        let body = r#"{
            "recording_root":"./recordings",
            "artifact_open_app":"",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "transcription_task":"transcribe",
            "transcription_diarization_setting":"general",
            "salute_speech_scope":"SALUTE_SPEECH_CORP",
            "salute_speech_model":"general",
            "salute_speech_language":"ru-RU",
            "salute_speech_sample_rate":48000,
            "salute_speech_channels_count":1,
            "summary_prompt":"Есть стенограмма встречи. Подготовь краткое саммари.",
            "audio_format":"opus",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":""
        }"#;
        let parsed: PublicSettings = serde_json::from_str(body).expect("settings should parse");
        assert_eq!(
            parsed.summary_url,
            "http://127.0.0.1:8317/v1/chat/completions"
        );
        assert_eq!(parsed.openai_model, "gpt-5.1-codex-mini");
    }

    #[test]
    fn missing_artifact_open_app_uses_default() {
        let body = r#"{
            "recording_root":"./recordings",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "transcription_task":"transcribe",
            "transcription_diarization_setting":"general",
            "salute_speech_scope":"SALUTE_SPEECH_CORP",
            "salute_speech_model":"general",
            "salute_speech_language":"ru-RU",
            "salute_speech_sample_rate":48000,
            "salute_speech_channels_count":1,
            "summary_url":"",
            "summary_prompt":"Есть стенограмма встречи. Подготовь краткое саммари.",
            "openai_model":"gpt-4.1-mini",
            "audio_format":"opus",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":"",
            "auto_run_pipeline_on_stop":false,
            "api_call_logging_enabled":false
        }"#;
        let parsed: PublicSettings = serde_json::from_str(body).expect("settings should parse");
        assert_eq!(parsed.artifact_open_app, "");
    }

    #[test]
    fn missing_audio_format_uses_default() {
        let body = r#"{
            "recording_root":"./recordings",
            "artifact_open_app":"",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "transcription_task":"transcribe",
            "transcription_diarization_setting":"general",
            "salute_speech_scope":"SALUTE_SPEECH_CORP",
            "salute_speech_model":"general",
            "salute_speech_language":"ru-RU",
            "salute_speech_sample_rate":48000,
            "salute_speech_channels_count":1,
            "summary_url":"",
            "summary_prompt":"Есть стенограмма встречи. Подготовь краткое саммари.",
            "openai_model":"gpt-4.1-mini",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":"",
            "auto_run_pipeline_on_stop":false,
            "api_call_logging_enabled":false
        }"#;
        let parsed: PublicSettings = serde_json::from_str(body).expect("settings should parse");
        assert_eq!(parsed.audio_format, "opus");
    }

    #[test]
    fn rejects_unknown_audio_format() {
        let s = PublicSettings {
            audio_format: "flac".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid audio format".to_string()));
    }

    #[test]
    fn rejects_unknown_transcription_provider() {
        let s = PublicSettings {
            transcription_provider: "other".to_string(),
            ..Default::default()
        };
        assert_eq!(
            s.validate(),
            Err("Invalid transcription provider".to_string())
        );
    }

    #[test]
    fn rejects_unsupported_audio_format_for_salutespeech() {
        let s = PublicSettings {
            transcription_provider: "salute_speech".to_string(),
            audio_format: "m4a".to_string(),
            ..Default::default()
        };
        assert_eq!(
            s.validate(),
            Err("SalutSpeech supports only opus, mp3, or wav audio".to_string())
        );
    }

    #[test]
    fn auto_delete_audio_is_disabled_by_default_with_30_days() {
        let settings = PublicSettings::default();
        assert!(!settings.auto_delete_audio_enabled);
        assert_eq!(settings.auto_delete_audio_days, 30);
    }

    #[test]
    fn missing_auto_delete_audio_fields_use_defaults() {
        // Older settings.json that predates the auto-delete feature must
        // deserialize without complaint and pick up the documented defaults.
        let body = r#"{
            "recording_root":"./recordings",
            "artifact_open_app":"",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "transcription_task":"transcribe",
            "transcription_diarization_setting":"general",
            "salute_speech_scope":"SALUTE_SPEECH_CORP",
            "salute_speech_model":"general",
            "salute_speech_language":"ru-RU",
            "salute_speech_sample_rate":48000,
            "salute_speech_channels_count":1,
            "summary_url":"",
            "summary_prompt":"",
            "openai_model":"gpt-4.1-mini",
            "audio_format":"opus",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":"",
            "auto_run_pipeline_on_stop":false,
            "api_call_logging_enabled":false
        }"#;
        let parsed: PublicSettings =
            serde_json::from_str(body).expect("settings should parse");
        assert!(!parsed.auto_delete_audio_enabled);
        assert_eq!(parsed.auto_delete_audio_days, 30);
    }

    #[test]
    fn yandex_sync_defaults_are_disabled_with_24h_interval() {
        let s = PublicSettings::default();
        assert!(!s.yandex_sync_enabled);
        assert_eq!(s.yandex_sync_interval, "24h");
        assert_eq!(s.yandex_sync_remote_folder, "BigEcho");
    }

    #[test]
    fn missing_yandex_sync_fields_use_defaults() {
        let body = r#"{
            "recording_root":"./recordings",
            "artifact_open_app":"",
            "transcription_provider":"nexara",
            "transcription_url":"",
            "transcription_task":"transcribe",
            "transcription_diarization_setting":"general",
            "salute_speech_scope":"SALUTE_SPEECH_CORP",
            "salute_speech_model":"general",
            "salute_speech_language":"ru-RU",
            "salute_speech_sample_rate":48000,
            "salute_speech_channels_count":1,
            "summary_url":"",
            "summary_prompt":"",
            "openai_model":"gpt-4.1-mini",
            "audio_format":"opus",
            "opus_bitrate_kbps":24,
            "mic_device_name":"",
            "system_device_name":"",
            "auto_run_pipeline_on_stop":false,
            "api_call_logging_enabled":false,
            "auto_delete_audio_enabled":false,
            "auto_delete_audio_days":30
        }"#;
        let parsed: PublicSettings = serde_json::from_str(body).expect("settings should parse");
        assert!(!parsed.yandex_sync_enabled);
        assert_eq!(parsed.yandex_sync_interval, "24h");
        assert_eq!(parsed.yandex_sync_remote_folder, "BigEcho");
    }

    #[test]
    fn accepts_valid_yandex_sync_intervals() {
        for iv in ["1h", "6h", "24h", "48h"] {
            let s = PublicSettings {
                yandex_sync_interval: iv.to_string(),
                ..Default::default()
            };
            assert!(s.validate().is_ok(), "interval {iv} should be valid");
        }
    }

    #[test]
    fn rejects_invalid_yandex_sync_interval() {
        let s = PublicSettings {
            yandex_sync_interval: "5m".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex sync interval".to_string()));
    }

    #[test]
    fn rejects_remote_folder_with_dotdot() {
        let s = PublicSettings {
            yandex_sync_remote_folder: "BigEcho/../evil".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex remote folder".to_string()));
    }

    #[test]
    fn rejects_empty_remote_folder_after_trim() {
        let s = PublicSettings {
            yandex_sync_remote_folder: "   /".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex remote folder".to_string()));
    }

    #[test]
    fn rejects_remote_folder_with_backslash() {
        let s = PublicSettings {
            yandex_sync_remote_folder: "Big\\Echo".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex remote folder".to_string()));
    }

    #[test]
    fn rejects_remote_folder_with_embedded_control_char() {
        let s = PublicSettings {
            yandex_sync_remote_folder: "Big\nEcho".to_string(),
            ..Default::default()
        };
        assert_eq!(s.validate(), Err("Invalid Yandex remote folder".to_string()));
    }

    #[test]
    fn accepts_remote_folder_with_surrounding_slashes() {
        let s = PublicSettings {
            yandex_sync_remote_folder: "/BigEcho/".to_string(),
            ..Default::default()
        };
        assert!(s.validate().is_ok());
    }
}
