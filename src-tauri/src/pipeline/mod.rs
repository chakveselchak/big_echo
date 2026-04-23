use crate::settings::public_settings::PublicSettings;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::error::Error as StdError;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

const SALUTE_SPEECH_DEFAULT_AUTH_URL: &str = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const SALUTE_SPEECH_DEFAULT_API_BASE_URL: &str = "https://smartspeech.sber.ru";
const SALUTE_SPEECH_STATUS_POLL_ATTEMPTS: usize = 300;
const SALUTE_SPEECH_STATUS_POLL_DELAY_MS: u64 = 1000;
const SALUTE_SPEECH_BUNDLED_ROOT_CERT_PEM: &[u8] =
    include_bytes!("../../certs/russian_trusted_root_ca.cer");

type ExternalApiLogCallback = dyn Fn(&str, String) + Send + Sync;

#[derive(Clone, Default)]
pub struct ExternalApiLogger {
    callback: Option<Arc<ExternalApiLogCallback>>,
}

#[derive(Clone, Debug)]
enum HttpLogBody {
    Empty,
    Json(serde_json::Value),
    Text(String),
    Lines(Vec<String>),
    Binary {
        content_type: Option<String>,
        bytes: usize,
        sha256: String,
    },
}

impl ExternalApiLogger {
    pub fn disabled() -> Self {
        Self { callback: None }
    }

    pub fn new<F>(callback: F) -> Self
    where
        F: Fn(&str, String) + Send + Sync + 'static,
    {
        Self {
            callback: Some(Arc::new(callback)),
        }
    }

    fn log(&self, event_type: &str, detail: String) {
        if let Some(callback) = &self.callback {
            callback(event_type, detail);
        }
    }

    fn log_http_request(
        &self,
        service: &str,
        operation: &str,
        method: &str,
        url: &str,
        headers: &HeaderMap,
        body: &HttpLogBody,
    ) {
        let mut lines = vec![
            format!("service: {service}"),
            format!("operation: {operation}"),
            format!("method: {method}"),
            format!("url: {url}"),
            "headers:".to_string(),
        ];
        lines.extend(
            format_headers(headers)
                .into_iter()
                .map(|line| format!("  {line}")),
        );
        lines.push("body:".to_string());
        lines.extend(
            format_http_body(body)
                .into_iter()
                .map(|line| format!("  {line}")),
        );
        self.log("api_http_request", lines.join("\n"));
    }

    fn log_http_response(
        &self,
        service: &str,
        operation: &str,
        status: &reqwest::StatusCode,
        headers: &HeaderMap,
        body_text: &str,
    ) {
        let mut lines = vec![
            format!("service: {service}"),
            format!("operation: {operation}"),
            format!("status: {status}"),
            "headers:".to_string(),
        ];
        lines.extend(
            format_headers(headers)
                .into_iter()
                .map(|line| format!("  {line}")),
        );
        lines.push("body:".to_string());
        lines.extend(
            format_response_body(body_text)
                .into_iter()
                .map(|line| format!("  {line}")),
        );
        self.log("api_http_response", lines.join("\n"));
    }

    fn log_http_error(&self, service: &str, operation: &str, method: &str, url: &str, error: &str) {
        let lines = [
            format!("service: {service}"),
            format!("operation: {operation}"),
            format!("method: {method}"),
            format!("url: {url}"),
            format!("error: {error}"),
        ];
        self.log("api_http_error", lines.join("\n"));
    }
}

fn format_headers(headers: &HeaderMap) -> Vec<String> {
    let mut pairs: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| {
            let raw = value.to_str().unwrap_or("<non-utf8>");
            (
                name.as_str().to_string(),
                mask_header_value(name.as_str(), raw),
            )
        })
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    if pairs.is_empty() {
        return vec!["<none>".to_string()];
    }
    pairs
        .into_iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect()
}

fn mask_header_value(name: &str, value: &str) -> String {
    if !name.eq_ignore_ascii_case("authorization") {
        return value.to_string();
    }
    if let Some(rest) = value.strip_prefix("Bearer ") {
        return format!("Bearer {}", mask_secret(rest));
    }
    if let Some(rest) = value.strip_prefix("Basic ") {
        return format!("Basic {}", mask_secret(rest));
    }
    mask_secret(value)
}

fn mask_secret(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= 8 {
        return "***".to_string();
    }
    let suffix = &trimmed[trimmed.len().saturating_sub(4)..];
    format!("***{suffix}")
}

fn format_http_body(body: &HttpLogBody) -> Vec<String> {
    match body {
        HttpLogBody::Empty => vec!["<empty>".to_string()],
        HttpLogBody::Json(value) => format_multiline_block(&pretty_json(value)),
        HttpLogBody::Text(text) => format_multiline_block(text),
        HttpLogBody::Lines(lines) => {
            if lines.is_empty() {
                vec!["<empty>".to_string()]
            } else {
                lines.clone()
            }
        }
        HttpLogBody::Binary {
            content_type,
            bytes,
            sha256,
        } => {
            let mut lines = Vec::new();
            if let Some(content_type) = content_type {
                lines.push(format!("content_type: {content_type}"));
            }
            lines.push(format!("bytes: {bytes}"));
            lines.push(format!("sha256: {sha256}"));
            lines.push("content: <binary omitted>".to_string());
            lines
        }
    }
}

fn format_response_body(body_text: &str) -> Vec<String> {
    if body_text.trim().is_empty() {
        return vec!["<empty>".to_string()];
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body_text) {
        return format_multiline_block(&pretty_json(&value));
    }
    format_multiline_block(body_text)
}

fn format_multiline_block(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec!["<empty>".to_string()];
    }
    text.lines().map(|line| line.to_string()).collect()
}

