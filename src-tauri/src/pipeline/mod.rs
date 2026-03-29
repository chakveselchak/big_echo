use crate::settings::public_settings::PublicSettings;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::json;
use std::error::Error as StdError;
use std::path::Path;
use uuid::Uuid;

const SALUTE_SPEECH_DEFAULT_AUTH_URL: &str = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const SALUTE_SPEECH_DEFAULT_API_BASE_URL: &str = "https://smartspeech.sber.ru";
const SALUTE_SPEECH_STATUS_POLL_ATTEMPTS: usize = 60;
const SALUTE_SPEECH_STATUS_POLL_DELAY_MS: u64 = 250;
const SALUTE_SPEECH_BUNDLED_ROOT_CERT_PEM: &[u8] =
    include_bytes!("../../certs/russian_trusted_root_ca.cer");

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

pub async fn transcribe_audio(
    settings: &PublicSettings,
    api_key: &str,
    audio_path: &Path,
) -> Result<String, String> {
    if settings.transcription_provider == "salute_speech" {
        return transcribe_audio_with_salutespeech(settings, api_key, audio_path).await;
    }
    transcribe_audio_with_nexara(settings, api_key, audio_path).await
}

async fn transcribe_audio_with_nexara(
    settings: &PublicSettings,
    api_key: &str,
    audio_path: &Path,
) -> Result<String, String> {
    if settings.transcription_url.trim().is_empty() {
        return Err("Transcription URL is not configured".to_string());
    }

    let data = std::fs::read(audio_path).map_err(|e| e.to_string())?;
    let file_name = audio_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.opus")
        .to_string();
    let mime = crate::audio::file_writer::mime_type_for_audio_path(audio_path);

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

    let client = reqwest::Client::new();
    let res = client
        .post(&settings.transcription_url)
        .headers(headers)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("transcription failed with status {status}"));
        }
        return Err(format!(
            "transcription failed with status {status}: {}",
            detail.chars().take(280).collect::<String>()
        ));
    }

    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(formatted) = format_diarize_segments(&body) {
        return Ok(formatted);
    }
    extract_transcript_text(&body)
}

async fn transcribe_audio_with_salutespeech(
    settings: &PublicSettings,
    auth_key: &str,
    audio_path: &Path,
) -> Result<String, String> {
    if auth_key.trim().is_empty() {
        return Err("SalutSpeech authorization key is empty".to_string());
    }

    let client = salute_speech_client()?;
    let access_token = request_salute_speech_access_token(&client, auth_key, &settings.salute_speech_scope).await?;
    let request_file_id = upload_salute_speech_audio(&client, &access_token, audio_path).await?;
    let task_id =
        create_salute_speech_recognition_task(&client, &access_token, settings, audio_path, &request_file_id)
            .await?;
    let response_file_id = poll_salute_speech_task(&client, &access_token, &task_id).await?;
    let payload = download_salute_speech_result(&client, &access_token, &response_file_id).await?;
    if let Some(formatted) = format_diarize_segments(&payload) {
        return Ok(formatted);
    }
    extract_transcript_text(&payload)
}

