use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;
use tokio::fs::File;

const DEFAULT_BASE: &str = "https://cloud-api.yandex.net/v1/disk";
const LIST_PAGE_SIZE: u32 = 1000;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum YandexError {
    #[error("network error: {0}")]
    Network(String),
    #[error("http error: {status} — {body}")]
    Http { status: u16, body: String },
    #[error("unauthorized")]
    Unauthorized,
    #[error("parse error: {0}")]
    Parse(String),
    #[error("io error: {0}")]
    Io(String),
}

#[async_trait]
pub trait YandexDiskApi: Send + Sync {
    async fn ensure_dir(&self, remote_path: &str) -> Result<(), YandexError>;
    async fn list_dir(&self, remote_path: &str) -> Result<HashMap<String, u64>, YandexError>;
    async fn upload_file(&self, remote_path: &str, local_path: &Path) -> Result<(), YandexError>;
}

pub struct HttpYandexDiskClient {
    base_url: String,
    token: String,
    http_meta: Client,
    http_upload: Client,
}

impl HttpYandexDiskClient {
    pub fn new(token: impl Into<String>) -> Self {
        Self::with_base(DEFAULT_BASE, token)
    }

    pub fn with_base(base: impl Into<String>, token: impl Into<String>) -> Self {
        let http_meta = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest meta client should build");
        let http_upload = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // No overall timeout: large uploads may take minutes.
            .build()
            .expect("reqwest upload client should build");
        Self {
            base_url: base.into().trim_end_matches('/').to_string(),
            token: token.into(),
            http_meta,
            http_upload,
        }
    }

    fn auth_header_value(&self) -> String {
        format!("OAuth {}", self.token)
    }

    fn parent_paths(remote_path: &str) -> Vec<String> {
        // "disk:/A/B/C" → ["disk:/A", "disk:/A/B", "disk:/A/B/C"]
        let Some(stripped) = remote_path.strip_prefix("disk:/") else {
            return vec![remote_path.to_string()];
        };
        let trimmed = stripped.trim_matches('/');
        if trimmed.is_empty() {
            return vec![];
        }
        let mut out = Vec::new();
        let mut current = String::from("disk:/");
        for part in trimmed.split('/') {
            if !current.ends_with('/') {
                current.push('/');
            }
            current.push_str(part);
            out.push(current.clone());
        }
        out
    }
}

#[derive(Deserialize)]
struct UploadHrefResponse {
    href: String,
}

#[derive(Deserialize)]
struct ListItem {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Deserialize)]
struct EmbeddedField {
    items: Vec<ListItem>,
    #[serde(default)]
    total: Option<u32>,
}

#[derive(Deserialize)]
struct ListDirResponse {
    #[serde(rename = "_embedded")]
    embedded: EmbeddedField,
}

#[async_trait]
impl YandexDiskApi for HttpYandexDiskClient {
    // FIXME(performance): parent_paths walks every level on every call, so ancestor
    // directories get re-PUT once per distinct leaf. Yandex returns 409 in steady
    // state, but we still pay the round trip. Replace with a "try leaf; on 404
    // recurse into parent" approach once we have real sync traffic to benchmark.
    async fn ensure_dir(&self, remote_path: &str) -> Result<(), YandexError> {
        for path in Self::parent_paths(remote_path) {
            let url = format!("{}/resources?path={}", self.base_url, urlencoding::encode(&path));
            let res = self
                .http_meta
                .put(&url)
                .header("Authorization", self.auth_header_value())
                .send()
                .await
                .map_err(|e| YandexError::Network(e.to_string()))?;
            match res.status().as_u16() {
                200 | 201 | 409 => continue,
                401 | 403 => return Err(YandexError::Unauthorized),
                status => {
                    let body = res.text().await.unwrap_or_default();
                    return Err(YandexError::Http { status, body });
                }
            }
        }
        Ok(())
    }