fn pretty_json(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn format_diarize_segments(body: &serde_json::Value) -> Option<String> {
    let task = body
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if task != "diarize" {
        return None;
    }
    let segments = body.get("segments").and_then(|v| v.as_array())?;
    let mut lines: Vec<String> = Vec::new();
    for segment in segments {
        let text = segment
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let speaker = segment
            .get("speaker")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("speaker_unknown");
        lines.push(format!("{speaker}: {text}"));
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n\n"))
    }
}

#[allow(dead_code)]
pub async fn transcribe_audio(
    settings: &PublicSettings,
    api_key: &str,
    audio_path: &Path,
) -> Result<String, String> {
    transcribe_audio_logged(
        settings,
        api_key,
        audio_path,
        &ExternalApiLogger::disabled(),
    )
    .await
}

pub async fn transcribe_audio_logged(
    settings: &PublicSettings,
    api_key: &str,
    audio_path: &Path,
    logger: &ExternalApiLogger,
) -> Result<String, String> {
    if settings.transcription_provider == "salute_speech" {
        return transcribe_audio_with_salutespeech(settings, api_key, audio_path, logger).await;
    }
    transcribe_audio_with_nexara(settings, api_key, audio_path, logger).await
}

async fn transcribe_audio_with_nexara(
    settings: &PublicSettings,
    api_key: &str,
    audio_path: &Path,
    logger: &ExternalApiLogger,
) -> Result<String, String> {
    let transcription_url = {
        let trimmed = settings.transcription_url.trim();
        if trimmed.is_empty() {
            crate::settings::public_settings::NEXARA_DEFAULT_TRANSCRIPTION_URL.to_string()
        } else {
            trimmed.to_string()
        }
    };

    let data = std::fs::read(audio_path).map_err(|e| e.to_string())?;
    let file_name = audio_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.opus")
        .to_string();
    let mime = crate::audio::file_writer::mime_type_for_audio_path(audio_path);
    let data_len = data.len();
    let data_sha256 = sha256_hex(&data);
    let request_file_name = file_name.clone();

    let part = reqwest::multipart::Part::bytes(data)
        .file_name(file_name)
        .mime_str(mime)
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("task", settings.transcription_task.trim().to_string())
        .text(
            "diarization_setting",
            settings
                .transcription_diarization_setting
                .trim()
                .to_string(),
        )
        .text("model", "whisper-1")
        .text("response_format", "json");

    let mut headers = HeaderMap::new();
    let bearer = format!("Bearer {}", api_key.trim());
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&bearer).map_err(|e| e.to_string())?,
    );

    let request_body = HttpLogBody::Lines(vec![
        format!("content_type: multipart/form-data"),
        format!("field task: {}", settings.transcription_task.trim()),
        format!(
            "field diarization_setting: {}",
            settings.transcription_diarization_setting.trim()
        ),
        "field model: whisper-1".to_string(),
        "field response_format: json".to_string(),
        format!("file field: file ({request_file_name})"),
        format!("file content_type: {mime}"),
        format!("file bytes: {data_len}"),
        format!("file sha256: {data_sha256}"),
    ]);
    logger.log_http_request(
        "nexara",
        "transcription",
        "POST",
        &transcription_url,
        &headers,
        &request_body,
    );

    let client = reqwest::Client::new();
    let res = client
        .post(&transcription_url)
        .headers(headers)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            let message = e.to_string();
            logger.log_http_error(
                "nexara",
                "transcription",
                "POST",
                &transcription_url,
                &message,
            );
            message
        })?;

    let body = parse_json_response(res, "transcription", logger, "nexara", "transcription").await?;
    if let Some(formatted) = format_diarize_segments(&body) {
        return Ok(formatted);
    }
    extract_transcript_text(&body)
}

async fn transcribe_audio_with_salutespeech(
    settings: &PublicSettings,
    auth_key: &str,
    audio_path: &Path,
    logger: &ExternalApiLogger,
) -> Result<String, String> {
    if auth_key.trim().is_empty() {
        return Err("SalutSpeech authorization key is empty".to_string());
    }

    let client = salute_speech_client()?;
    let access_token = request_salute_speech_access_token(
        &client,
        auth_key,
        &settings.salute_speech_scope,
        logger,
    )
    .await?;
    let request_file_id =
        upload_salute_speech_audio(&client, &access_token, audio_path, logger).await?;
    let task_id = create_salute_speech_recognition_task(
        &client,
        &access_token,
        settings,
        audio_path,
        &request_file_id,
        logger,
    )
    .await?;
    let response_file_id =
        poll_salute_speech_task(&client, &access_token, &task_id, logger).await?;
    let payload =
        download_salute_speech_result(&client, &access_token, &response_file_id, logger).await?;
    if let Some(formatted) = format_diarize_segments(&payload) {
        return Ok(formatted);
    }
    extract_transcript_text(&payload)
}

async fn request_salute_speech_access_token(
    client: &reqwest::Client,
    auth_key: &str,
    scope: &str,
    logger: &ExternalApiLogger,
) -> Result<String, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Basic {}", auth_key.trim())).map_err(|e| e.to_string())?,
    );
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        "RqUID",
        HeaderValue::from_str(&Uuid::new_v4().to_string()).map_err(|e| e.to_string())?,
    );
    let url = salute_speech_auth_url();
    logger.log_http_request(
        "salute_speech",
        "token request",
        "POST",
        &url,
        &headers,
        &HttpLogBody::Text(format!("scope={}", scope.trim())),
    );

    let res = client
        .post(&url)
        .headers(headers)
        .form(&[("scope", scope.trim())])
        .send()
        .await
        .map_err(|e| {
            let formatted = format_salute_speech_network_error("token request", &e);
            logger.log_http_error("salute_speech", "token request", "POST", &url, &formatted);
            formatted
        })?;

    let body = parse_json_response(
        res,
        "salutespeech token request",
        logger,
        "salute_speech",
        "token request",
    )
    .await?;
    body.get("access_token")
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "SalutSpeech token response does not contain access_token".to_string())
}

async fn upload_salute_speech_audio(
    client: &reqwest::Client,
    access_token: &str,
    audio_path: &Path,
    logger: &ExternalApiLogger,
) -> Result<String, String> {
    let data = std::fs::read(audio_path).map_err(|e| e.to_string())?;
    let mut headers = salute_speech_bearer_headers(access_token)?;
    let content_type = salute_speech_upload_content_type(audio_path)?;
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&content_type).map_err(|e| e.to_string())?,
    );
    let url = format!("{}/rest/v1/data:upload", salute_speech_api_base_url());
    logger.log_http_request(
        "salute_speech",
        "audio upload",
        "POST",
        &url,
        &headers,
        &HttpLogBody::Binary {
            content_type: Some(content_type.clone()),
            bytes: data.len(),
            sha256: sha256_hex(&data),
        },
    );

    let res = client
        .post(&url)
        .headers(headers)
        .body(data)
        .send()
        .await
        .map_err(|e| {
            let formatted = format_salute_speech_network_error("audio upload", &e);
            logger.log_http_error("salute_speech", "audio upload", "POST", &url, &formatted);
            formatted
        })?;

    let body = parse_json_response(
        res,
        "salutespeech upload",
        logger,
        "salute_speech",
        "audio upload",
    )
    .await?;
    body.get("result")
        .and_then(|v| v.get("request_file_id"))
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "SalutSpeech upload response does not contain request_file_id".to_string())
}

