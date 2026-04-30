use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[cfg(target_os = "macos")]
const SIDECAR_TRIPLE: &str = env!("APPLE_SPEECH_SIDECAR_TRIPLE");
#[cfg(not(target_os = "macos"))]
const SIDECAR_TRIPLE: &str = "";

#[derive(Debug, Clone, Serialize)]
pub struct Availability {
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CheckResult {
    pub locale: String,
    pub resolved: String,
    pub supported: bool,
    pub installed: bool,
    #[serde(rename = "assetStatus")]
    pub asset_status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TranscribeResult {
    pub text: String,
    pub segments: Vec<Segment>,
    pub locale: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ErrorResult {
    error: String,
}

pub fn sidecar_path() -> Option<PathBuf> {
    if SIDECAR_TRIPLE.is_empty() {
        return None;
    }
    let bin_name = format!("apple-speech-{}", SIDECAR_TRIPLE);

    // Bundled .app: sibling of the main exe in Contents/MacOS/.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(&bin_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // Dev mode: src-tauri/binaries/, where build.rs writes the binary.
    let manifest = env!("CARGO_MANIFEST_DIR");
    let candidate = PathBuf::from(manifest).join("binaries").join(&bin_name);
    if candidate.exists() {
        return Some(candidate);
    }

    None
}

pub fn availability() -> Availability {
    if !cfg!(target_os = "macos") {
        return Availability {
            supported: false,
            reason: Some("requires_macos".into()),
        };
    }
    if !cfg!(target_arch = "aarch64") {
        return Availability {
            supported: false,
            reason: Some("requires_apple_silicon".into()),
        };
    }
    if !macos_version_at_least(26) {
        return Availability {
            supported: false,
            reason: Some("requires_macos_26".into()),
        };
    }
    if sidecar_path().is_none() {
        return Availability {
            supported: false,
            reason: Some("sidecar_missing".into()),
        };
    }
    Availability {
        supported: true,
        reason: None,
    }
}

fn macos_version_at_least(min_major: u32) -> bool {
    let output = match std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
    {
        Ok(out) if out.status.success() => out,
        _ => return false,
    };
    let raw = String::from_utf8_lossy(&output.stdout);
    let major = raw
        .trim()
        .split('.')
        .next()
        .and_then(|s| s.parse::<u32>().ok());
    matches!(major, Some(v) if v >= min_major)
}

async fn run_simple(args: &[&str]) -> Result<String, String> {
    let path = sidecar_path().ok_or_else(|| "Apple Speech sidecar not found".to_string())?;
    let output = Command::new(&path)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    if let Ok(err) = serde_json::from_str::<ErrorResult>(stdout.trim()) {
        if stderr.trim().is_empty() {
            return Err(err.error);
        }
        return Err(format!("{} | stderr: {}", err.error, stderr.trim()));
    }
    Err(format!(
        "sidecar exited with {}: stdout={} stderr={}",
        output.status,
        stdout.trim(),
        stderr.trim()
    ))
}

pub async fn check_locale(locale: &str) -> Result<CheckResult, String> {
    let stdout = run_simple(&["check", "--locale", locale]).await?;
    serde_json::from_str(stdout.trim()).map_err(|e| format!("parse check result: {e}"))
}

pub async fn transcribe(audio_path: &str, locale: &str) -> Result<TranscribeResult, String> {
    let stdout = run_simple(&[
        "transcribe",
        "--locale",
        locale,
        "--input",
        audio_path,
    ])
    .await?;
    serde_json::from_str(stdout.trim()).map_err(|e| format!("parse transcribe result: {e}"))
}

/// Streams `progress: <0..1>` lines on stderr to `on_progress` while the
/// download runs. Final stdout JSON is parsed for status.
pub async fn download_locale<F>(locale: &str, mut on_progress: F) -> Result<(), String>
where
    F: FnMut(f64),
{
    let path = sidecar_path().ok_or_else(|| "Apple Speech sidecar not found".to_string())?;
    let mut child = Command::new(&path)
        .args(["download", "--locale", locale])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn sidecar: {e}"))?;

    let stderr = child.stderr.take().expect("stderr piped");
    let mut reader = BufReader::new(stderr).lines();

    while let Ok(Some(line)) = reader.next_line().await {
        if let Some(rest) = line.strip_prefix("progress: ") {
            if let Ok(value) = rest.trim().parse::<f64>() {
                on_progress(value);
            }
        }
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait sidecar: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() {
        return Ok(());
    }
    if let Ok(err) = serde_json::from_str::<ErrorResult>(stdout.trim()) {
        return Err(err.error);
    }
    Err(format!(
        "download exited with {}: {}",
        output.status, stdout
    ))
}

pub fn open_dictation_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Dictation";
        let status = std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|e| format!("open dictation settings: {e}"))?;
        if !status.success() {
            return Err(format!("open exited with {}", status));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Dictation settings are only available on macOS".to_string())
    }
}
