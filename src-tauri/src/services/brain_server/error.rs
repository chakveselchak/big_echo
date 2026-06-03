use super::client::BrainUploadError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrainUploadErrorCode {
    Unauthorized,
    Forbidden,
    PayloadTooLarge,
    UnsupportedMediaType,
    ServerError,
    HttpError,
    NetworkError,
    IoError,
    InvalidUrl,
    TokenMissing,
    AlreadyRunning,
    ApiError,
    ConfigurationError,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrainUploadPublicError {
    pub code: BrainUploadErrorCode,
    pub message: String,
}

impl BrainUploadPublicError {
    pub fn invalid_url() -> Self {
        Self {
            code: BrainUploadErrorCode::InvalidUrl,
            message: "Некорректный URL Brain. Проверьте адрес в настройках.".to_string(),
        }
    }

    pub fn token_missing() -> Self {
        Self {
            code: BrainUploadErrorCode::TokenMissing,
            message: "API-токен Brain не настроен.".to_string(),
        }
    }

    pub fn already_running() -> Self {
        Self {
            code: BrainUploadErrorCode::AlreadyRunning,
            message: "Загрузка Brain уже выполняется.".to_string(),
        }
    }

    pub fn configuration(message: impl Into<String>) -> Self {
        Self {
            code: BrainUploadErrorCode::ConfigurationError,
            message: message.into(),
        }
    }

    pub fn from_brain_upload_error(err: &BrainUploadError) -> Self {
        match err {
            BrainUploadError::Unauthorized { .. } => Self {
                code: BrainUploadErrorCode::Unauthorized,
                message: "Brain отклонил токен авторизации. Проверьте API-токен в настройках."
                    .to_string(),
            },
            BrainUploadError::Forbidden { .. } => Self {
                code: BrainUploadErrorCode::Forbidden,
                message: "Brain отклонил загрузку: недостаточно прав.".to_string(),
            },
            BrainUploadError::PayloadTooLarge { .. } => Self {
                code: BrainUploadErrorCode::PayloadTooLarge,
                message: "Файл слишком большой для загрузки в Brain.".to_string(),
            },
            BrainUploadError::UnsupportedMediaType { .. } => Self {
                code: BrainUploadErrorCode::UnsupportedMediaType,
                message: "Brain не принимает этот формат аудио.".to_string(),
            },
            BrainUploadError::Server { status, .. } => Self {
                code: BrainUploadErrorCode::ServerError,
                message: format!("Brain вернул ошибку сервера ({status})."),
            },
            BrainUploadError::Http { status, .. } => Self {
                code: BrainUploadErrorCode::HttpError,
                message: format!("Brain вернул HTTP-ошибку ({status})."),
            },
            BrainUploadError::Network(_) => Self {
                code: BrainUploadErrorCode::NetworkError,
                message: "Не удалось связаться с Brain. Проверьте сеть и URL.".to_string(),
            },
            BrainUploadError::Io(_) => Self {
                code: BrainUploadErrorCode::IoError,
                message: "Не удалось прочитать аудиофайл для загрузки.".to_string(),
            },
            BrainUploadError::Json(_) => Self {
                code: BrainUploadErrorCode::Unknown,
                message: "Brain вернул некорректный ответ.".to_string(),
            },
            BrainUploadError::Api(_) => Self {
                code: BrainUploadErrorCode::ApiError,
                message: "Brain отклонил загрузку.".to_string(),
            },
        }
    }
}

impl std::fmt::Display for BrainUploadPublicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for BrainUploadPublicError {}

impl From<String> for BrainUploadPublicError {
    fn from(message: String) -> Self {
        Self::configuration(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_error_from_unauthorized_never_includes_body_preview() {
        let public = BrainUploadPublicError::from_brain_upload_error(&BrainUploadError::Unauthorized {
            body_preview: "Bearer secret-token-was-here".to_string(),
        });
        assert_eq!(public.code, BrainUploadErrorCode::Unauthorized);
        assert!(!public.message.contains("secret-token"));
        assert!(!public.message.contains("Bearer"));
    }

    #[test]
    fn public_error_from_api_never_includes_server_message() {
        let public = BrainUploadPublicError::from_brain_upload_error(&BrainUploadError::Api(
            "internal debug token=abc123".to_string(),
        ));
        assert_eq!(public.code, BrainUploadErrorCode::ApiError);
        assert!(!public.message.contains("abc123"));
        assert!(!public.message.contains("token"));
    }

    #[test]
    fn public_error_round_trips_through_serde_json() {
        let original = BrainUploadPublicError::network_error_fixture();
        let encoded = serde_json::to_string(&original).expect("serialize");
        let decoded: BrainUploadPublicError = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(original, decoded);
    }
}

impl BrainUploadPublicError {
    #[cfg(test)]
    fn network_error_fixture() -> Self {
        BrainUploadPublicError::from_brain_upload_error(&BrainUploadError::Network(
            "dns failed for secret.example".to_string(),
        ))
    }
}