async fn create_salute_speech_recognition_task(
    client: &reqwest::Client,
    access_token: &str,
    settings: &PublicSettings,
    audio_path: &Path,
    request_file_id: &str,
    logger: &ExternalApiLogger,
) -> Result<String, String> {
    let mut options = serde_json::Map::new();
    options.insert(
        "model".to_string(),
        serde_json::Value::String(settings.salute_speech_model.trim().to_string()),
    );
    options.insert(
        "audio_encoding".to_string(),
        serde_json::Value::String(salute_speech_audio_encoding(audio_path)?.to_string()),
    );
    options.insert(
        "sample_rate".to_string(),
        serde_json::Value::Number(settings.salute_speech_sample_rate.into()),
    );
    options.insert(
        "language".to_string(),
        serde_json::Value::String(settings.salute_speech_language.trim().to_string()),
    );
    options.insert(
        "channels_count".to_string(),
        serde_json::Value::Number(settings.salute_speech_channels_count.into()),
    );
    if settings.transcription_task == "diarize" && settings.salute_speech_model.trim() == "general"
    {
        options.insert(
            "speaker_separation_options".to_string(),
            json!({
                "enable": true
            }),
        );
    }
    let payload = json!({
      "options": serde_json::Value::Object(options),
      "request_file_id": request_file_id
    });

    let mut headers = salute_speech_bearer_headers(access_token)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let url = format!(
        "{}/rest/v1/speech:async_recognize",
        salute_speech_api_base_url()
    );
    logger.log_http_request(
        "salute_speech",
        "recognition task",
        "POST",
        &url,
        &headers,
        &HttpLogBody::Json(payload.clone()),
    );

    let res = client
        .post(&url)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            let formatted = format_salute_speech_network_error("recognition task", &e);
            logger.log_http_error(
                "salute_speech",
                "recognition task",
                "POST",
                &url,
                &formatted,
            );
            formatted
        })?;

    let body = parse_json_response(
        res,
        "salutespeech recognize",
        logger,
        "salute_speech",
        "recognition task",
    )
    .await?;
    body.get("result")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "SalutSpeech recognition response does not contain task id".to_string())
}

async fn poll_salute_speech_task(
    client: &reqwest::Client,
    access_token: &str,
    task_id: &str,
    logger: &ExternalApiLogger,
) -> Result<String, String> {
    let mut last_status = String::new();
    for _ in 0..salute_speech_status_poll_attempts() {
        let headers = salute_speech_bearer_headers(access_token)?;
        let url = format!(
            "{}/rest/v1/task:get?id={task_id}",
            salute_speech_api_base_url()
        );
        logger.log_http_request(
            "salute_speech",
            "task status",
            "GET",
            &url,
            &headers,
            &HttpLogBody::Empty,
        );
        let res = client
            .get(format!("{}/rest/v1/task:get", salute_speech_api_base_url()))
            .headers(headers)
            .query(&[("id", task_id)])
            .send()
            .await
            .map_err(|e| {
                let formatted = format_salute_speech_network_error("task status", &e);
                logger.log_http_error("salute_speech", "task status", "GET", &url, &formatted);
                formatted
            })?;

        let body = parse_json_response(
            res,
            "salutespeech task status",
            logger,
            "salute_speech",
            "task status",
        )
        .await?;
        let status = body
            .get("status")
            .and_then(|v| v.as_str())
            .or_else(|| {
                body.get("result")
                    .and_then(|v| v.get("status"))
                    .and_then(|v| v.as_str())
            })
            .unwrap_or_default();
        last_status = status.to_string();

        if status == "DONE" {
            return body
                .get("response_file_id")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    body.get("result")
                        .and_then(|v| v.get("response_file_id"))
                        .and_then(|v| v.as_str())
                })
                .map(ToString::to_string)
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| {
                    "SalutSpeech task status does not contain response_file_id".to_string()
                });
        }

        if status == "ERROR" || status == "CANCELED" {
            let detail = salute_speech_task_error_detail(&body);
            if detail.is_empty() {
                return Err(format!("SalutSpeech task finished with status {status}"));
            }
            return Err(format!(
                "SalutSpeech task finished with status {status}: {detail}"
            ));
        }

        tokio::time::sleep(std::time::Duration::from_millis(
            salute_speech_status_poll_delay_ms(),
        ))
        .await;
    }

    if last_status.is_empty() {
        Err("SalutSpeech task polling timed out".to_string())
    } else {
        Err(format!(
            "SalutSpeech task polling timed out after {} attempts; last status: {}",
            salute_speech_status_poll_attempts(),
            last_status
        ))
    }
}

