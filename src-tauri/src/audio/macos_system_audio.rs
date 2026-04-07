use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use swift_rs::{swift, Bool, Int32, Int64, SRString};

#[allow(dead_code)]
const DEFAULT_SAMPLE_RATE: u32 = 48_000;

#[cfg(target_os = "macos")]
#[link(name = "SystemAudioBridge", kind = "static")]
unsafe extern "C" {}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MacosSystemAudioPermissionKind {
    Granted,
    NotDetermined,
    Denied,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
pub struct MacosSystemAudioPermissionStatus {
    pub kind: MacosSystemAudioPermissionKind,
    pub can_request: bool,
}

#[allow(dead_code)]
pub struct NativeSystemAudioArtifacts {
    pub path: PathBuf,
    pub sample_rate: u32,
}

#[allow(dead_code)]
pub struct NativeSystemAudioCapture {
    #[cfg(target_os = "macos")]
    handle: Int64,
    path: PathBuf,
    sample_rate: u32,
}

#[cfg(target_os = "macos")]
swift!(fn bigecho_system_audio_permission_status() -> Int32);
#[cfg(target_os = "macos")]
swift!(fn bigecho_open_system_audio_settings() -> Bool);
#[cfg(target_os = "macos")]
swift!(fn bigecho_start_system_audio_capture(path: &SRString) -> Int64);
#[cfg(target_os = "macos")]
swift!(fn bigecho_stop_system_audio_capture(handle: Int64) -> Bool);
#[cfg(target_os = "macos")]
swift!(fn bigecho_get_system_audio_capture_level(handle: Int64) -> Int32);
#[cfg(target_os = "macos")]
swift!(fn bigecho_set_system_audio_capture_muted(handle: Int64, muted: Bool) -> Bool);

pub fn permission_status() -> MacosSystemAudioPermissionStatus {
    #[cfg(target_os = "macos")]
    {
        map_permission_code(unsafe { bigecho_system_audio_permission_status() } as i32)
    }

    #[cfg(not(target_os = "macos"))]
    {
        map_permission_code(-1)
    }
}

pub fn open_system_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if unsafe { bigecho_open_system_audio_settings() } {
            Ok(())
        } else {
            Err("Failed to open macOS system audio settings".to_string())
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("macOS system audio settings are unavailable on this platform".to_string())
    }
}

#[allow(dead_code)]
pub fn start_capture(path: &Path) -> Result<NativeSystemAudioCapture, String> {
    #[cfg(target_os = "macos")]
    {
        let path = path.to_path_buf();
        let raw_path: SRString = path.to_string_lossy().as_ref().into();
        let handle = unsafe { bigecho_start_system_audio_capture(&raw_path) };
        if handle <= 0 {
            return Err("Failed to start native macOS system audio capture".to_string());
        }

        Ok(NativeSystemAudioCapture {
            handle,
            path,
            sample_rate: DEFAULT_SAMPLE_RATE,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("native macOS system audio capture is unavailable on this platform".to_string())
    }
}

impl NativeSystemAudioCapture {
    pub fn live_level(&self) -> f32 {
        #[cfg(target_os = "macos")]
        {
            let raw = unsafe { bigecho_get_system_audio_capture_level(self.handle) };
            ((raw as f32) / 1000.0).clamp(0.0, 1.0)
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = self;
            0.0
        }
    }

    pub fn set_muted(&self, muted: bool) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            if unsafe { bigecho_set_system_audio_capture_muted(self.handle, muted) } {
                Ok(())
            } else {
                Err("Failed to update native macOS system audio mute state".to_string())
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (self, muted);
            Ok(())
        }
    }

    #[allow(dead_code)]
    pub fn stop(self) -> Result<NativeSystemAudioArtifacts, String> {
        #[cfg(target_os = "macos")]
        {
            if !unsafe { bigecho_stop_system_audio_capture(self.handle) } {
                return Err("Failed to stop native macOS system audio capture".to_string());
            }
            Ok(NativeSystemAudioArtifacts {
                path: self.path,
                sample_rate: self.sample_rate,
            })
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = self;
            Err("native macOS system audio capture is unavailable on this platform".to_string())
        }
    }
}

fn map_permission_code(code: i32) -> MacosSystemAudioPermissionStatus {
    match code {
        0 => MacosSystemAudioPermissionStatus {
            kind: MacosSystemAudioPermissionKind::NotDetermined,
            can_request: true,
        },
        1 => MacosSystemAudioPermissionStatus {
            kind: MacosSystemAudioPermissionKind::Granted,
            can_request: false,
        },
        2 => MacosSystemAudioPermissionStatus {
            kind: MacosSystemAudioPermissionKind::Denied,
            can_request: false,
        },
        _ => MacosSystemAudioPermissionStatus {
            kind: MacosSystemAudioPermissionKind::Unsupported,
            can_request: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_permission_codes_to_public_status() {
        let status = map_permission_code(0);
        assert!(matches!(
            status.kind,
            MacosSystemAudioPermissionKind::NotDetermined
        ));
        assert!(status.can_request);

        let status = map_permission_code(1);
        assert!(matches!(
            status.kind,
            MacosSystemAudioPermissionKind::Granted
        ));
        assert!(!status.can_request);

        let status = map_permission_code(2);
        assert!(matches!(
            status.kind,
            MacosSystemAudioPermissionKind::Denied
        ));
        assert!(!status.can_request);

        let status = map_permission_code(99);
        assert!(matches!(
            status.kind,
            MacosSystemAudioPermissionKind::Unsupported
        ));
        assert!(!status.can_request);
    }
}
