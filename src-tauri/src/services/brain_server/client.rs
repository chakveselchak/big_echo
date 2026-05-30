use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use thiserror::Error;

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const MIN_REDACT_TOKEN_LEN: usize = 20;

#[derive(Debug, Clone, Serialize)]
pub struct BrainUploadMetadata {
    pub session_id: String,
    pub title: String,
    pub topic: String,
    pub tags: Vec<String>,
    pub notes: String,
    pub source: String,
    pub started_at_iso: String,
    pub audio_format: String,
    pub app: String,
    pub app_version: String,
    pub client_device_label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BrainUploadResponse {
    pub ok: bool,
    pub job_id: Option<i64>,
    pub status: Option<String>,
    pub principal_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_slug: Option<String>,
    pub inbox_path: Option<String>,
    pub meta_path: Option<String>,
    pub duplicate: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Error)]
pub enum BrainUploadError {
    #[error("unauthorized (401): {body_preview}")]
    Unauthorized { body_preview: String },
    #[error("forbidden (403): {body_preview}")]
    Forbidden { body_preview: String },
    #[error("payload too large (413): {body_preview}")]
    PayloadTooLarge { body_preview: String },
    #[error("unsupported media type (415): {body_preview}")]
    UnsupportedMediaType { body_preview: String },
    #[error("server error ({status}): {body_preview}")]
    Server {
        status: u16,
        body_preview: String,
    },
    #[error("http error ({status}): {body_preview}")]
    Http {
        status: u16,
        body_preview: String,
    },
    #[error("network error: {0}")]
    Network(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("json error: {0}")]
    Json(String),
    #[error("api error: {0}")]
    Api(String),
}

fn content_type_for_audio_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("opus") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn looks_like_secret_fragment(part: &str) -> bool {
    if part.len() < MIN_REDACT_TOKEN_LEN {
        return false;
    }
    part.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '=' | '+' | '/' | '.'))
}

fn body_preview(raw: &str, token: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 200;

    let exact_redacted = if token.is_empty() {
        raw.to_string()
    } else {
        raw.replace(token, "[redacted]")
    };
    let normalized = exact_redacted
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>();
    let mut sanitized = Vec::new();
    for part in normalized.split_whitespace() {
        let lowered = part.to_ascii_lowercase();
        if lowered.contains("token")
            || lowered.contains("secret")
            || lowered.contains("authorization")
            || lowered.contains("bearer")
            || part.contains('@')
            || looks_like_secret_fragment(part)
        {
            sanitized.push("[redacted]");
        } else {
            sanitized.push(part);
        }
    }

    let collapsed = sanitized.join(" ");
    let mut preview = collapsed.chars().take(MAX_PREVIEW_CHARS).collect::<String>();
    if collapsed.chars().count() > MAX_PREVIEW_CHARS {
        preview.push_str("...");
    }
    preview
}

#[derive(Clone)]
pub struct BrainServerClient {
    http: reqwest::Client,
}

impl BrainServerClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
                .build()
                .expect("Brain upload HTTP client should build"),
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_timeouts(connect_timeout: Duration, request_timeout: Duration) -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .build()
                .expect("Brain upload HTTP client should build"),
        }
    }

    pub async fn upload_audio(
        &self,
        url: &str,
        token: &str,
        audio_path: &Path,
        metadata: &BrainUploadMetadata,
    ) -> Result<BrainUploadResponse, BrainUploadError> {
        let data = std::fs::read(audio_path).map_err(|e| BrainUploadError::Io(e.to_string()))?;
        let file_name = audio_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("audio")
            .to_string();
        let metadata_json =
            serde_json::to_string(metadata).map_err(|e| BrainUploadError::Json(e.to_string()))?;

        let file_part = reqwest::multipart::Part::bytes(data)
            .file_name(file_name)
            .mime_str(content_type_for_audio_path(audio_path))
            .map_err(|e| BrainUploadError::Io(e.to_string()))?;
        let metadata_part = reqwest::multipart::Part::text(metadata_json)
            .mime_str("application/json")
            .map_err(|e| BrainUploadError::Json(e.to_string()))?;
        let form = reqwest::multipart::Form::new()
            .part("file", file_part)
            .part("metadata", metadata_part);

        let response = self
            .http
            .post(url)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .multipart(form)
            .send()
            .await
            .map_err(|e| BrainUploadError::Network(e.to_string()))?;

        let status = response.status();
        let status_u16 = status.as_u16();
        let body = response
            .text()
            .await
            .map_err(|e| BrainUploadError::Network(e.to_string()))?;

        match status_u16 {
            200 | 201 => {
                let parsed: BrainUploadResponse = serde_json::from_str(&body)
                    .map_err(|e| BrainUploadError::Json(e.to_string()))?;
                if parsed.ok || parsed.duplicate.unwrap_or(false) {
                    Ok(parsed)
                } else {
                    Err(BrainUploadError::Api(
                        parsed.error.unwrap_or_else(|| "upload was not accepted".to_string()),
                    ))
                }
            }
            401 => Err(BrainUploadError::Unauthorized {
                body_preview: body_preview(&body, token),
            }),
            403 => Err(BrainUploadError::Forbidden {
                body_preview: body_preview(&body, token),
            }),
            413 => Err(BrainUploadError::PayloadTooLarge {
                body_preview: body_preview(&body, token),
            }),
            415 => Err(BrainUploadError::UnsupportedMediaType {
                body_preview: body_preview(&body, token),
            }),
            500..=599 => Err(BrainUploadError::Server {
                status: status_u16,
                body_preview: body_preview(&body, token),
            }),
            _ => Err(BrainUploadError::Http {
                status: status_u16,
                body_preview: body_preview(&body, token),
            }),
        }
    }
}

