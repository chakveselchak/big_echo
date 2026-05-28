use crate::commands::brain_sync::TOKEN_KEY;
use crate::domain::session::SessionMeta;
use crate::services::brain_server::client::{
    BrainServerClient, BrainUploadError, BrainUploadMetadata, BrainUploadResponse,
};
use crate::settings::public_settings::PublicSettings;
use crate::settings::secret_store::get_secret;
use crate::storage::sqlite_repo::add_event;
use async_trait::async_trait;
use std::path::{Path, PathBuf};

#[async_trait]
pub(crate) trait UploadAudioClient {
    async fn upload_audio(
        &self,
        url: &str,
        token: &str,
        audio_path: &Path,
        metadata: &BrainUploadMetadata,
    ) -> Result<BrainUploadResponse, BrainUploadError>;
}

#[async_trait]
impl UploadAudioClient for BrainServerClient {
    async fn upload_audio(
        &self,
        url: &str,
        token: &str,
        audio_path: &Path,
        metadata: &BrainUploadMetadata,
    ) -> Result<BrainUploadResponse, BrainUploadError> {
        BrainServerClient::upload_audio(self, url, token, audio_path, metadata).await
    }
}

fn skipped_response() -> BrainUploadResponse {
    BrainUploadResponse {
        ok: true,
        job_id: None,
        status: Some("skipped".to_string()),
        principal_id: None,
        workspace_id: None,
        workspace_slug: None,
        inbox_path: None,
        meta_path: None,
        duplicate: None,
        error: None,
    }
}

pub(crate) fn validate_upload_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Invalid Brain sync URL".to_string());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "Invalid Brain sync URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Invalid Brain sync URL".to_string());
    }
    Ok(trimmed.to_string())
}

fn audio_format_from_path(path: &Path, fallback: &str) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn upload_metadata(
    meta: &SessionMeta,
    audio_path: &Path,
    settings: &PublicSettings,
) -> BrainUploadMetadata {
    let title = if meta.topic.trim().is_empty() {
        meta.session_id.clone()
    } else {
        meta.topic.clone()
    };
    BrainUploadMetadata {
        session_id: meta.session_id.clone(),
        title: title.clone(),
        topic: meta.topic.clone(),
        tags: meta.tags.clone(),
        notes: meta.notes.clone(),
        source: meta.source.clone(),
        started_at_iso: meta.started_at_iso.clone(),
        audio_format: audio_format_from_path(audio_path, &settings.audio_format),
        app: "BigEcho".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        client_device_label: None,
    }
}

pub(crate) fn sanitize_error(raw: String, token: &str) -> String {
    if token.is_empty() {
        raw
    } else {
        raw.replace(token, "[redacted]")
    }
}

fn record_failed_event(
    app_data_dir: &Path,
    session_id: &str,
    error: String,
    token: &str,
) -> String {
    let safe_error = sanitize_error(error, token);
    let _ = add_event(
        app_data_dir,
        session_id,
        "brain_upload_failed",
        &safe_error,
    );
    safe_error
}

pub(crate) async fn upload_session_after_record_with_client<C: UploadAudioClient + Sync>(
    app_data_dir: PathBuf,
    _session_dir: PathBuf,
    meta: SessionMeta,
    audio_path: PathBuf,
    settings: PublicSettings,
    client: &C,
    respect_enabled: bool,
) -> Result<BrainUploadResponse, String> {
    if respect_enabled && !settings.brain_sync_enabled {
        return Ok(skipped_response());
    }

    let url = validate_upload_url(&settings.brain_sync_url).map_err(|err| {
        record_failed_event(&app_data_dir, &meta.session_id, err, "")
    })?;
    let token = get_secret(&app_data_dir, TOKEN_KEY).map_err(|_| {
        record_failed_event(
            &app_data_dir,
            &meta.session_id,
            "Brain sync token is not configured".to_string(),
            "",
        )
    })?;
    if token.trim().is_empty() {
        return Err(record_failed_event(
            &app_data_dir,
            &meta.session_id,
            "Brain sync token is not configured".to_string(),
            "",
        ));
    }

    let metadata = upload_metadata(&meta, &audio_path, &settings);
    add_event(
        &app_data_dir,
        &meta.session_id,
        "brain_upload_started",
        "Uploading audio to Brain",
    )?;

    match client
        .upload_audio(&url, token.trim(), &audio_path, &metadata)
        .await
    {
        Ok(response) => {
            add_event(
                &app_data_dir,
                &meta.session_id,
                "brain_upload_succeeded",
                "Brain upload accepted",
            )?;
            Ok(response)
        }
        Err(err) => {
            let safe_error = record_failed_event(
                &app_data_dir,
                &meta.session_id,
                err.to_string(),
                token.trim(),
            );
            Err(safe_error)
        }
    }
}

