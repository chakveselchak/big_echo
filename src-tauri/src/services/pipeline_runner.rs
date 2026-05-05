use crate::app_state::AppDirs;
use crate::command_core::{
    mark_pipeline_audio_missing, mark_pipeline_done, mark_pipeline_summary_failed,
    mark_pipeline_transcribed, mark_pipeline_transcription_failed, should_schedule_retry,
    PipelineInvocation,
};
use crate::pipeline;
use crate::settings::public_settings::load_settings;
use crate::settings::secret_store::get_secret;
use crate::storage::markdown_artifact::{strip_frontmatter, write_markdown_artifact};
use crate::storage::session_store::{load_meta, save_meta};
use crate::storage::sqlite_repo::{
    add_event, clear_retry_job, fetch_due_retry_jobs, get_meta_path, schedule_retry_job,
    upsert_session,
};
use std::fs;
use std::io::Write;
use std::path::Path;

const MAX_PIPELINE_RETRY_ATTEMPTS: i64 = 4;
const RETRY_WORKER_POLL_SECONDS: u64 = 20;
const SALUTE_SPEECH_DEFAULT_AUTH_URL: &str = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const SALUTE_SPEECH_DEFAULT_API_BASE_URL: &str = "https://smartspeech.sber.ru";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PipelineMode {
    Full,
    TranscriptionOnly,
    SummaryOnly,
}

