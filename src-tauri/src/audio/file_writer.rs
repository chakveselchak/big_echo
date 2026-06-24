use crate::audio::{capture::CaptureArtifacts, opus_writer};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const DEFAULT_SILENCE_SECONDS: &str = "0.02";
const FFMPEG_SIDECAR_TRIPLE: &str = env!("FFMPEG_SIDECAR_TRIPLE");

pub fn audio_file_name(audio_format: &str) -> String {
    format!("audio.{}", extension_for_format(audio_format))
}

pub fn speed_adjusted_audio_file_name(audio_file: &str, speed: f32) -> Option<String> {
    let path = Path::new(audio_file);
    let stem = path.file_stem()?.to_str()?.trim();
    let extension = path.extension()?.to_str()?.trim();
    if stem.is_empty() || extension.is_empty() {
        return None;
    }
    Some(format!("{stem}_{}.{extension}", audio_speed_label(speed)))
}

pub fn audio_speed_label(speed: f32) -> String {
    if (speed - speed.round()).abs() < f32::EPSILON {
        format!("{:.0}x", speed)
    } else if ((speed * 10.0).round() - speed * 10.0).abs() < f32::EPSILON {
        format!("{:.1}x", speed)
    } else {
        format!("{:.2}x", speed)
    }
}

pub fn extension_for_format(audio_format: &str) -> &'static str {
    match audio_format {
        "mp3" => "mp3",
        "m4a" => "m4a",
        "ogg" => "ogg",
        "wav" => "wav",
        _ => "opus",
    }
}

pub fn mime_type_for_audio_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "audio/opus",
    }
}

pub fn write_capture_to_audio_file(
    output_path: &Path,
    audio_format: &str,
    artifacts: &CaptureArtifacts,
    opus_bitrate_kbps: u32,
) -> Result<(), String> {
    if audio_format == "opus" {
        return opus_writer::write_mixed_raw_i16_to_opus(
            output_path,
            &artifacts.mic_path,
            artifacts.mic_rate,
            artifacts.system_path.as_ref(),
            artifacts.system_rate,
            opus_bitrate_kbps,
        );
    }

    if artifacts.mic_rate == 0 {
        return Err("Mic sample rate must be > 0".to_string());
    }
    if artifacts.system_path.is_some() && artifacts.system_rate == 0 {
        return Err("System sample rate must be > 0".to_string());
    }

    let mut command = ffmpeg_command();
    command
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("s16le")
        .arg("-ar")
        .arg(artifacts.mic_rate.to_string())
        .arg("-ac")
        .arg("1")
        .arg("-i")
        .arg(&artifacts.mic_path);

    if let Some(system_path) = &artifacts.system_path {
        command
            .arg("-f")
            .arg("s16le")
            .arg("-ar")
            .arg(artifacts.system_rate.to_string())
            .arg("-ac")
            .arg("1")
            .arg("-i")
            .arg(system_path)
            .arg("-filter_complex")
            .arg("[0:a][1:a]amix=inputs=2:normalize=0[aout]")
            .arg("-map")
            .arg("[aout]");
    }

    append_output_args(&mut command, audio_format, opus_bitrate_kbps);
    command.arg(output_path);
    run_ffmpeg(command)
}

pub fn write_silence_audio_file(
    output_path: &Path,
    audio_format: &str,
    opus_bitrate_kbps: u32,
) -> Result<(), String> {
    if audio_format == "opus" {
        return opus_writer::write_pcm_opus(output_path, 48_000, &[], opus_bitrate_kbps);
    }

    let mut command = ffmpeg_command();
    command
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("anullsrc=r=48000:cl=mono")
        .arg("-t")
        .arg(DEFAULT_SILENCE_SECONDS);
    append_output_args(&mut command, audio_format, opus_bitrate_kbps);
    command.arg(output_path);
    run_ffmpeg(command)
}