pub async fn upload_session_after_record(
    app_data_dir: PathBuf,
    session_dir: PathBuf,
    meta: SessionMeta,
    audio_path: PathBuf,
    settings: PublicSettings,
) -> Result<BrainUploadResponse, String> {
    let client = BrainServerClient::new();
    upload_session_after_record_with_client(
        app_data_dir,
        session_dir,
        meta,
        audio_path,
        settings,
        &client,
        true,
    )
    .await
}

pub(crate) async fn upload_session_after_record_even_when_disabled(
    app_data_dir: PathBuf,
    session_dir: PathBuf,
    meta: SessionMeta,
    audio_path: PathBuf,
    settings: PublicSettings,
) -> Result<BrainUploadResponse, String> {
    let client = BrainServerClient::new();
    upload_session_after_record_with_client(
        app_data_dir,
        session_dir,
        meta,
        audio_path,
        settings,
        &client,
        false,
    )
    .await
}

#[cfg(test)]
mod tests {
    use crate::commands::brain_sync::TOKEN_KEY;
    use crate::domain::session::{SessionMeta, SessionStatus};
    use crate::services::brain_server::client::{
        BrainServerClient, BrainUploadError, BrainUploadMetadata, BrainUploadResponse,
    };
    use crate::settings::public_settings::PublicSettings;
    use crate::settings::secret_store::set_secret;
    use crate::storage::sqlite_repo::list_session_events;
    use async_trait::async_trait;
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Default)]
    struct RecordingUploadClient {
        calls: Arc<Mutex<Vec<(String, String, String, BrainUploadMetadata)>>>,
        result: Option<Result<BrainUploadResponse, BrainUploadError>>,
    }

    #[async_trait]
    impl super::UploadAudioClient for RecordingUploadClient {
        async fn upload_audio(
            &self,
            url: &str,
            token: &str,
            audio_path: &Path,
            metadata: &BrainUploadMetadata,
        ) -> Result<BrainUploadResponse, BrainUploadError> {
            self.calls.lock().expect("calls lock").push((
                url.to_string(),
                token.to_string(),
                audio_path.to_string_lossy().to_string(),
                metadata.clone(),
            ));
            self.result.clone().expect("mock result")
        }
    }

    fn sample_meta() -> SessionMeta {
        let mut meta = SessionMeta::new(
            "session-upload".to_string(),
            "zoom".to_string(),
            vec!["team".to_string(), "weekly".to_string()],
            "Weekly sync".to_string(),
            "Remember risks".to_string(),
        );
        meta.started_at_iso = "2026-05-28T10:00:00+03:00".to_string();
        meta.status = SessionStatus::Recorded;
        meta
    }

    fn enabled_settings(url: String) -> PublicSettings {
        PublicSettings {
            brain_sync_enabled: true,
            brain_sync_url: url,
            audio_format: "opus".to_string(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn upload_orchestration_builds_metadata_and_records_started_succeeded_events() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let audio_path = session_dir.join("audio.opus");
        std::fs::write(&audio_path, b"OggS").expect("write audio");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let client = RecordingUploadClient {
            calls: Arc::clone(&calls),
            result: Some(Ok(BrainUploadResponse {
                ok: true,
                job_id: Some(77),
                status: Some("queued".to_string()),
                principal_id: None,
                workspace_id: None,
                workspace_slug: None,
                inbox_path: None,
                meta_path: None,
                duplicate: None,
                error: None,
            })),
        };

        let response = super::upload_session_after_record_with_client(
            app_data_dir.clone(),
            session_dir,
            sample_meta(),
            audio_path.clone(),
            enabled_settings("https://brain.example/upload".to_string()),
            &client,
            true,
        )
        .await
        .expect("upload succeeds");

        assert_eq!(response.job_id, Some(77));
        let calls = calls.lock().expect("calls lock");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "https://brain.example/upload");
        assert_eq!(calls[0].1, "secret-token");
        assert_eq!(calls[0].2, audio_path.to_string_lossy().to_string());
        assert_eq!(calls[0].3.session_id, "session-upload");
        assert_eq!(calls[0].3.title, "Weekly sync");
        assert_eq!(calls[0].3.topic, "Weekly sync");
        assert_eq!(calls[0].3.tags, vec!["team".to_string(), "weekly".to_string()]);
        assert_eq!(calls[0].3.notes, "Remember risks");
        assert_eq!(calls[0].3.source, "zoom");
        assert_eq!(calls[0].3.started_at_iso, "2026-05-28T10:00:00+03:00");
        assert_eq!(calls[0].3.audio_format, "opus");
        assert_eq!(calls[0].3.app, "BigEcho");
        assert_eq!(calls[0].3.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(calls[0].3.client_device_label, None);

        let events =
            list_session_events(&app_data_dir, "session-upload").expect("load session events");
        let event_types = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            event_types,
            vec!["brain_upload_started", "brain_upload_succeeded"]
        );
    }

    #[tokio::test]
    async fn upload_orchestration_records_failed_event_without_exposing_token() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let audio_path = session_dir.join("audio.opus");
        std::fs::write(&audio_path, b"OggS").expect("write audio");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        let client = RecordingUploadClient {
            calls: Arc::new(Mutex::new(Vec::new())),
            result: Some(Err(BrainUploadError::Api(
                "server echoed secret-token".to_string(),
            ))),
        };

        let err = super::upload_session_after_record_with_client(
            app_data_dir.clone(),
            session_dir,
            sample_meta(),
            audio_path,
            enabled_settings("https://brain.example/upload".to_string()),
            &client,
            true,
        )
        .await
        .expect_err("upload fails");

        assert!(!err.contains("secret-token"));
        let events =
            list_session_events(&app_data_dir, "session-upload").expect("load session events");
        let failed = events
            .iter()
            .find(|event| event.event_type == "brain_upload_failed")
            .expect("failed event");
        assert!(!failed.detail.contains("secret-token"));
    }

    #[tokio::test]
    async fn upload_orchestration_redacts_long_token_before_failed_event_persistence() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let audio_path = session_dir.join("audio.opus");
        std::fs::write(&audio_path, b"OggS").expect("write audio");
        let token = format!("raw-auth-{}", "A".repeat(260));
        set_secret(&app_data_dir, TOKEN_KEY, &token).expect("set token");

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(
                ResponseTemplate::new(500)
                    .set_body_string(format!("server echoed {token} after auth failure")),
            )
            .expect(1)
            .mount(&server)
            .await;

        let err = super::upload_session_after_record_with_client(
            app_data_dir.clone(),
            session_dir,
            sample_meta(),
            audio_path,
            enabled_settings(format!("{}/upload", server.uri())),
            &BrainServerClient::new(),
            true,
        )
        .await
        .expect_err("upload fails");

        assert!(!err.contains(&token));
        assert!(!err.contains(&token[..80]));
        let events =
            list_session_events(&app_data_dir, "session-upload").expect("load session events");
        let failed = events
            .iter()
            .find(|event| event.event_type == "brain_upload_failed")
            .expect("failed event");
        assert!(!failed.detail.contains(&token));
        assert!(!failed.detail.contains(&token[..80]));
    }

    #[tokio::test]
    async fn upload_orchestration_records_failed_event_for_invalid_url() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let audio_path = session_dir.join("audio.opus");
        std::fs::write(&audio_path, b"OggS").expect("write audio");
        set_secret(&app_data_dir, TOKEN_KEY, "secret-token").expect("set token");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let client = RecordingUploadClient {
            calls: Arc::clone(&calls),
            result: Some(Ok(BrainUploadResponse {
                ok: true,
                job_id: None,
                status: None,
                principal_id: None,
                workspace_id: None,
                workspace_slug: None,
                inbox_path: None,
                meta_path: None,
                duplicate: None,
                error: None,
            })),
        };

        let err = super::upload_session_after_record_with_client(
            app_data_dir.clone(),
            session_dir,
            sample_meta(),
            audio_path,
            enabled_settings("not-a-url".to_string()),
            &client,
            true,
        )
        .await
        .expect_err("invalid url should fail");

        assert_eq!(err, "Invalid Brain sync URL");
        assert!(calls.lock().expect("calls lock").is_empty());
        let events =
            list_session_events(&app_data_dir, "session-upload").expect("load session events");
        let event_types = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>();
        assert_eq!(event_types, vec!["brain_upload_failed"]);
        assert_eq!(events[0].detail, "Invalid Brain sync URL");
        assert!(!events[0].detail.contains("secret-token"));
    }

    #[tokio::test]
    async fn upload_orchestration_records_failed_event_for_missing_token() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().join("app-data");
        let session_dir = tmp.path().join("session");
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let audio_path = session_dir.join("audio.opus");
        std::fs::write(&audio_path, b"OggS").expect("write audio");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let client = RecordingUploadClient {
            calls: Arc::clone(&calls),
            result: Some(Ok(BrainUploadResponse {
                ok: true,
                job_id: None,
                status: None,
                principal_id: None,
                workspace_id: None,
                workspace_slug: None,
                inbox_path: None,
                meta_path: None,
                duplicate: None,
                error: None,
            })),
        };

        let err = super::upload_session_after_record_with_client(
            app_data_dir.clone(),
            session_dir,
            sample_meta(),
            audio_path,
            enabled_settings("https://brain.example/upload".to_string()),
            &client,
            true,
        )
        .await
        .expect_err("missing token should fail");

        assert_eq!(err, "Brain sync token is not configured");
        assert!(calls.lock().expect("calls lock").is_empty());
        let events =
            list_session_events(&app_data_dir, "session-upload").expect("load session events");
        let event_types = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>();
        assert_eq!(event_types, vec!["brain_upload_failed"]);
        assert_eq!(events[0].detail, "Brain sync token is not configured");
    }
}
