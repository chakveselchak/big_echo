use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const SERVICE_NAME: &str = "BigEcho";
const FALLBACK_FILE_NAME: &str = "secrets.local.json";

fn fallback_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(FALLBACK_FILE_NAME)
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
    std::fs::write(path, raw).map_err(|e| e.to_string())
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
}