fn salute_speech_status_poll_attempts() -> usize {
    std::env::var("BIGECHO_SALUTE_SPEECH_STATUS_POLL_ATTEMPTS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(SALUTE_SPEECH_STATUS_POLL_ATTEMPTS)
}

fn salute_speech_status_poll_delay_ms() -> u64 {
    std::env::var("BIGECHO_SALUTE_SPEECH_STATUS_POLL_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(SALUTE_SPEECH_STATUS_POLL_DELAY_MS)
}

fn salute_speech_task_error_detail(body: &serde_json::Value) -> String {
    for candidate in [
        body.get("error"),
        body.get("message"),
        body.get("detail"),
        body.get("result").and_then(|v| v.get("error")),
        body.get("result").and_then(|v| v.get("message")),
        body.get("result").and_then(|v| v.get("detail")),
    ] {
        match candidate {
            Some(serde_json::Value::String(text)) if !text.trim().is_empty() => {
                return text.trim().to_string();
            }
            Some(value @ serde_json::Value::Object(_))
            | Some(value @ serde_json::Value::Array(_)) => {
                let serialized = value.to_string();
                if !serialized.is_empty() && serialized != "null" {
                    return serialized;
                }
            }
            _ => {}
        }
    }

    let fallback = body.to_string();
    if fallback == "null" || fallback == "{}" {
        String::new()
    } else {
        fallback.chars().take(500).collect()
    }
}

async fn download_salute_speech_result(
    client: &reqwest::Client,
    access_token: &str,
    response_file_id: &str,
    logger: &ExternalApiLogger,
) -> Result<serde_json::Value, String> {
    let mut headers = salute_speech_bearer_headers(access_token)?;
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    let url = format!(
        "{}/rest/v1/data:download?response_file_id={response_file_id}",
        salute_speech_api_base_url()
    );
    logger.log_http_request(
        "salute_speech",
        "result download",
        "GET",
        &url,
        &headers,
        &HttpLogBody::Empty,
    );

    let res = client
        .get(format!(
            "{}/rest/v1/data:download",
            salute_speech_api_base_url()
        ))
        .headers(headers)
        .query(&[("response_file_id", response_file_id)])
        .send()
        .await
        .map_err(|e| {
            let formatted = format_salute_speech_network_error("result download", &e);
            logger.log_http_error("salute_speech", "result download", "GET", &url, &formatted);
            formatted
        })?;

    parse_json_response(
        res,
        "salutespeech download",
        logger,
        "salute_speech",
        "result download",
    )
    .await
}

fn salute_speech_auth_url() -> String {
    std::env::var("BIGECHO_SALUTE_SPEECH_AUTH_URL")
        .unwrap_or_else(|_| SALUTE_SPEECH_DEFAULT_AUTH_URL.to_string())
}

fn salute_speech_api_base_url() -> String {
    std::env::var("BIGECHO_SALUTE_SPEECH_API_URL")
        .unwrap_or_else(|_| SALUTE_SPEECH_DEFAULT_API_BASE_URL.to_string())
}

fn salute_speech_client() -> Result<reqwest::Client, String> {
    let root_cert = reqwest::Certificate::from_pem(SALUTE_SPEECH_BUNDLED_ROOT_CERT_PEM)
        .map_err(|e| format!("Failed to load bundled SalutSpeech root certificate: {e}"))?;
    reqwest::Client::builder()
        .add_root_certificate(root_cert)
        .build()
        .map_err(|e| {
            format!(
                "Failed to build SalutSpeech HTTP client: {}",
                format_reqwest_error(&e)
            )
        })
}

fn salute_speech_bearer_headers(access_token: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", access_token.trim()))
            .map_err(|e| e.to_string())?,
    );
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    Ok(headers)
}

fn salute_speech_audio_encoding(audio_path: &Path) -> Result<&'static str, String> {
    match audio_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "opus" => Ok("OPUS"),
        "mp3" => Ok("MP3"),
        "wav" => Ok("PCM_S16LE"),
        other => Err(format!(
            "SalutSpeech does not support recorded audio format {other}"
        )),
    }
}

fn salute_speech_upload_content_type(audio_path: &Path) -> Result<String, String> {
    match audio_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "opus" => Ok("audio/ogg;codecs=opus".to_string()),
        "mp3" => Ok("audio/mpeg".to_string()),
        "wav" => Ok("audio/x-pcm;bit=16".to_string()),
        other => Err(format!(
            "SalutSpeech does not support recorded audio format {other}"
        )),
    }
}

async fn parse_json_response(
    res: reqwest::Response,
    context: &str,
    logger: &ExternalApiLogger,
    service: &str,
    operation: &str,
) -> Result<serde_json::Value, String> {
    let status = res.status();
    let headers = res.headers().clone();
    let body_text = res.text().await.unwrap_or_default();
    logger.log_http_response(service, operation, &status, &headers, &body_text);

    if !status.is_success() {
        let detail = body_text.trim();
        if detail.is_empty() {
            return Err(format!("{context} failed with status {status}"));
        }
        return Err(format!("{context} failed with status {status}: {detail}"));
    }

    serde_json::from_str(&body_text).map_err(|e| format!("{context} returned invalid JSON: {e}"))
}

fn format_reqwest_error(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(err) = source {
        let text = err.to_string();
        if !text.is_empty() && !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        source = err.source();
    }
    parts.join(": ")
}

fn format_salute_speech_network_error(operation: &str, error: &reqwest::Error) -> String {
    let formatted = format_reqwest_error(error);
    if formatted.to_ascii_lowercase().contains("certificate") {
        return format!(
            "SalutSpeech {operation} failed: {formatted}. Проверьте сертификат НУЦ Минцифры для https://ngw.devices.sberbank.ru:9443/."
        );
    }
    format!("SalutSpeech {operation} failed: {formatted}")
}

fn extract_transcript_text(body: &serde_json::Value) -> Result<String, String> {
    if let Some(text) = extract_salute_speaker_transcript(body) {
        return Ok(text);
    }
    if let Some(text) = body.get("text").and_then(|v| v.as_str()) {
        return Ok(text.to_string());
    }
    if let Some(text) = body
        .get("result")
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
    {
        return Ok(text.to_string());
    }
    if let Some(text) = extract_salute_results_text(body) {
        return Ok(text);
    }
    Ok(String::new())
}

fn extract_salute_speaker_transcript(body: &serde_json::Value) -> Option<String> {
    let mut utterances = Vec::new();
    collect_salute_speaker_utterances(body, &mut utterances);
    if utterances.is_empty() {
        return None;
    }

    let mut merged: Vec<(i64, String)> = Vec::new();
    for (speaker, text) in utterances {
        if let Some((_, existing_text)) = merged
            .iter_mut()
            .find(|(speaker_id, _)| *speaker_id == speaker)
        {
            if !existing_text.is_empty() {
                existing_text.push(' ');
            }
            existing_text.push_str(&text);
            continue;
        }
        merged.push((speaker, text));
    }

    Some(
        merged
            .into_iter()
            .enumerate()
            .map(|(speaker_index, (_, text))| format!("speaker{speaker_index}: {text}"))
            .collect::<Vec<String>>()
            .join("\n\n"),
    )
}

fn collect_salute_speaker_utterances(
    body: &serde_json::Value,
    utterances: &mut Vec<(i64, String)>,
) {
    match body {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_salute_speaker_utterances(item, utterances);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(results) = map.get("results").and_then(|value| value.as_array()) {
                let speaker_id = map
                    .get("speaker_info")
                    .and_then(|value| value.get("speaker_id"))
                    .and_then(|value| value.as_i64());
                let Some(speaker_id) = speaker_id.filter(|speaker_id| *speaker_id >= 0) else {
                    if let Some(result) = map.get("result") {
                        collect_salute_speaker_utterances(result, utterances);
                    }
                    return;
                };
                for result in results {
                    let text = extract_salute_result_text(result).unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    utterances.push((speaker_id, text.to_string()));
                }
            }

            if let Some(result) = map.get("result") {
                collect_salute_speaker_utterances(result, utterances);
            }
        }
        _ => {}
    }
}

fn extract_salute_result_text(result: &serde_json::Value) -> Option<&str> {
    result
        .get("normalized_text")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            result
                .get("text")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
}