async fn request_salute_speech_access_token(
    client: &reqwest::Client,
    auth_key: &str,
    scope: &str,
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

    let res = client
        .post(salute_speech_auth_url())
        .headers(headers)
        .form(&[("scope", scope.trim())])
        .send()
        .await
        .map_err(|e| format_salute_speech_network_error("token request", &e))?;

    let body = parse_json_response(res, "salutespeech token request").await?;
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
) -> Result<String, String> {
    let data = std::fs::read(audio_path).map_err(|e| e.to_string())?;
    let mut headers = salute_speech_bearer_headers(access_token)?;
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&salute_speech_upload_content_type(audio_path)?).map_err(|e| e.to_string())?,
    );

    let res = client
        .post(format!("{}/rest/v1/data:upload", salute_speech_api_base_url()))
        .headers(headers)
        .body(data)
        .send()
        .await
        .map_err(|e| format_salute_speech_network_error("audio upload", &e))?;

    let body = parse_json_response(res, "salutespeech upload").await?;
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
) -> Result<String, String> {
    let payload = json!({
      "options": {
        "model": settings.salute_speech_model.trim(),
        "audio_encoding": salute_speech_audio_encoding(audio_path)?,
        "sample_rate": settings.salute_speech_sample_rate,
        "language": settings.salute_speech_language.trim(),
        "channels_count": settings.salute_speech_channels_count
      },
      "request_file_id": request_file_id
    });

    let mut headers = salute_speech_bearer_headers(access_token)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let res = client
        .post(format!(
            "{}/rest/v1/speech:async_recognize",
            salute_speech_api_base_url()
        ))
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format_salute_speech_network_error("recognition task", &e))?;

    let body = parse_json_response(res, "salutespeech recognize").await?;
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
) -> Result<String, String> {
    for _ in 0..SALUTE_SPEECH_STATUS_POLL_ATTEMPTS {
        let headers = salute_speech_bearer_headers(access_token)?;
        let res = client
            .get(format!("{}/rest/v1/task:get", salute_speech_api_base_url()))
            .headers(headers)
            .query(&[("id", task_id)])
            .send()
            .await
            .map_err(|e| format_salute_speech_network_error("task status", &e))?;

        let body = parse_json_response(res, "salutespeech task status").await?;
        let status = body
            .get("status")
            .and_then(|v| v.as_str())
            .or_else(|| body.get("result").and_then(|v| v.get("status")).and_then(|v| v.as_str()))
            .unwrap_or_default();

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
                .ok_or_else(|| "SalutSpeech task status does not contain response_file_id".to_string());
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
            SALUTE_SPEECH_STATUS_POLL_DELAY_MS,
        ))
        .await;
    }

    Err("SalutSpeech task polling timed out".to_string())
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
            Some(value @ serde_json::Value::Object(_)) | Some(value @ serde_json::Value::Array(_)) => {
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
) -> Result<serde_json::Value, String> {
    let mut headers = salute_speech_bearer_headers(access_token)?;
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));

    let res = client
        .get(format!(
            "{}/rest/v1/data:download",
            salute_speech_api_base_url()
        ))
        .headers(headers)
        .query(&[("response_file_id", response_file_id)])
        .send()
        .await
        .map_err(|e| format_salute_speech_network_error("result download", &e))?;

    parse_json_response(res, "salutespeech download").await
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
        .map_err(|e| format!("Failed to build SalutSpeech HTTP client: {}", format_reqwest_error(&e)))
}

fn salute_speech_bearer_headers(access_token: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", access_token.trim())).map_err(|e| e.to_string())?,
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
        other => Err(format!("SalutSpeech does not support recorded audio format {other}")),
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
        other => Err(format!("SalutSpeech does not support recorded audio format {other}")),
    }
}

