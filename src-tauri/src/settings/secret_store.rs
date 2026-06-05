use crate::settings::token_validation::{contains_disallowed_token_chars, validate_secret_token};
use fs2::FileExt;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const SERVICE_NAME: &str = "BigEcho";
const FALLBACK_FILE_NAME: &str = "secrets.local.json";

fn fallback_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(FALLBACK_FILE_NAME)
}

fn fallback_lock_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| FALLBACK_FILE_NAME.to_string());
    path.parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{file_name}.lock"))
}

struct FallbackFileLock {
    file: File,
}

impl Drop for FallbackFileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn acquire_fallback_lock(path: &Path) -> Result<FallbackFileLock, String> {
    let lock_path = fallback_lock_path(path);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(FallbackFileLock { file })
}

fn with_fallback_lock<T>(
    path: &Path,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _lock = acquire_fallback_lock(path)?;
    action()
}

fn load_fallback_map(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let obj = json
        .as_object()
        .ok_or_else(|| "Invalid fallback secret file format".to_string())?;
    let mut out = HashMap::new();
    for (k, v) in obj {
        if let Some(text) = v.as_str() {
            if contains_disallowed_token_chars(text) {
                return Err(format!(
                    "Invalid stored secret for {k}: control characters are not allowed"
                ));
            }
            out.insert(k.clone(), text.to_string());
        }
    }
    Ok(out)
}

fn save_fallback_map(path: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension(format!("tmp.{}", std::process::id()));
    {
        let mut file = File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(raw.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    match std::fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::write(path, raw).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&tmp_path);
            Ok(())
        }
    }
}

pub fn set_secret(app_data_dir: &Path, name: &str, value: &str) -> Result<(), String> {
    let validated = validate_secret_token(value)?;

    let mut keyring_err: Option<String> = None;
    match keyring::Entry::new(SERVICE_NAME, name).map_err(|e| e.to_string()) {
        Ok(entry) => {
            if let Err(err) = entry.set_password(validated) {
                keyring_err = Some(err.to_string());
            }
        }
        Err(err) => keyring_err = Some(err),
    }

    let path = fallback_path(app_data_dir);
    with_fallback_lock(&path, || {
        let mut map = load_fallback_map(&path)?;
        map.insert(name.to_string(), validated.to_string());
        save_fallback_map(&path, &map)
    })?;

    if let Some(err) = keyring_err {
        eprintln!("warning: failed to write keyring secret {name}: {err}");
    }
    Ok(())
}

pub fn clear_secret(app_data_dir: &Path, name: &str) -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, name) {
        match entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(err) => eprintln!("warning: failed to delete keyring secret {name}: {err}"),
        }
    }

    let path = fallback_path(app_data_dir);
    with_fallback_lock(&path, || {
        if path.exists() {
            let mut map = load_fallback_map(&path)?;
            if map.remove(name).is_some() {
                save_fallback_map(&path, &map)?;
            }
        }
        Ok(())
    })
}

pub fn get_secret(app_data_dir: &Path, name: &str) -> Result<String, String> {
    let keyring_result = keyring::Entry::new(SERVICE_NAME, name)
        .map_err(|e| e.to_string())
        .and_then(|entry| entry.get_password().map_err(|e| e.to_string()));
    if let Ok(value) = keyring_result {
        validate_secret_token(&value).map(|validated| validated.to_string())
    } else {
        let path = fallback_path(app_data_dir);
        let map = load_fallback_map(&path)?;
        if let Some(value) = map.get(name) {
            validate_secret_token(value).map(|validated| validated.to_string())
        } else {
            Err(keyring_result
                .err()
                .unwrap_or_else(|| "No matching entry found in secure storage".to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn fallback_lock_path_uses_secrets_local_json_lock() {
        let tmp = tempdir().expect("tempdir");
        let path = fallback_path(tmp.path());
        assert_eq!(
            fallback_lock_path(&path),
            tmp.path().join("secrets.local.json.lock")
        );
    }

    #[test]
    fn stale_lock_file_does_not_block_set_secret() {
        let tmp = tempdir().expect("tempdir");
        let path = fallback_path(tmp.path());
        let lock_path = fallback_lock_path(&path);
        std::fs::write(&lock_path, "stale lock from dead process").expect("write stale lock");
        set_secret(tmp.path(), "BRAIN_SERVER_API_TOKEN", "fresh-token").expect("set secret");
        assert_eq!(
            get_secret(tmp.path(), "BRAIN_SERVER_API_TOKEN").expect("get secret"),
            "fresh-token"
        );
    }

    #[test]
    fn clear_secret_removes_previously_stored_value() {
        let tmp = tempdir().expect("tempdir");
        set_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN", "abc123").expect("set");

        clear_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN").expect("clear");

        match get_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN") {
            Err(_) => {}
            Ok(v) => panic!("expected secret to be cleared, got {v:?}"),
        }
    }

    #[test]
    fn clear_secret_is_idempotent_after_prior_clear() {
        let tmp = tempdir().expect("tempdir");
        set_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN", "abc123").expect("set");

        clear_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN").expect("first clear");
        clear_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN").expect("second clear");

        match get_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN") {
            Err(_) => {}
            Ok(v) => panic!("expected secret to remain cleared, got {v:?}"),
        }
    }

    #[test]
    fn concurrent_fallback_secret_writes_keep_both_values() {
        let tmp = tempdir().expect("tempdir");
        let app_data_dir = tmp.path().to_path_buf();
        let left_dir = app_data_dir.clone();
        let right_dir = app_data_dir.clone();

        let left = std::thread::spawn(move || {
            set_secret(&left_dir, "BRAIN_SERVER_API_TOKEN", "brain-token")
        });
        let right = std::thread::spawn(move || {
            set_secret(&right_dir, "YANDEX_DISK_OAUTH_TOKEN", "yandex-token")
        });

        left.join().expect("left thread").expect("left set");
        right.join().expect("right thread").expect("right set");

        assert_eq!(
            get_secret(&app_data_dir, "BRAIN_SERVER_API_TOKEN").expect("brain token"),
            "brain-token"
        );
        assert_eq!(
            get_secret(&app_data_dir, "YANDEX_DISK_OAUTH_TOKEN").expect("yandex token"),
            "yandex-token"
        );
    }

    #[test]
    fn set_secret_rejects_control_characters_in_token() {
        let tmp = tempdir().expect("tempdir");
        let err = set_secret(tmp.path(), "BRAIN_SERVER_API_TOKEN", "bad\nvalue")
            .expect_err("newline token should fail");
        assert_eq!(err, "Token must not contain control characters");
    }

    #[test]
    fn get_secret_rejects_stored_token_with_control_characters() {
        let tmp = tempdir().expect("tempdir");
        let path = fallback_path(tmp.path());
        std::fs::create_dir_all(tmp.path()).expect("create dir");
        std::fs::write(&path, r#"{"BRAIN_SERVER_API_TOKEN":"bad\u2028value"}"#)
            .expect("write fallback secrets");

        let err = get_secret(tmp.path(), "BRAIN_SERVER_API_TOKEN").expect_err("stored bad token");
        assert!(err.contains("control characters"));
    }
}