fn extract_salute_results_text(body: &serde_json::Value) -> Option<String> {
    match body {
        serde_json::Value::Array(items) => {
            let chunks: Vec<String> = items.iter().filter_map(extract_salute_chunk_text).collect();
            if chunks.is_empty() {
                None
            } else {
                Some(chunks.join("\n\n"))
            }
        }
        serde_json::Value::Object(_) => {
            if let Some(results) = body.get("results").and_then(|v| v.as_array()) {
                let parts: Vec<&str> = results
                    .iter()
                    .filter_map(extract_salute_result_text)
                    .collect();
                if !parts.is_empty() {
                    return Some(parts.join(" "));
                }
            }

            if let Some(result) = body.get("result") {
                return extract_salute_results_text(result);
            }

            None
        }
        _ => None,
    }
}

fn extract_salute_chunk_text(item: &serde_json::Value) -> Option<String> {
    if let Some(text) = item
        .get("normalized_text")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            item.get("text")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
    {
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }

    let results = item.get("results").and_then(|v| v.as_array())?;
    let parts: Vec<&str> = results
        .iter()
        .filter_map(extract_salute_result_text)
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

#[allow(dead_code)]
pub async fn summarize_text(
    settings: &PublicSettings,
    api_key: &str,
    transcript: &str,
    custom_prompt: Option<&str>,
) -> Result<String, String> {
    summarize_text_logged(
        settings,
        api_key,
        transcript,
        custom_prompt,
        &ExternalApiLogger::disabled(),
    )
    .await
}

pub(crate) fn resolve_summary_prompt<'a>(
    settings: &'a PublicSettings,
    custom_prompt: Option<&'a str>,
) -> &'a str {
    if let Some(prompt) = custom_prompt.map(str::trim).filter(|value| !value.is_empty()) {
        return prompt;
    }
    if settings.summary_prompt.trim().is_empty() {
        "Есть стенограмма встречи. Подготовь краткое саммари."
    } else {
        settings.summary_prompt.trim()
    }
}