impl Default for BrainServerClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

    fn sample_metadata() -> BrainUploadMetadata {
        BrainUploadMetadata {
            session_id: "session-1".to_string(),
            title: "Daily notes".to_string(),
            topic: "planning".to_string(),
            tags: vec!["work".to_string(), "voice".to_string()],
            notes: "remember follow-up".to_string(),
            source: "microphone".to_string(),
            started_at_iso: "2026-05-28T10:00:00Z".to_string(),
            audio_format: "opus".to_string(),
            app: "BigEcho".to_string(),
            app_version: "2.4.1".to_string(),
            client_device_label: Some("MacBook".to_string()),
        }
    }

    fn audio_file() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join("audio.opus");
        std::fs::File::create(&path)
            .expect("create audio")
            .write_all(b"audio-bytes")
            .expect("write audio");
        (tmp, path)
    }

    fn audio_file_with_name(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempdir().expect("tempdir");
        let path = tmp.path().join(name);
        std::fs::File::create(&path)
            .expect("create audio")
            .write_all(b"audio-bytes")
            .expect("write audio");
        (tmp, path)
    }

    struct MultipartBodyContains {
        needles: Vec<&'static str>,
        forbidden: Vec<&'static str>,
    }

    impl Match for MultipartBodyContains {
        fn matches(&self, request: &Request) -> bool {
            let is_multipart = request
                .headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("multipart/form-data; boundary="));
            if !is_multipart {
                return false;
            }
            let Ok(body) = std::str::from_utf8(&request.body) else {
                return false;
            };
            self.needles.iter().all(|needle| body.contains(needle))
                && self.forbidden.iter().all(|needle| !body.contains(needle))
        }
    }

    #[tokio::test]
    async fn upload_audio_sends_bearer_header_and_multipart_metadata() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();

        Mock::given(method("POST"))
            .and(path("/upload"))
            .and(header("Authorization", "Bearer secret-token"))
            .and(MultipartBodyContains {
                needles: vec![
                    "name=\"file\"",
                    "name=\"metadata\"",
                    "\"session_id\":\"session-1\"",
                    "\"title\":\"Daily notes\"",
                    "\"tags\":[\"work\",\"voice\"]",
                ],
                forbidden: vec![
                    "principal_id",
                    "workspace_id",
                    "workspace_slug",
                    "inbox_path",
                    "meta_path",
                ],
            })
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "ok": true,
                "job_id": 42,
                "status": "queued"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let response = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect("upload should succeed");

        assert!(response.ok);
        assert_eq!(response.job_id, Some(42));
        assert_eq!(response.status.as_deref(), Some("queued"));
    }

    #[tokio::test]
    async fn upload_audio_sets_multipart_part_content_types() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file_with_name("audio.mp3");

        Mock::given(method("POST"))
            .and(path("/upload"))
            .and(MultipartBodyContains {
                needles: vec![
                    "name=\"file\"",
                    "filename=\"audio.mp3\"",
                    "Content-Type: audio/mpeg",
                    "name=\"metadata\"",
                    "Content-Type: application/json",
                ],
                forbidden: vec![],
            })
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "ok": true
            })))
            .expect(1)
            .mount(&server)
            .await;

        BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect("upload should succeed");
    }

    #[tokio::test]
    async fn upload_audio_uses_opus_multipart_content_type_for_opus_files() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file_with_name("audio.opus");

        Mock::given(method("POST"))
            .and(path("/upload"))
            .and(MultipartBodyContains {
                needles: vec![
                    "name=\"file\"",
                    "filename=\"audio.opus\"",
                    "Content-Type: audio/ogg",
                ],
                forbidden: vec!["Content-Type: audio/opus"],
            })
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "ok": true
            })))
            .expect(1)
            .mount(&server)
            .await;

        BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect("upload should succeed");
    }

    #[tokio::test]
    async fn upload_audio_returns_network_error_when_request_times_out() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();

        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(
                ResponseTemplate::new(201)
                    .set_delay(Duration::from_millis(200))
                    .set_body_json(serde_json::json!({ "ok": true })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::with_timeouts(
            Duration::from_millis(50),
            Duration::from_millis(50),
        )
        .upload_audio(
            &format!("{}/upload", server.uri()),
            "secret-token",
            &audio_path,
            &sample_metadata(),
        )
        .await
        .expect_err("slow response should time out");

        assert!(matches!(err, BrainUploadError::Network(_)));
    }

    #[tokio::test]
    async fn upload_audio_treats_200_duplicate_as_success() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ok": true,
                "duplicate": true
            })))
            .expect(1)
            .mount(&server)
            .await;

        let response = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect("duplicate response is success");

        assert!(response.ok);
        assert_eq!(response.duplicate, Some(true));
    }

    #[tokio::test]
    async fn upload_audio_treats_ordinary_200_ok_as_success() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ok": true,
                "job_id": 7,
                "status": "queued"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let response = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect("ordinary 200 ok response is success");

        assert!(response.ok);
        assert_eq!(response.job_id, Some(7));
        assert_eq!(response.status.as_deref(), Some("queued"));
        assert_eq!(response.duplicate, None);
    }

    #[tokio::test]
    async fn upload_audio_maps_401_to_unauthorized_error() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(401).set_body_string("bad token"))
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("401 should fail");

        assert!(matches!(err, BrainUploadError::Unauthorized { .. }));
    }

    #[tokio::test]
    async fn upload_audio_maps_403_to_forbidden_error() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(403).set_body_string("forbidden"))
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("403 should fail");

        assert!(matches!(err, BrainUploadError::Forbidden { .. }));
    }

    #[tokio::test]
    async fn upload_audio_maps_413_to_payload_too_large_error() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(413).set_body_string("too large"))
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("413 should fail");

        assert!(matches!(
            err,
            BrainUploadError::PayloadTooLarge { ref body_preview } if body_preview == "too large"
        ));
    }

    #[tokio::test]
    async fn upload_audio_error_display_uses_sanitized_truncated_body_preview() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        let raw_body = format!(
            "token=SECRET-123\nemail=user@example.com\n{}",
            "x".repeat(260)
        );
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(413).set_body_string(raw_body.clone()))
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("413 should fail");

        let display = err.to_string();
        assert!(!display.contains("SECRET-123"));
        assert!(!display.contains("user@example.com"));
        assert!(!display.contains('\n'));
        assert!(display.contains("[redacted]"));
        assert!(display.len() < raw_body.len());
    }

    #[tokio::test]
    async fn upload_audio_redacts_exact_long_token_before_truncating_body_preview() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        let token = format!("raw-auth-{}", "A".repeat(260));
        let raw_body = format!("server echoed {token} after auth failure");
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(500).set_body_string(raw_body))
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                &token,
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("5xx should fail");

        let display = err.to_string();
        assert!(!display.contains(&token));
        assert!(!display.contains(&token[..80]));
        assert!(display.contains("[redacted]"));
    }

    #[tokio::test]
    async fn upload_audio_maps_415_to_unsupported_media_type_error() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(415).set_body_string("unsupported"))
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("415 should fail");

        assert!(matches!(
            err,
            BrainUploadError::UnsupportedMediaType { ref body_preview } if body_preview == "unsupported"
        ));
    }

    #[tokio::test]
    async fn upload_audio_maps_5xx_to_server_error() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(503).set_body_string("try later"))
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("5xx should fail");

        assert!(matches!(
            err,
            BrainUploadError::Server {
                status: 503,
                ref body_preview
            } if body_preview == "try later"
        ));
    }

    #[tokio::test]
    async fn upload_audio_maps_invalid_success_json_to_json_error() {
        let server = MockServer::start().await;
        let (_tmp, audio_path) = audio_file();
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not-json"))
            .expect(1)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("invalid json should fail");

        assert!(matches!(err, BrainUploadError::Json(_)));
    }

    #[tokio::test]
    async fn upload_audio_maps_connect_failure_to_network_error() {
        let (_tmp, audio_path) = audio_file();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind local port");
        let addr = listener.local_addr().expect("local addr");
        drop(listener);

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("http://{addr}/upload"),
                "secret-token",
                &audio_path,
                &sample_metadata(),
            )
            .await
            .expect_err("closed local port should fail");

        assert!(matches!(err, BrainUploadError::Network(_)));
    }

    #[tokio::test]
    async fn upload_audio_missing_local_file_returns_io_before_http() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(201))
            .expect(0)
            .mount(&server)
            .await;

        let err = BrainServerClient::new()
            .upload_audio(
                &format!("{}/upload", server.uri()),
                "secret-token",
                std::path::Path::new("/missing/audio.opus"),
                &sample_metadata(),
            )
            .await
            .expect_err("missing file should fail");

        assert!(matches!(err, BrainUploadError::Io(_)));
    }
}