    async fn list_dir(&self, remote_path: &str) -> Result<HashMap<String, u64>, YandexError> {
        let mut files: HashMap<String, u64> = HashMap::new();
        let mut offset: u32 = 0;
        loop {
            let url = format!(
                "{}/resources?path={}&limit={}&offset={}&fields={}",
                self.base_url,
                urlencoding::encode(remote_path),
                LIST_PAGE_SIZE,
                offset,
                urlencoding::encode(
                    "_embedded.items.name,_embedded.items.size,_embedded.items.type,_embedded.total"
                )
            );
            let res = self
                .http_meta
                .get(&url)
                .header("Authorization", self.auth_header_value())
                .send()
                .await
                .map_err(|e| YandexError::Network(e.to_string()))?;
            match res.status().as_u16() {
                200 => {}
                404 => return Ok(HashMap::new()),
                401 | 403 => return Err(YandexError::Unauthorized),
                status => {
                    let body = res.text().await.unwrap_or_default();
                    return Err(YandexError::Http { status, body });
                }
            }
            let parsed: ListDirResponse = res
                .json()
                .await
                .map_err(|e| YandexError::Parse(e.to_string()))?;
            let page_len = parsed.embedded.items.len() as u32;
            for item in parsed.embedded.items {
                if item.kind == "file" {
                    files.insert(item.name, item.size.unwrap_or(0));
                }
            }
            let total = parsed.embedded.total.unwrap_or(offset + page_len);
            offset += page_len;
            if page_len == 0 || offset >= total {
                break;
            }
        }
        Ok(files)
    }

