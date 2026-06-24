fn main() {
    let target = std::env::var("TARGET").expect("TARGET env not set");
    println!("cargo:rustc-env=FFMPEG_SIDECAR_TRIPLE={}", target);
    copy_ffmpeg_sidecar(&target);

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

fn copy_ffmpeg_sidecar(target: &str) {
    use std::path::PathBuf;

    let manifest_dir: PathBuf = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR")
        .into();
    let workspace_root = manifest_dir.parent().expect("workspace root");
    let package_binary = workspace_root
        .join("node_modules")
        .join("ffmpeg-static")
        .join(if target.contains("windows") {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });

    println!("cargo:rerun-if-changed={}", package_binary.display());

    if !package_binary.exists() {
        panic!(
            "ffmpeg-static binary not found at {}. Run `npm install` before building the Tauri app.",
            package_binary.display()
        );
    }

    let bin_dir = manifest_dir.join("binaries");
    std::fs::create_dir_all(&bin_dir).expect("create binaries dir");
    let dst = bin_dir.join(ffmpeg_sidecar_source_name(target));
    copy_executable(&package_binary, &dst);
}

fn ffmpeg_sidecar_source_name(target: &str) -> String {
    if target.contains("windows") {
        format!("ffmpeg-{target}.exe")
    } else {
        format!("ffmpeg-{target}")
    }
}

fn copy_executable(src: &std::path::Path, dst: &std::path::Path) {
    std::fs::copy(src, dst).expect("copy ffmpeg sidecar binary");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dst)
            .expect("stat ffmpeg sidecar")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(dst, perms).expect("chmod ffmpeg sidecar");
    }
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

    println!(
        "cargo:rerun-if-changed={}/Package.swift",
        sidecar_src.display()
    );
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
        assert!(
            status.success(),
            "swift build for apple-speech sidecar failed"
        );

        let built = sidecar_src.join(".build/release/AppleSpeech");
        std::fs::copy(&built, &dst).expect("copy sidecar binary");
    } else {
        // Apple Speech APIs require macOS 26+ on Apple Silicon.
        // Stub for non-arm64 macOS so Tauri's externalBin packaging doesn't
        // miss a file; runtime gate prevents this stub from being invoked.
        let stub =
            "#!/bin/sh\necho '{\"error\":\"apple-speech requires Apple Silicon\"}'\nexit 1\n";
        std::fs::write(&dst, stub).expect("write apple-speech stub");
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dst).expect("stat stub").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dst, perms).expect("chmod stub");
    }
}