pub fn write_speed_adjusted_audio_file(
    input_path: &Path,
    output_path: &Path,
    audio_format: &str,
    opus_bitrate_kbps: u32,
    speed: f32,
) -> Result<(), String> {
    let mut command = ffmpeg_command();
    command
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(input_path)
        .arg("-filter:a")
        .arg(format!("atempo={}", audio_speed_filter_value(speed)));
    append_output_args(&mut command, audio_format, opus_bitrate_kbps);
    command.arg(output_path);
    run_ffmpeg(command)
}

fn audio_speed_filter_value(speed: f32) -> String {
    if (speed - speed.round()).abs() < f32::EPSILON {
        format!("{:.0}", speed)
    } else if ((speed * 10.0).round() - speed * 10.0).abs() < f32::EPSILON {
        format!("{:.1}", speed)
    } else {
        format!("{:.2}", speed)
    }
}

fn append_output_args(command: &mut Command, audio_format: &str, opus_bitrate_kbps: u32) {
    match audio_format {
        "mp3" => {
            command
                .arg("-c:a")
                .arg("libmp3lame")
                .arg("-b:a")
                .arg("192k");
        }
        "m4a" => {
            command.arg("-c:a").arg("aac").arg("-b:a").arg("192k");
        }
        "ogg" => {
            command.arg("-c:a").arg("libvorbis").arg("-q:a").arg("4");
        }
        "wav" => {
            command.arg("-c:a").arg("pcm_s16le");
        }
        _ => {
            command
                .arg("-c:a")
                .arg("libopus")
                .arg("-b:a")
                .arg(format!("{}k", opus_bitrate_kbps.clamp(12, 128)));
        }
    }
}

fn ffmpeg_command() -> Command {
    Command::new(resolve_ffmpeg_binary())
}

fn resolve_ffmpeg_binary() -> PathBuf {
    ffmpeg_binary_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

fn ffmpeg_binary_candidates() -> Vec<PathBuf> {
    let ffmpeg_path = env::var("BIGECHO_FFMPEG_PATH").ok();
    let path_env = env::var("PATH").ok();
    let current_exe = env::current_exe().ok();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    ffmpeg_binary_candidates_for(
        ffmpeg_path.as_deref(),
        path_env.as_deref(),
        current_exe.as_deref(),
        &manifest_dir,
        FFMPEG_SIDECAR_TRIPLE,
        ffmpeg_binary_name(),
    )
}

fn ffmpeg_binary_candidates_for(
    ffmpeg_path: Option<&str>,
    path_env: Option<&str>,
    current_exe: Option<&Path>,
    manifest_dir: &Path,
    target_triple: &str,
    binary_name: &str,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(exe) = current_exe {
        if let Some(exe_dir) = exe.parent() {
            push_unique_candidate(&mut candidates, exe_dir.join(binary_name));
            push_unique_candidate(&mut candidates, exe_dir.join("ffmpeg"));
            if let Some(contents_dir) = exe_dir.parent() {
                push_unique_candidate(
                    &mut candidates,
                    contents_dir.join("Resources").join(binary_name),
                );
            }
        }
    }

    push_unique_candidate(
        &mut candidates,
        manifest_dir
            .join("binaries")
            .join(ffmpeg_source_name(target_triple, binary_name)),
    );

    if let Some(path) = ffmpeg_path.map(str::trim).filter(|path| !path.is_empty()) {
        push_unique_candidate(&mut candidates, PathBuf::from(path));
    }

    if let Some(path_env) = path_env {
        for directory in env::split_paths(path_env) {
            push_unique_candidate(&mut candidates, directory.join("ffmpeg"));
        }
    }

    push_unique_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/ffmpeg"));
    push_unique_candidate(&mut candidates, PathBuf::from("/usr/local/bin/ffmpeg"));

    candidates
}

fn ffmpeg_source_name(target_triple: &str, binary_name: &str) -> String {
    if binary_name.ends_with(".exe") {
        format!("ffmpeg-{target_triple}.exe")
    } else {
        format!("ffmpeg-{target_triple}")
    }
}

fn ffmpeg_binary_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn push_unique_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.as_os_str().is_empty() && !candidates.contains(&path) {
        candidates.push(path);
    }
}

