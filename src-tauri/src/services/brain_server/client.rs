use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Error)]
pub enum BrainUploadError {
    #[error("unauthorized (401): {body}")]
    Unauthorized { body: String },
    #[error("forbidden (403): {body}")]
    Forbidden { body: String },
    #[error("payload too large (413): {body}")]
    PayloadTooLarge { body: String },
    #[error("unsupported media type (415): {body}")]
    UnsupportedMediaType { body: String },
    #[error("server error ({status}): {body}")]
    Server { status: u16, body: String },
    #[error("http error ({status}): {body}")]
    Http { status: u16, body: String },
    #[error("network error: {0}")]
    Network(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("json error: {0}")]
    Json(String),
    #[error("api error: {0}")]
    Api(String),
}

pub struct BrainServerClient {
    http: reqwest::Client,
}

impl BrainServerClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
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

        let file_part = reqwest::multipart::Part::bytes(data).file_name(file_name);
        let form = reqwest::multipart::Form::new()
            .part("file", file_part)
            .text("metadata", metadata_json);

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
            401 => Err(BrainUploadError::Unauthorized { body }),
            403 => Err(BrainUploadError::Forbidden { body }),
            413 => Err(BrainUploadError::PayloadTooLarge { body }),
            415 => Err(BrainUploadError::UnsupportedMediaType { body }),
            500..=599 => Err(BrainUploadError::Server {
                status: status_u16,
                body,
            }),
            _ => Err(BrainUploadError::Http {
                status: status_u16,
                body,
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
