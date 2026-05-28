use serde_json::Value;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

const SERVICE_NAME: &str = "BigEcho";
const FALLBACK_FILE_NAME: &str = "secrets.local.json";

fn fallback_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(FALLBACK_FILE_NAME)
}

fn fallback_lock_path(path: &Path) -> PathBuf {
    path.with_extension("local.json.lock")
}

struct FallbackFileLock {
    path: PathBuf,
}

impl Drop for FallbackFileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_fallback_lock(path: &Path) -> Result<FallbackFileLock, String> {
    let lock_path = fallback_lock_path(path);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    for _ in 0..100 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(_) => {
                return Ok(FallbackFileLock { path: lock_path });
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(err) => return Err(err.to_string()),
        }
    }
    Err("Timed out waiting for fallback secret lock".to_string())
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
    let tmp_path = path.with_extension(format!(
        "tmp.{}",
        std::process::id()
    ));
    std::fs::write(&tmp_path, raw).map_err(|e| e.to_string())?;
    match std::fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::AlreadyExists => {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())
        }
        Err(err) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(err.to_string())
        }
    }
}

pub fn set_secret(app_data_dir: &Path, name: &str, value: &str) -> Result<(), String> {
    let mut keyring_err: Option<String> = None;
    match keyring::Entry::new(SERVICE_NAME, name).map_err(|e| e.to_string()) {
        Ok(entry) => {
            if let Err(err) = entry.set_password(value) {
                keyring_err = Some(err.to_string());
            }
        }
        Err(err) => keyring_err = Some(err),
    }

    let path = fallback_path(app_data_dir);
    let _fallback_lock = acquire_fallback_lock(&path)?;
    let mut map = load_fallback_map(&path)?;
    map.insert(name.to_string(), value.to_string());
    save_fallback_map(&path, &map)?;

    if let Some(err) = keyring_err {
        eprintln!("warning: failed to write keyring secret {name}: {err}");
    }
    Ok(())
}

pub fn clear_secret(app_data_dir: &Path, name: &str) -> Result<(), String> {
    // Remove from the OS keyring. Treat "no entry" as success.
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, name) {
        match entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(err) => eprintln!("warning: failed to delete keyring secret {name}: {err}"),
        }
    }

    // Remove from the fallback file.
    let path = fallback_path(app_data_dir);
    let _fallback_lock = acquire_fallback_lock(&path)?;
    if path.exists() {
        let mut map = load_fallback_map(&path)?;
        if map.remove(name).is_some() {
            save_fallback_map(&path, &map)?;
        }
    }
    Ok(())
}

pub fn get_secret(app_data_dir: &Path, name: &str) -> Result<String, String> {
    let keyring_result = keyring::Entry::new(SERVICE_NAME, name)
        .map_err(|e| e.to_string())
        .and_then(|entry| entry.get_password().map_err(|e| e.to_string()));
    if let Ok(value) = keyring_result {
        return Ok(value);
    }

    let path = fallback_path(app_data_dir);
    let map = load_fallback_map(&path)?;
    if let Some(value) = map.get(name) {
        return Ok(value.clone());
    }

    Err(keyring_result
        .err()
        .unwrap_or_else(|| "No matching entry found in secure storage".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn clear_secret_removes_previously_stored_value() {
        let tmp = tempdir().expect("tempdir");
        set_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN", "abc123").expect("set");

        clear_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN").expect("clear");

        // Public API contract: after clear, get_secret no longer returns the value.
        // (The keyring may or may not have been writable in this environment, so we
        // only assert the observable contract, not the underlying file state.)
        match get_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN") {
            Err(_) => {}
            Ok(v) => panic!("expected secret to be cleared, got {v:?}"),
        }
    }

    #[test]
    fn clear_secret_is_idempotent_after_prior_clear() {
        let tmp = tempdir().expect("tempdir");
        set_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN", "abc123").expect("set");

        // First clear removes it.
        clear_secret(tmp.path(), "YANDEX_DISK_OAUTH_TOKEN").expect("first clear");
        // Second clear is a no-op on the now-absent key.
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
}