fn run_ffmpeg(mut command: Command) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}. Install ffmpeg or set BIGECHO_FFMPEG_PATH to the ffmpeg binary path."))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err(format!("ffmpeg exited with status {}", output.status));
    }
    Err(format!("ffmpeg failed: {stderr}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_expected_audio_file_names() {
        assert_eq!(audio_file_name("opus"), "audio.opus");
        assert_eq!(audio_file_name("mp3"), "audio.mp3");
        assert_eq!(audio_file_name("m4a"), "audio.m4a");
        assert_eq!(audio_file_name("ogg"), "audio.ogg");
        assert_eq!(audio_file_name("wav"), "audio.wav");
    }

    #[test]
    fn builds_speed_adjusted_audio_file_names() {
        assert_eq!(
            speed_adjusted_audio_file_name("audio.opus", 1.25).as_deref(),
            Some("audio_1.25x.opus")
        );
        assert_eq!(
            speed_adjusted_audio_file_name("audio.mp3", 1.5).as_deref(),
            Some("audio_1.5x.mp3")
        );
        assert_eq!(
            speed_adjusted_audio_file_name("audio.m4a", 2.0).as_deref(),
            Some("audio_2x.m4a")
        );
    }

    #[test]
    fn derives_expected_mime_types() {
        assert_eq!(
            mime_type_for_audio_path(Path::new("/tmp/audio.opus")),
            "audio/opus"
        );
        assert_eq!(
            mime_type_for_audio_path(Path::new("/tmp/audio.mp3")),
            "audio/mpeg"
        );
        assert_eq!(
            mime_type_for_audio_path(Path::new("/tmp/audio.m4a")),
            "audio/mp4"
        );
        assert_eq!(
            mime_type_for_audio_path(Path::new("/tmp/audio.ogg")),
            "audio/ogg"
        );
        assert_eq!(
            mime_type_for_audio_path(Path::new("/tmp/audio.wav")),
            "audio/wav"
        );
    }

    #[test]
    fn ffmpeg_candidates_prefer_bundled_sidecar_before_env_and_path() {
        let exe = Path::new("/Applications/BigEcho.app/Contents/MacOS/bigecho");
        let manifest = Path::new("/repo/src-tauri");
        let candidates = ffmpeg_binary_candidates_for(
            Some("/custom/ffmpeg"),
            Some("/tmp/bin:/usr/bin"),
            Some(exe),
            manifest,
            "aarch64-apple-darwin",
            "ffmpeg",
        );

        assert_eq!(
            candidates.first().unwrap(),
            &Path::new("/Applications/BigEcho.app/Contents/MacOS/ffmpeg").to_path_buf()
        );
        assert!(candidates.contains(
            &Path::new("/repo/src-tauri/binaries/ffmpeg-aarch64-apple-darwin").to_path_buf()
        ));
        assert!(candidates.contains(&Path::new("/custom/ffmpeg").to_path_buf()));
        assert!(candidates.contains(&Path::new("/opt/homebrew/bin/ffmpeg").to_path_buf()));
        assert!(candidates.contains(&Path::new("/usr/local/bin/ffmpeg").to_path_buf()));
    }

    #[test]
    fn ffmpeg_candidates_use_windows_sidecar_name() {
        let exe = Path::new("C:\\Program Files\\BigEcho\\bigecho.exe");
        let manifest = Path::new("C:\\repo\\src-tauri");
        let candidates = ffmpeg_binary_candidates_for(
            None,
            None,
            Some(exe),
            manifest,
            "x86_64-pc-windows-msvc",
            "ffmpeg.exe",
        );

        assert!(candidates.contains(
            &Path::new("C:\\repo\\src-tauri")
                .join("binaries")
                .join("ffmpeg-x86_64-pc-windows-msvc.exe")
        ));
    }
}