pub async fn summarize_text_logged(
    settings: &PublicSettings,
    api_key: &str,
    transcript: &str,
    custom_prompt: Option<&str>,
    logger: &ExternalApiLogger,
) -> Result<String, String> {
    if settings.summary_url.trim().is_empty() {
        return Err("Summary URL is not configured".to_string());
    }

    let summary_prompt = resolve_summary_prompt(settings, custom_prompt);

    let payload = json!({
      "model": settings.openai_model,
      "temperature": 0.2,
      "messages": [
        {"role": "system", "content": summary_prompt},
        {"role": "user", "content": transcript}
      ]
    });

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if !api_key.trim().is_empty() {
        let bearer = format!("Bearer {}", api_key.trim());
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&bearer).map_err(|e| e.to_string())?,
        );
    }
    logger.log_http_request(
        "summary",
        "chat completions",
        "POST",
        &settings.summary_url,
        &headers,
        &HttpLogBody::Json(payload.clone()),
    );

    let client = reqwest::Client::new();
    let res = client
        .post(&settings.summary_url)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            let message = e.to_string();
            logger.log_http_error(
                "summary",
                "chat completions",
                "POST",
                &settings.summary_url,
                &message,
            );
            message
        })?;

    let body = parse_json_response(res, "summary", logger, "summary", "chat completions").await?;
    Ok(body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::public_settings::PublicSettings;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::thread;

    fn salute_speech_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn lock_salute_speech_env() -> std::sync::MutexGuard<'static, ()> {
        salute_speech_env_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
        let mut data = Vec::new();
        let mut buf = [0_u8; 4096];
        let mut header_end = None;
        let mut content_length = 0_usize;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .expect("set timeout");
        loop {
            let n = stream.read(&mut buf).expect("read request");
            if n == 0 {
                break;
            }
            data.extend_from_slice(&buf[..n]);
            if header_end.is_none() {
                if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let end = pos + 4;
                    header_end = Some(end);
                    let headers = String::from_utf8_lossy(&data[..end]);
                    for line in headers.lines() {
                        let lower = line.to_ascii_lowercase();
                        if let Some(rest) = lower.strip_prefix("content-length:") {
                            content_length = rest.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                }
            }
            if let Some(end) = header_end {
                let body_len = data.len().saturating_sub(end);
                if body_len >= content_length {
                    break;
                }
            }
        }
        data
    }

    #[test]
    fn transcribe_audio_sends_nexara_quickstart_form_fields() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let req = read_http_request(&mut stream);
            let req_str = String::from_utf8_lossy(&req).to_string();
            let body = r#"{"text":"ok"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).expect("write");
            req_str
        });

        let tmp_path =
            std::env::temp_dir().join(format!("bigecho_pipeline_{}.opus", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_path, b"fake-opus").expect("write temp opus");
        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: format!("http://{addr}/api/v1/audio/transcriptions"),
            transcription_task: "diarize".to_string(),
            transcription_diarization_setting: "meeting".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_CORP".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
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
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let out = rt
            .block_on(transcribe_audio(&settings, "nx-test-key", &tmp_path))
            .expect("transcribe ok");
        assert_eq!(out, "ok");

        let req_str = server.join().expect("join");
        let req_lower = req_str.to_ascii_lowercase();
        assert!(req_lower.contains("authorization: bearer nx-test-key"));
        assert!(req_str.contains("name=\"response_format\""));
        assert!(req_str.contains("\r\njson\r\n"));
        assert!(req_str.contains("name=\"model\""));
        assert!(req_str.contains("\r\nwhisper-1\r\n"));
        assert!(req_str.contains("name=\"task\""));
        assert!(req_str.contains("\r\ndiarize\r\n"));
        assert!(req_str.contains("name=\"diarization_setting\""));
        assert!(req_str.contains("\r\nmeeting\r\n"));
    }

    #[test]
    fn transcribe_audio_formats_diarize_segments_as_speaker_transcript() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let _req = read_http_request(&mut stream);
            let body = r#"{
                "task":"diarize",
                "language":"ru",
                "duration":12.3,
                "text":"fallback text",
                "segments":[
                    {"start":0,"end":1.1,"speaker":"speaker_0","text":"Привет"},
                    {"start":1.2,"end":2.2,"speaker":"speaker_1","text":"И тебе привет"}
                ]
            }"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).expect("write");
        });

        let tmp_path =
            std::env::temp_dir().join(format!("bigecho_pipeline_{}.opus", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_path, b"fake-opus").expect("write temp opus");
        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: format!("http://{addr}/api/v1/audio/transcriptions"),
            transcription_task: "diarize".to_string(),
            transcription_diarization_setting: "meeting".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_CORP".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
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
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let out = rt
            .block_on(transcribe_audio(&settings, "nx-test-key", &tmp_path))
            .expect("transcribe ok");
        assert_eq!(out, "speaker_0: Привет\n\nspeaker_1: И тебе привет");

        server.join().expect("join");
    }

    #[test]
    fn transcribe_audio_runs_salutespeech_async_flow() {
        let _env_guard = lock_salute_speech_env();
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let requests_for_server = Arc::clone(&requests);
        let server = thread::spawn(move || {
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().expect("accept");
                let req = read_http_request(&mut stream);
                let req_str = String::from_utf8_lossy(&req).to_string();
                requests_for_server
                    .lock()
                    .expect("lock")
                    .push(req_str.clone());

                let (content_type, body) = if req_str.starts_with("POST /api/v2/oauth ") {
                    (
                        "application/json",
                        r#"{"access_token":"salute-token","expires_at":1893456000000}"#.to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/data:upload ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"request_file_id":"request-file-1"}}"#
                            .to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/speech:async_recognize ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"id":"task-1","status":"NEW"}}"#.to_string(),
                    )
                } else if req_str.starts_with("GET /rest/v1/task:get?id=task-1 ") {
                    (
                        "application/json",
                        r#"{"status":"DONE","response_file_id":"response-file-1"}"#.to_string(),
                    )
                } else if req_str
                    .starts_with("GET /rest/v1/data:download?response_file_id=response-file-1 ")
                {
                    (
                        "application/json",
                        r#"{"text":"salute transcript"}"#.to_string(),
                    )
                } else {
                    ("text/plain", format!("unexpected request: {req_str}"))
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).expect("write");
            }
        });

        let auth_url = format!("http://{addr}/api/v2/oauth");
        let api_base_url = format!("http://{addr}");
        std::env::set_var("BIGECHO_SALUTE_SPEECH_AUTH_URL", &auth_url);
        std::env::set_var("BIGECHO_SALUTE_SPEECH_API_URL", &api_base_url);

        let tmp_path =
            std::env::temp_dir().join(format!("bigecho_pipeline_{}.opus", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_path, b"fake-opus").expect("write temp opus");
        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "salute_speech".to_string(),
            transcription_url: String::new(),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_B2B".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
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
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let out = rt
            .block_on(transcribe_audio(&settings, "salute-auth-key", &tmp_path))
            .expect("transcribe ok");
        assert_eq!(out, "salute transcript");

        std::env::remove_var("BIGECHO_SALUTE_SPEECH_AUTH_URL");
        std::env::remove_var("BIGECHO_SALUTE_SPEECH_API_URL");

        server.join().expect("join");
        let captured = requests.lock().expect("lock");
        assert_eq!(captured.len(), 5);

        let token_req = &captured[0];
        assert!(token_req.starts_with("POST /api/v2/oauth "));
        let token_req_lower = token_req.to_ascii_lowercase();
        assert!(token_req_lower.contains("authorization: basic salute-auth-key"));
        assert!(token_req_lower.contains("content-type: application/x-www-form-urlencoded"));
        assert!(token_req_lower.contains("rquid: "));
        assert!(token_req.contains("scope=SALUTE_SPEECH_B2B"));

        let upload_req = &captured[1];
        assert!(upload_req.starts_with("POST /rest/v1/data:upload "));
        assert!(upload_req
            .to_ascii_lowercase()
            .contains("authorization: bearer salute-token"));

        let recognize_req = &captured[2];
        assert!(recognize_req.starts_with("POST /rest/v1/speech:async_recognize "));
        assert!(recognize_req
            .to_ascii_lowercase()
            .contains("authorization: bearer salute-token"));
        let recognize_body = recognize_req
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value =
            serde_json::from_str(recognize_body).expect("valid json payload");
        assert_eq!(payload["request_file_id"].as_str(), Some("request-file-1"));
        assert_eq!(payload["options"]["model"].as_str(), Some("general"));
        assert_eq!(payload["options"]["audio_encoding"].as_str(), Some("OPUS"));
        assert_eq!(payload["options"]["language"].as_str(), Some("ru-RU"));
        assert_eq!(payload["options"]["sample_rate"].as_u64(), Some(48_000));
        assert_eq!(payload["options"]["channels_count"].as_u64(), Some(1));

        let status_req = &captured[3];
        assert!(status_req.starts_with("GET /rest/v1/task:get?id=task-1 "));

        let download_req = &captured[4];
        assert!(download_req
            .starts_with("GET /rest/v1/data:download?response_file_id=response-file-1 "));
    }

    #[test]
    fn transcribe_audio_reports_salutespeech_task_error_detail() {
        let _env_guard = lock_salute_speech_env();
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().expect("accept");
                let req = read_http_request(&mut stream);
                let req_str = String::from_utf8_lossy(&req).to_string();

                let (content_type, body) = if req_str.starts_with("POST /api/v2/oauth ") {
                    (
                        "application/json",
                        r#"{"access_token":"salute-token","expires_at":1893456000000}"#.to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/data:upload ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"request_file_id":"request-file-1"}}"#
                            .to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/speech:async_recognize ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"id":"task-1","status":"NEW"}}"#.to_string(),
                    )
                } else if req_str.starts_with("GET /rest/v1/task:get?id=task-1 ") {
                    (
                        "application/json",
                        r#"{"status":"ERROR","error":"unsupported audio encoding"}"#.to_string(),
                    )
                } else {
                    ("text/plain", format!("unexpected request: {req_str}"))
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).expect("write");
            }
        });

        let auth_url = format!("http://{addr}/api/v2/oauth");
        let api_base_url = format!("http://{addr}");
        std::env::set_var("BIGECHO_SALUTE_SPEECH_AUTH_URL", &auth_url);
        std::env::set_var("BIGECHO_SALUTE_SPEECH_API_URL", &api_base_url);

        let tmp_path =
            std::env::temp_dir().join(format!("bigecho_pipeline_{}.opus", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_path, b"fake-opus").expect("write temp opus");
        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "salute_speech".to_string(),
            transcription_url: String::new(),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_B2B".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
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
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let err = rt
            .block_on(transcribe_audio(&settings, "salute-auth-key", &tmp_path))
            .expect_err("transcribe must fail");
        assert!(err.contains("status ERROR"));
        assert!(err.contains("unsupported audio encoding"));

        std::env::remove_var("BIGECHO_SALUTE_SPEECH_AUTH_URL");
        std::env::remove_var("BIGECHO_SALUTE_SPEECH_API_URL");
        server.join().expect("join");
    }

    #[test]
    fn transcribe_audio_uses_actual_recorded_file_format_for_salutespeech() {
        let _env_guard = lock_salute_speech_env();
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let requests_for_server = Arc::clone(&requests);
        let server = thread::spawn(move || {
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().expect("accept");
                let req = read_http_request(&mut stream);
                let req_str = String::from_utf8_lossy(&req).to_string();
                requests_for_server
                    .lock()
                    .expect("lock")
                    .push(req_str.clone());

                let (content_type, body) = if req_str.starts_with("POST /api/v2/oauth ") {
                    (
                        "application/json",
                        r#"{"access_token":"salute-token","expires_at":1893456000000}"#.to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/data:upload ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"request_file_id":"request-file-1"}}"#
                            .to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/speech:async_recognize ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"id":"task-1","status":"NEW"}}"#.to_string(),
                    )
                } else if req_str.starts_with("GET /rest/v1/task:get?id=task-1 ") {
                    (
                        "application/json",
                        r#"{"status":"DONE","response_file_id":"response-file-1"}"#.to_string(),
                    )
                } else if req_str
                    .starts_with("GET /rest/v1/data:download?response_file_id=response-file-1 ")
                {
                    (
                        "application/json",
                        r#"{"text":"salute transcript"}"#.to_string(),
                    )
                } else {
                    ("text/plain", format!("unexpected request: {req_str}"))
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).expect("write");
            }
        });

        let auth_url = format!("http://{addr}/api/v2/oauth");
        let api_base_url = format!("http://{addr}");
        std::env::set_var("BIGECHO_SALUTE_SPEECH_AUTH_URL", &auth_url);
        std::env::set_var("BIGECHO_SALUTE_SPEECH_API_URL", &api_base_url);

        let tmp_path =
            std::env::temp_dir().join(format!("bigecho_pipeline_{}.mp3", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_path, b"fake-mp3").expect("write temp mp3");
        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "salute_speech".to_string(),
            transcription_url: String::new(),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_B2B".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
            summary_url: "https://example.com/summary".to_string(),
            summary_prompt: String::new(),
            openai_model: "gpt-4.1-mini".to_string(),
            audio_format: "wav".to_string(),
            opus_bitrate_kbps: 24,
            mic_device_name: String::new(),
            system_device_name: String::new(),
            artifact_opener_app: String::new(),
            auto_run_pipeline_on_stop: false,
            api_call_logging_enabled: false,
            auto_delete_audio_enabled: false,
            auto_delete_audio_days: 30,
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let out = rt
            .block_on(transcribe_audio(&settings, "salute-auth-key", &tmp_path))
            .expect("transcribe ok");
        assert_eq!(out, "salute transcript");

        std::env::remove_var("BIGECHO_SALUTE_SPEECH_AUTH_URL");
        std::env::remove_var("BIGECHO_SALUTE_SPEECH_API_URL");

        server.join().expect("join");
        let captured = requests.lock().expect("lock");

        let upload_req = &captured[1];
        assert!(upload_req
            .to_ascii_lowercase()
            .contains("content-type: audio/mpeg"));

        let recognize_req = &captured[2];
        let recognize_body = recognize_req
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value =
            serde_json::from_str(recognize_body).expect("valid json payload");
        assert_eq!(payload["options"]["audio_encoding"].as_str(), Some("MP3"));
    }

    #[test]
    fn transcribe_audio_allows_longer_salutespeech_polling_via_override() {
        let _env_guard = lock_salute_speech_env();
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = thread::spawn(move || {
            let mut poll_count = 0usize;
            for _ in 0..70 {
                let (mut stream, _) = listener.accept().expect("accept");
                let req = read_http_request(&mut stream);
                let req_str = String::from_utf8_lossy(&req).to_string();

                let (content_type, body) = if req_str.starts_with("POST /api/v2/oauth ") {
                    (
                        "application/json",
                        r#"{"access_token":"salute-token","expires_at":1893456000000}"#.to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/data:upload ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"request_file_id":"request-file-1"}}"#
                            .to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/speech:async_recognize ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"id":"task-1","status":"NEW"}}"#.to_string(),
                    )
                } else if req_str.starts_with("GET /rest/v1/task:get?id=task-1 ") {
                    poll_count += 1;
                    if poll_count < 66 {
                        ("application/json", r#"{"status":"NEW"}"#.to_string())
                    } else {
                        (
                            "application/json",
                            r#"{"status":"DONE","response_file_id":"response-file-1"}"#.to_string(),
                        )
                    }
                } else if req_str
                    .starts_with("GET /rest/v1/data:download?response_file_id=response-file-1 ")
                {
                    (
                        "application/json",
                        r#"{"text":"salute transcript"}"#.to_string(),
                    )
                } else {
                    ("text/plain", format!("unexpected request: {req_str}"))
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).expect("write");
            }
        });

        let auth_url = format!("http://{addr}/api/v2/oauth");
        let api_base_url = format!("http://{addr}");
        std::env::set_var("BIGECHO_SALUTE_SPEECH_AUTH_URL", &auth_url);
        std::env::set_var("BIGECHO_SALUTE_SPEECH_API_URL", &api_base_url);
        std::env::set_var("BIGECHO_SALUTE_SPEECH_STATUS_POLL_ATTEMPTS", "70");
        std::env::set_var("BIGECHO_SALUTE_SPEECH_STATUS_POLL_DELAY_MS", "0");

        let tmp_path =
            std::env::temp_dir().join(format!("bigecho_pipeline_{}.opus", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_path, b"fake-opus").expect("write temp opus");
        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "salute_speech".to_string(),
            transcription_url: String::new(),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_B2B".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
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
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let out = rt
            .block_on(transcribe_audio(&settings, "salute-auth-key", &tmp_path))
            .expect("transcribe ok");
        assert_eq!(out, "salute transcript");

        std::env::remove_var("BIGECHO_SALUTE_SPEECH_AUTH_URL");
        std::env::remove_var("BIGECHO_SALUTE_SPEECH_API_URL");
        std::env::remove_var("BIGECHO_SALUTE_SPEECH_STATUS_POLL_ATTEMPTS");
        std::env::remove_var("BIGECHO_SALUTE_SPEECH_STATUS_POLL_DELAY_MS");
        server.join().expect("join");
    }

    #[test]
    fn extract_transcript_text_reads_salutespeech_results_array() {
        let body = serde_json::json!([
            {
                "results": [
                    {"normalized_text": "привет"},
                    {"normalized_text": "мир"}
                ],
                "eou": true
            },
            {
                "results": [
                    {"normalized_text": "как дела"}
                ],
                "eou": true
            }
        ]);

        let text = extract_transcript_text(&body).expect("text");
        assert_eq!(text, "привет мир\n\nкак дела");
    }

    #[test]
    fn extract_transcript_text_formats_salutespeech_speaker_separation() {
        let body = serde_json::json!([
            {
                "results": [
                    {"normalized_text": "Привет"},
                    {"normalized_text": "как дела"}
                ],
                "speaker_info": {"speaker_id": 1}
            },
            {
                "results": [
                    {"normalized_text": "Нормально"}
                ],
                "speaker_info": {"speaker_id": 2}
            },
            {
                "results": [
                    {"normalized_text": "Отлично"}
                ],
                "speaker_info": {"speaker_id": 1}
            },
            {
                "results": [
                    {"normalized_text": "общий текст который не должен попасть в diarization transcript"}
                ],
                "speaker_info": {"speaker_id": -1}
            }
        ]);

        let text = extract_transcript_text(&body).expect("text");
        assert_eq!(
            text,
            "speaker0: Привет как дела Отлично\n\nspeaker1: Нормально"
        );
    }

    #[test]
    fn transcribe_audio_enables_salutespeech_speaker_separation_for_diarize_task() {
        let _env_guard = lock_salute_speech_env();
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let requests_for_server = Arc::clone(&requests);
        let server = thread::spawn(move || {
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().expect("accept");
                let req = read_http_request(&mut stream);
                let req_str = String::from_utf8_lossy(&req).to_string();
                requests_for_server
                    .lock()
                    .expect("lock")
                    .push(req_str.clone());

                let (content_type, body) = if req_str.starts_with("POST /api/v2/oauth ") {
                    (
                        "application/json",
                        r#"{"access_token":"salute-token","expires_at":1893456000000}"#.to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/data:upload ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"request_file_id":"request-file-1"}}"#
                            .to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/speech:async_recognize ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"id":"task-1","status":"NEW"}}"#.to_string(),
                    )
                } else if req_str.starts_with("GET /rest/v1/task:get?id=task-1 ") {
                    (
                        "application/json",
                        r#"{"status":"DONE","response_file_id":"response-file-1"}"#.to_string(),
                    )
                } else if req_str
                    .starts_with("GET /rest/v1/data:download?response_file_id=response-file-1 ")
                {
                    (
                        "application/json",
                        r#"[
                            {"results":[{"normalized_text":"Привет"}],"speaker_info":{"speaker_id":0}},
                            {"results":[{"normalized_text":"Здравствуйте"}],"speaker_info":{"speaker_id":2}}
                        ]"#
                        .to_string(),
                    )
                } else {
                    ("text/plain", format!("unexpected request: {req_str}"))
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).expect("write");
            }
        });

        let auth_url = format!("http://{addr}/api/v2/oauth");
        let api_base_url = format!("http://{addr}");
        std::env::set_var("BIGECHO_SALUTE_SPEECH_AUTH_URL", &auth_url);
        std::env::set_var("BIGECHO_SALUTE_SPEECH_API_URL", &api_base_url);

        let tmp_path =
            std::env::temp_dir().join(format!("bigecho_pipeline_{}.opus", uuid::Uuid::new_v4()));
        std::fs::write(&tmp_path, b"fake-opus").expect("write temp opus");
        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "salute_speech".to_string(),
            transcription_url: String::new(),
            transcription_task: "diarize".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_B2B".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
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
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let out = rt
            .block_on(transcribe_audio(&settings, "salute-auth-key", &tmp_path))
            .expect("transcribe ok");
        assert_eq!(out, "speaker0: Привет\n\nspeaker1: Здравствуйте");

        std::env::remove_var("BIGECHO_SALUTE_SPEECH_AUTH_URL");
        std::env::remove_var("BIGECHO_SALUTE_SPEECH_API_URL");
        server.join().expect("join");

        let captured = requests.lock().expect("lock");
        let recognize_req = &captured[2];
        let recognize_body = recognize_req
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value =
            serde_json::from_str(recognize_body).expect("valid json payload");
        assert_eq!(
            payload["options"]["speaker_separation_options"]["enable"].as_bool(),
            Some(true)
        );
    }

    #[test]
    fn summarize_text_sends_configured_system_prompt() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let req = read_http_request(&mut stream);
            let req_str = String::from_utf8_lossy(&req).to_string();
            let body = r#"{"choices":[{"message":{"content":"ok summary"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).expect("write");
            req_str
        });

        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: "https://example.com/transcribe".to_string(),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_CORP".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
            summary_url: format!("http://{addr}/summary"),
            summary_prompt: "Сделай саммари: решения, риски, action items".to_string(),
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
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let out = rt
            .block_on(summarize_text(
                &settings,
                "openai-test-key",
                "meeting transcript",
                None,
            ))
            .expect("summary ok");
        assert_eq!(out, "ok summary");

        let req_str = server.join().expect("join");
        let body = req_str
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value = serde_json::from_str(body).expect("valid json payload");
        assert_eq!(
            payload["messages"][0]["content"].as_str(),
            Some("Сделай саммари: решения, риски, action items")
        );
    }

    #[test]
    fn summarize_text_prefers_non_empty_custom_prompt_override() {
        let settings = PublicSettings {
            recording_root: "./recordings".to_string(),
            artifact_open_app: String::new(),
            transcription_provider: "nexara".to_string(),
            transcription_url: "https://example.com/transcribe".to_string(),
            transcription_task: "transcribe".to_string(),
            transcription_diarization_setting: "general".to_string(),
            salute_speech_scope: "SALUTE_SPEECH_CORP".to_string(),
            salute_speech_model: "general".to_string(),
            salute_speech_language: "ru-RU".to_string(),
            salute_speech_sample_rate: 48_000,
            salute_speech_channels_count: 1,
            summary_url: "https://example.com/summary".to_string(),
            summary_prompt: "Системный промпт".to_string(),
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
        };

        assert_eq!(
            resolve_summary_prompt(&settings, Some("  Кастомный промпт  ")),
            "Кастомный промпт"
        );
        assert_eq!(
            resolve_summary_prompt(&settings, Some("   ")),
            "Системный промпт"
        );
    }

    #[test]
    fn salutespeech_client_builds_with_bundled_root_certificate() {
        let client = salute_speech_client().expect("salutespeech client");
        let _ = client;
    }

    #[test]
    fn formats_reqwest_error_with_source_chain() {
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let err = rt.block_on(async {
            reqwest::Client::new()
                .get("http://127.0.0.1:1")
                .send()
                .await
                .expect_err("must fail")
        });
        let formatted = format_reqwest_error(&err);
        assert!(formatted.contains("error sending request") || formatted.contains("client error"));
        assert!(
            formatted.contains("Connection refused") || formatted.contains("connection refused")
        );
    }
}