fn append_api_call_log_line(
    session_dir: &Path,
    event_type: &str,
    detail: &str,
) -> Result<(), String> {
    let log_path = session_dir.join("api_calls.txt");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let timestamp = chrono::Local::now().to_rfc3339();
    if detail.contains('\n') {
        writeln!(file, "{timestamp} | {event_type}").map_err(|e| e.to_string())?;
        for line in detail.lines() {
            writeln!(file, "  {line}").map_err(|e| e.to_string())?;
        }
    } else {
        writeln!(file, "{timestamp} | {event_type} | {detail}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn salute_speech_auth_url_for_logging() -> String {
    std::env::var("BIGECHO_SALUTE_SPEECH_AUTH_URL")
        .unwrap_or_else(|_| SALUTE_SPEECH_DEFAULT_AUTH_URL.to_string())
}

fn salute_speech_api_base_url_for_logging() -> String {
    std::env::var("BIGECHO_SALUTE_SPEECH_API_URL")
        .unwrap_or_else(|_| SALUTE_SPEECH_DEFAULT_API_BASE_URL.to_string())
}

fn read_transcript_body_for_summary(transcript_path: &Path) -> Result<String, String> {
    let text = fs::read_to_string(transcript_path)
        .map_err(|_| "Transcript file is missing".to_string())?;
    let body = strip_frontmatter(&text).trim();
    if body.is_empty() {
        return Err("Transcript file is empty".to_string());
    }
    Ok(body.to_string())
}

fn transcription_request_log_detail(
    settings: &crate::settings::public_settings::PublicSettings,
) -> String {
    if settings.transcription_provider == "salute_speech" {
        return format!(
            "provider={} auth_url={} api_base_url={} task={} diarization_setting={} salute_scope={} salute_model={}",
            settings.transcription_provider.trim(),
            salute_speech_auth_url_for_logging(),
            salute_speech_api_base_url_for_logging(),
            settings.transcription_task.trim(),
            settings.transcription_diarization_setting.trim(),
            settings.salute_speech_scope.trim(),
            settings.salute_speech_model.trim()
        );
    }

    format!(
        "provider={} url={} task={} diarization_setting={} salute_scope={} salute_model={}",
        settings.transcription_provider.trim(),
        settings.transcription_url.trim(),
        settings.transcription_task.trim(),
        settings.transcription_diarization_setting.trim(),
        settings.salute_speech_scope.trim(),
        settings.salute_speech_model.trim()
    )
}

pub(crate) fn schedule_retry_for_session(
    data_dir: &Path,
    session_id: &str,
    error: &str,
) -> Result<(), String> {
    match schedule_retry_job(data_dir, session_id, error, MAX_PIPELINE_RETRY_ATTEMPTS)? {
        Some(attempt) => {
            add_event(
                data_dir,
                session_id,
                "pipeline_retry_scheduled",
                &format!("Attempt {} scheduled due to: {}", attempt, error),
            )?;
        }
        None => {
            add_event(
                data_dir,
                session_id,
                "pipeline_retry_exhausted",
                "Retry attempts exhausted",
            )?;
        }
    }
    Ok(())
}

pub async fn run_pipeline_core(
    dirs: AppDirs,
    session_id: &str,
    invocation: PipelineInvocation,
    mode: PipelineMode,
    custom_summary_prompt: Option<String>,
) -> Result<String, String> {
    let settings = load_settings(&dirs.app_data_dir)?;
    let data_dir = dirs.app_data_dir.clone();
    let meta_path =
        get_meta_path(&data_dir, session_id)?.ok_or_else(|| "Session not found".to_string())?;
    let mut meta = load_meta(&meta_path)?;
    let session_dir = meta_path
        .parent()
        .ok_or_else(|| "Invalid session directory".to_string())?;
    let api_logging_enabled = settings.api_call_logging_enabled;
    let log_session_id = meta.session_id.clone();
    let log_session_dir = session_dir.to_path_buf();
    let log_api_call = |event_type: &str, detail: String| {
        if api_logging_enabled {
            let _ = add_event(&data_dir, &log_session_id, event_type, &detail);
            let _ = append_api_call_log_line(&log_session_dir, event_type, &detail);
        }
    };
    let external_api_logger = if api_logging_enabled {
        let data_dir = data_dir.clone();
        let log_session_id = log_session_id.clone();
        let log_session_dir = log_session_dir.clone();
        pipeline::ExternalApiLogger::new(move |event_type, detail| {
            let _ = add_event(&data_dir, &log_session_id, event_type, &detail);
            let _ = append_api_call_log_line(&log_session_dir, event_type, &detail);
        })
    } else {
        pipeline::ExternalApiLogger::disabled()
    };

    let audio_path = session_dir.join(&meta.artifacts.audio_file);
    if !audio_path.exists() {
        let detail = mark_pipeline_audio_missing(&mut meta);
        save_meta(&meta_path, &meta)?;
        upsert_session(&data_dir, &meta, session_dir, &meta_path)?;
        add_event(&data_dir, &meta.session_id, "pipeline_failed", &detail)?;
        if should_schedule_retry(invocation) {
            schedule_retry_for_session(&data_dir, &meta.session_id, &detail)?;
        }
        return Err(detail);
    }

    let transcription_secret_name = match settings.transcription_provider.as_str() {
        "salute_speech" => "SALUTE_SPEECH_AUTH_KEY",
        "apple_speech" => "",
        _ => "NEXARA_API_KEY",
    };
    let (transcription_secret, transcription_secret_lookup_err) =
        if transcription_secret_name.is_empty() {
            (String::new(), None)
        } else {
            match get_secret(&dirs.app_data_dir, transcription_secret_name) {
                Ok(value) => (value, None),
                Err(err) => (String::new(), Some(err)),
            }
        };
    let openai_key = get_secret(&dirs.app_data_dir, "OPENAI_API_KEY").unwrap_or_default();

    let needs_transcription = matches!(mode, PipelineMode::Full | PipelineMode::TranscriptionOnly);
    let needs_summary = matches!(mode, PipelineMode::Full | PipelineMode::SummaryOnly);

    if needs_transcription {
        log_api_call(
            "api_transcription_request",
            transcription_request_log_detail(&settings),
        );
        let transcribed = match pipeline::transcribe_audio_logged(
            &settings,
            &transcription_secret,
            &audio_path,
            meta.num_speakers,
            &external_api_logger,
        )
        .await
        {
            Ok(text) => text,
            Err(err) => {
                log_api_call("api_transcription_error", format!("error={err}"));
                let err = if err.contains("No token specified") {
                    if let Some(keyring_err) = transcription_secret_lookup_err.as_ref() {
                        format!(
                            "{err}. keyring lookup error for {transcription_secret_name}: {keyring_err}"
                        )
                    } else if transcription_secret.trim().is_empty() {
                        format!("{err}. {transcription_secret_name} is empty")
                    } else {
                        err
                    }
                } else if settings.transcription_provider == "salute_speech"
                    && transcription_secret.trim().is_empty()
                {
                    format!("{err}. {transcription_secret_name} is empty")
                } else {
                    err
                };
                let detail = mark_pipeline_transcription_failed(&mut meta, &err);
                save_meta(&meta_path, &meta)?;
                upsert_session(&data_dir, &meta, session_dir, &meta_path)?;
                add_event(&data_dir, &meta.session_id, "pipeline_failed", &detail)?;
                if should_schedule_retry(invocation) {
                    schedule_retry_for_session(&data_dir, &meta.session_id, &detail)?;
                }
                return Err(err);
            }
        };
        log_api_call(
            "api_transcription_success",
            format!("transcript_chars={}", transcribed.chars().count()),
        );
        write_markdown_artifact(
            &session_dir.join(&meta.artifacts.transcript_file),
            &meta,
            &transcribed,
        )?;
        mark_pipeline_transcribed(&mut meta);
        save_meta(&meta_path, &meta)?;
        upsert_session(&data_dir, &meta, session_dir, &meta_path)?;
        add_event(
            &data_dir,
            &meta.session_id,
            "transcribed",
            "Transcript created",
        )?;
    }

    if needs_summary {
        let summary_prompt_override = custom_summary_prompt
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                let prompt = meta.custom_summary_prompt.trim();
                (!prompt.is_empty()).then(|| prompt.to_string())
            });
        let transcript_path = session_dir.join(&meta.artifacts.transcript_file);
        let transcript_for_summary = read_transcript_body_for_summary(&transcript_path)?;

        log_api_call(
            "api_summary_request",
            format!(
                "url={} model={} prompt_chars={}",
                settings.summary_url.trim(),
                settings.openai_model.trim(),
                pipeline::resolve_summary_prompt(&settings, summary_prompt_override.as_deref())
                    .chars()
                    .count()
            ),
        );
        let summary = match pipeline::summarize_text_logged(
            &settings,
            &openai_key,
            &transcript_for_summary,
            summary_prompt_override.as_deref(),
            &external_api_logger,
        )
        .await
        {
            Ok(text) => text,
            Err(err) => {
                log_api_call("api_summary_error", format!("error={err}"));
                let detail = mark_pipeline_summary_failed(&mut meta, &err);
                save_meta(&meta_path, &meta)?;
                upsert_session(&data_dir, &meta, session_dir, &meta_path)?;
                add_event(&data_dir, &meta.session_id, "pipeline_failed", &detail)?;
                if should_schedule_retry(invocation) {
                    schedule_retry_for_session(&data_dir, &meta.session_id, &detail)?;
                }
                return Err(err);
            }
        };
        log_api_call(
            "api_summary_success",
            format!("summary_chars={}", summary.chars().count()),
        );
        write_markdown_artifact(
            &session_dir.join(&meta.artifacts.summary_file),
            &meta,
            &summary,
        )?;
        mark_pipeline_done(&mut meta);
        save_meta(&meta_path, &meta)?;
        upsert_session(&data_dir, &meta, session_dir, &meta_path)?;
        add_event(
            &data_dir,
            &meta.session_id,
            "pipeline_done",
            "Summary created",
        )?;
    }

    if matches!(mode, PipelineMode::Full) {
        clear_retry_job(&data_dir, &meta.session_id)?;
        return Ok("done".to_string());
    }
    if matches!(mode, PipelineMode::TranscriptionOnly) {
        return Ok("transcribed".to_string());
    }
    Ok("done".to_string())
}

