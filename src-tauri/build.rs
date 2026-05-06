fn main() {
    #[cfg(target_os = "macos")]
    {
        swift_rs::SwiftLinker::new("13.0")
            .with_package("SystemAudioBridge", "macos/SystemAudioBridge")
            .with_package("MinitrayBridge", "macos/MinitrayBridge")
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

    if target == "aarch64-apple-darwin" {
        let status = Command::new("swift")
            .arg("build")
            .arg("-c")
            .arg("release")
            .current_dir(&sidecar_src)
            .status()
            .expect("run swift build");
        assert!(status.success(), "swift build for apple-speech sidecar failed");

        let built = sidecar_src.join(".build/release/AppleSpeech");
        std::fs::copy(&built, &dst).expect("copy sidecar binary");
    } else {
        // Apple Speech APIs require macOS 26+ on Apple Silicon.
        // Stub for non-arm64 macOS so Tauri's externalBin packaging doesn't
        // miss a file; runtime gate prevents this stub from being invoked.
        let stub = "#!/bin/sh\necho '{\"error\":\"apple-speech requires Apple Silicon\"}'\nexit 1\n";
        std::fs::write(&dst, stub).expect("write apple-speech stub");
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dst).expect("stat stub").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dst, perms).expect("chmod stub");
    }
}
