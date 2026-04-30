fn main() {
    #[cfg(target_os = "macos")]
    {
        swift_rs::SwiftLinker::new("13.0")
            .with_package("SystemAudioBridge", "macos/SystemAudioBridge")
            .link();
        build_apple_speech_sidecar();
    }

    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn build_apple_speech_sidecar() {
    use std::path::PathBuf;
    use std::process::Command;

    let target = std::env::var("TARGET").expect("TARGET env not set");
    println!("cargo:rustc-env=APPLE_SPEECH_SIDECAR_TRIPLE={}", target);
    let manifest_dir: PathBuf = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR")
        .into();
    let sidecar_src = manifest_dir
        .parent()
        .expect("workspace root")
        .join("apple-speech-sidecar");

    println!("cargo:rerun-if-changed={}/Package.swift", sidecar_src.display());
    println!("cargo:rerun-if-changed={}/Sources", sidecar_src.display());

    let bin_dir = manifest_dir.join("binaries");
    std::fs::create_dir_all(&bin_dir).expect("create binaries dir");
    let dst = bin_dir.join(format!("apple-speech-{}", target));

    let mut produced_real = false;
    if target == "aarch64-apple-darwin" {
        // Try to build the Swift sidecar. Requires Xcode 17 / Swift 6.2 (macOS 26 SDK).
        // If unavailable (e.g. CI runners on Xcode 16.x), fall back to a stub so the
        // rest of the app still bundles. Apple Speech is then unavailable at runtime,
        // which is enforced by `get_apple_speech_availability`.
        let status = Command::new("swift")
            .arg("build")
            .arg("-c")
            .arg("release")
            .current_dir(&sidecar_src)
            .status();
        let built = sidecar_src.join(".build/release/AppleSpeech");
        match status {
            Ok(s) if s.success() && built.exists() => {
                std::fs::copy(&built, &dst).expect("copy sidecar binary");
                produced_real = true;
            }
            Ok(s) => {
                println!(
                    "cargo:warning=apple-speech sidecar build failed (exit {s}); writing stub. \
                     Install Xcode 17 / Swift 6.2 to enable Apple Speech locally."
                );
            }
            Err(e) => {
                println!(
                    "cargo:warning=apple-speech sidecar swift toolchain unavailable ({e}); writing stub."
                );
            }
        }
    }

    if !produced_real {
        // Stub keeps Tauri's externalBin packaging happy; runtime gate prevents
        // this stub from being invoked.
        let stub = "#!/bin/sh\necho '{\"error\":\"apple-speech sidecar not available in this build (requires Apple Silicon and Xcode 17 with macOS 26 SDK)\"}'\nexit 1\n";
        std::fs::write(&dst, stub).expect("write apple-speech stub");
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dst).expect("stat stub").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dst, perms).expect("chmod stub");
    }
}