pub async fn process_retry_jobs_once(
    dirs: &AppDirs,
    now_epoch: i64,
    limit: usize,
) -> Result<(), String> {
    let data_dir = dirs.app_data_dir.clone();
    let jobs = fetch_due_retry_jobs(&data_dir, now_epoch, limit)?;
    for job in jobs {
        let session_id = job.session_id.clone();
        let result = run_pipeline_core(
            dirs.clone(),
            &session_id,
            PipelineInvocation::WorkerRetry,
            PipelineMode::Full,
            None,
        )
        .await;
        if result.is_ok() {
            clear_retry_job(&data_dir, &session_id)?;
            add_event(
                &data_dir,
                &session_id,
                "pipeline_retry_success",
                "Retry succeeded",
            )?;
        } else if let Err(err) = result {
            schedule_retry_for_session(&data_dir, &session_id, &err)?;
        }
    }
    Ok(())
}

pub fn spawn_retry_worker(dirs: AppDirs) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(RETRY_WORKER_POLL_SECONDS)).await;
            let now = chrono::Utc::now().timestamp();
            let _ = process_retry_jobs_once(&dirs, now, 10).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::public_settings::PublicSettings;
    use tempfile::tempdir;

    fn sample_settings() -> PublicSettings {
        PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: "https://api.nexara.ru/api/v1/audio/transcriptions".to_string(),
            transcription_task: "diarize".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_PERS".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
            apple_speech_locale: "ru_RU".to_string(),
            summary_url: "https://example.com/summary".to_string(),
            summary_prompt: String::new(),
            openai_model: "gpt-4.1-mini".to_string(),
            audio_format: "opus".to_string(),
            opus_bitrate_kbps: 24,
            mic_device_name: String::new(),
            system_device_name: String::new(),
            artifact_opener_app: String::new(),
            auto_run_pipeline_on_stop: false,
            api_call_logging_enabled: false,
            auto_delete_audio_enabled: false,
            auto_delete_audio_days: 30,
            yandex_sync_enabled: false,
            yandex_sync_interval: "24h".to_string(),
            yandex_sync_remote_folder: "BigEcho".to_string(),
            show_minitray_overlay: false,
        }
    }

    #[test]
    fn transcription_request_log_for_salutespeech_uses_salute_endpoints() {
        let mut settings = sample_settings();
        settings.transcription_provider = "salute_speech".to_string();

        let detail = transcription_request_log_detail(&settings);

        assert!(detail.contains("provider=salute_speech"));
        assert!(detail.contains("auth_url="));
        assert!(detail.contains("api_base_url="));
        assert!(!detail.contains("url=https://api.nexara.ru/api/v1/audio/transcriptions"));
    }

    #[test]
    fn transcript_body_for_summary_strips_markdown_frontmatter() {
        let tmp = tempdir().expect("tempdir");
        let transcript_path = tmp.path().join("transcript.md");
        std::fs::write(
            &transcript_path,
            "---\nsource: \"zoom\"\ntags:\n  - \"project/acme\"\nnotes: \"Discuss renewal\"\ntopic: \"Renewal sync\"\n---\n\n  # Transcript\n\nSpeaker 1: Hello  \n",
        )
        .expect("write transcript");

        let body = read_transcript_body_for_summary(&transcript_path).expect("summary body");

        assert_eq!(body, "# Transcript\n\nSpeaker 1: Hello");
    }
}