async fn parse_json_response(res: reqwest::Response, context: &str) -> Result<serde_json::Value, String> {
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("{context} failed with status {status}"));
        }
        return Err(format!(
            "{context} failed with status {status}: {}",
            detail.chars().take(280).collect::<String>()
        ));
    }

    res.json().await.map_err(|e| e.to_string())
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
    Ok(body
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

pub async fn summarize_text(
    settings: &PublicSettings,
    api_key: &str,
    transcript: &str,
) -> Result<String, String> {
    if settings.summary_url.trim().is_empty() {
        return Err("Summary URL is not configured".to_string());
    }

    let summary_prompt = if settings.summary_prompt.trim().is_empty() {
        "Есть стенограмма встречи. Подготовь краткое саммари."
    } else {
        settings.summary_prompt.trim()
    };

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

    let client = reqwest::Client::new();
    let res = client
        .post(&settings.summary_url)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("summary failed with status {}", res.status()));
    }

    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
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
        let _env_guard = salute_speech_env_lock().lock().expect("env lock");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let requests_for_server = Arc::clone(&requests);
        let server = thread::spawn(move || {
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().expect("accept");
                let req = read_http_request(&mut stream);
                let req_str = String::from_utf8_lossy(&req).to_string();
                requests_for_server.lock().expect("lock").push(req_str.clone());

                let (content_type, body) = if req_str.starts_with("POST /api/v2/oauth ") {
                    (
                        "application/json",
                        r#"{"access_token":"salute-token","expires_at":1893456000000}"#.to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/data:upload ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"request_file_id":"request-file-1"}}"#.to_string(),
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
                } else if req_str.starts_with("GET /rest/v1/data:download?response_file_id=response-file-1 ") {
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
        assert!(upload_req.to_ascii_lowercase().contains("authorization: bearer salute-token"));

        let recognize_req = &captured[2];
        assert!(recognize_req.starts_with("POST /rest/v1/speech:async_recognize "));
        assert!(recognize_req.to_ascii_lowercase().contains("authorization: bearer salute-token"));
        let recognize_body = recognize_req
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value = serde_json::from_str(recognize_body).expect("valid json payload");
        assert_eq!(payload["request_file_id"].as_str(), Some("request-file-1"));
        assert_eq!(payload["options"]["model"].as_str(), Some("general"));
        assert_eq!(payload["options"]["audio_encoding"].as_str(), Some("OPUS"));
        assert_eq!(payload["options"]["language"].as_str(), Some("ru-RU"));
        assert_eq!(payload["options"]["sample_rate"].as_u64(), Some(48_000));
        assert_eq!(payload["options"]["channels_count"].as_u64(), Some(1));

        let status_req = &captured[3];
        assert!(status_req.starts_with("GET /rest/v1/task:get?id=task-1 "));

        let download_req = &captured[4];
        assert!(download_req.starts_with(
            "GET /rest/v1/data:download?response_file_id=response-file-1 "
        ));
    }

    #[test]
    fn transcribe_audio_reports_salutespeech_task_error_detail() {
        let _env_guard = salute_speech_env_lock().lock().expect("env lock");
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
                        r#"{"status":200,"result":{"request_file_id":"request-file-1"}}"#.to_string(),
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
        let _env_guard = salute_speech_env_lock().lock().expect("env lock");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let requests_for_server = Arc::clone(&requests);
        let server = thread::spawn(move || {
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().expect("accept");
                let req = read_http_request(&mut stream);
                let req_str = String::from_utf8_lossy(&req).to_string();
                requests_for_server.lock().expect("lock").push(req_str.clone());

                let (content_type, body) = if req_str.starts_with("POST /api/v2/oauth ") {
                    (
                        "application/json",
                        r#"{"access_token":"salute-token","expires_at":1893456000000}"#.to_string(),
                    )
                } else if req_str.starts_with("POST /rest/v1/data:upload ") {
                    (
                        "application/json",
                        r#"{"status":200,"result":{"request_file_id":"request-file-1"}}"#.to_string(),
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
                } else if req_str.starts_with("GET /rest/v1/data:download?response_file_id=response-file-1 ") {
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
        assert!(upload_req.to_ascii_lowercase().contains("content-type: audio/mpeg"));

        let recognize_req = &captured[2];
        let recognize_body = recognize_req
            .split("\r\n\r\n")
            .nth(1)
            .expect("http request body should exist");
        let payload: serde_json::Value = serde_json::from_str(recognize_body).expect("valid json payload");
        assert_eq!(payload["options"]["audio_encoding"].as_str(), Some("MP3"));
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
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let out = rt
            .block_on(summarize_text(
                &settings,
                "openai-test-key",
                "meeting transcript",
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
        assert!(formatted.contains("Connection refused") || formatted.contains("connection refused"));
    }
}