    async fn upload_file(&self, remote_path: &str, local_path: &Path) -> Result<(), YandexError> {
        // Open the file and fetch its size before any network traffic so that a
        // missing local path surfaces as YandexError::Io immediately.
        let file = File::open(local_path)
            .await
            .map_err(|e| YandexError::Io(e.to_string()))?;
        let size = file
            .metadata()
            .await
            .map_err(|e| YandexError::Io(e.to_string()))?
            .len();

        let get_href_url = format!(
            "{}/resources/upload?path={}&overwrite=false",
            self.base_url,
            urlencoding::encode(remote_path)
        );
        let href_res = self
            .http_meta
            .get(&get_href_url)
            .header("Authorization", self.auth_header_value())
            .send()
            .await
            .map_err(|e| YandexError::Network(e.to_string()))?;
        match href_res.status().as_u16() {
            200 => {}
            401 | 403 => return Err(YandexError::Unauthorized),
            409 => return Ok(()),
            status => {
                let body = href_res.text().await.unwrap_or_default();
                return Err(YandexError::Http { status, body });
            }
        }
        let href: UploadHrefResponse = href_res
            .json()
            .await
            .map_err(|e| YandexError::Parse(e.to_string()))?;

        let body = reqwest::Body::from(file);

        let put_res = self
            .http_upload
            .put(&href.href)
            .header("Content-Length", size)
            .body(body)
            .send()
            .await
            .map_err(|e| YandexError::Network(e.to_string()))?;
        match put_res.status().as_u16() {
            200 | 201 | 202 | 409 => Ok(()),
            401 | 403 => Err(YandexError::Unauthorized),
            status => {
                let body = put_res.text().await.unwrap_or_default();
                Err(YandexError::Http { status, body })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client_for(server: &MockServer) -> HttpYandexDiskClient {
        HttpYandexDiskClient::with_base(&server.uri(), "test-token")
    }

    #[tokio::test]
    async fn auth_header_is_oauth_prefixed() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/resources"))
            .and(query_param("path", "disk:/BigEcho"))
            .and(wiremock::matchers::header("Authorization", "OAuth test-token"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        client_for(&server).ensure_dir("disk:/BigEcho").await.expect("ok");
    }

    #[tokio::test]
    async fn ensure_dir_treats_409_as_success() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/resources"))
            .respond_with(ResponseTemplate::new(409))
            .expect(1)
            .mount(&server)
            .await;
        client_for(&server).ensure_dir("disk:/BigEcho").await.expect("409 is ok");
    }

    #[tokio::test]
    async fn ensure_dir_creates_missing_parents_recursively() {
        let server = MockServer::start().await;
        Mock::given(method("PUT")).and(query_param("path", "disk:/BigEcho"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(query_param("path", "disk:/BigEcho/A"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(query_param("path", "disk:/BigEcho/A/B"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;
        client_for(&server).ensure_dir("disk:/BigEcho/A/B").await.expect("ok");
    }

    #[tokio::test]
    async fn list_dir_parses_files_only() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "_embedded": {
                "items": [
                    {"name": "audio.opus", "type": "file", "size": 100_000},
                    {"name": "subdir", "type": "dir"},
                    {"name": "transcript.md", "type": "file", "size": 1_234}
                ],
                "total": 3
            }
        });
        Mock::given(method("GET")).and(path("/resources"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;
        let got = client_for(&server).list_dir("disk:/BigEcho").await.expect("ok");
        assert_eq!(got.len(), 2);
        assert_eq!(got["audio.opus"], 100_000);
        assert_eq!(got["transcript.md"], 1_234);
    }

    #[tokio::test]
    async fn list_dir_returns_empty_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/resources"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        let got = client_for(&server).list_dir("disk:/missing").await.expect("ok");
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn list_dir_pages_through_large_directories() {
        let server = MockServer::start().await;
        let total = 1500_u32;
        let first_page = serde_json::json!({
            "_embedded": {
                "items": (0..1000).map(|i| serde_json::json!({
                    "name": format!("f{i}.opus"), "type": "file", "size": i as u64
                })).collect::<Vec<_>>(),
                "total": total
            }
        });
        let second_page = serde_json::json!({
            "_embedded": {
                "items": (1000..1500).map(|i| serde_json::json!({
                    "name": format!("f{i}.opus"), "type": "file", "size": i as u64
                })).collect::<Vec<_>>(),
                "total": total
            }
        });
        Mock::given(method("GET")).and(path("/resources")).and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(first_page))
            .expect(1)
            .mount(&server).await;
        Mock::given(method("GET")).and(path("/resources")).and(query_param("offset", "1000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(second_page))
            .expect(1)
            .mount(&server).await;

        let got = client_for(&server).list_dir("disk:/BigEcho").await.expect("ok");
        assert_eq!(got.len(), 1500);
        assert_eq!(got["f0.opus"], 0);
        assert_eq!(got["f1499.opus"], 1499);
    }

    #[tokio::test]
    async fn upload_file_requests_href_then_puts_body() {
        let server = MockServer::start().await;
        let tmp = tempdir().expect("tempdir");
        let local = tmp.path().join("hello.txt");
        std::fs::File::create(&local).unwrap().write_all(b"payload").unwrap();

        let href = format!("{}/upload/target", server.uri());
        Mock::given(method("GET")).and(path("/resources/upload"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "href": href }))
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT")).and(path("/upload/target"))
            .respond_with(ResponseTemplate::new(201))
            .expect(1)
            .mount(&server)
            .await;

        client_for(&server)
            .upload_file("disk:/BigEcho/hello.txt", &local)
            .await
            .expect("upload ok");
    }

    #[tokio::test]
    async fn upload_file_treats_409_on_href_as_success() {
        let server = MockServer::start().await;
        let tmp = tempdir().expect("tempdir");
        let local = tmp.path().join("hello.txt");
        std::fs::File::create(&local).unwrap().write_all(b"x").unwrap();

        Mock::given(method("GET")).and(path("/resources/upload"))
            .respond_with(ResponseTemplate::new(409))
            .expect(1)
            .mount(&server)
            .await;

        client_for(&server)
            .upload_file("disk:/BigEcho/hello.txt", &local)
            .await
            .expect("409 href is ok");
    }

    #[tokio::test]
    async fn unauthorized_status_maps_to_unauthorized_error() {
        let server = MockServer::start().await;
        Mock::given(method("PUT")).and(path("/resources"))
            .respond_with(ResponseTemplate::new(401))
            .expect(1)
            .mount(&server)
            .await;
        let err = client_for(&server)
            .ensure_dir("disk:/BigEcho")
            .await
            .expect_err("must fail");
        assert_eq!(err, YandexError::Unauthorized);
    }

    #[tokio::test]
    async fn upload_file_missing_local_path_returns_io_error() {
        let server = MockServer::start().await;
        // No mocks required: upload_file should fail on File::open before any HTTP call.
        let err = client_for(&server)
            .upload_file("disk:/X/y.opus", std::path::Path::new("/nonexistent/path/y.opus"))
            .await
            .expect_err("must fail");
        assert!(matches!(err, YandexError::Io(_)));
    }
}
