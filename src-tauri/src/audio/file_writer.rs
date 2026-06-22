use crate::audio::{capture::CaptureArtifacts, opus_writer};
use std::path::Path;
use std::process::Command;

const DEFAULT_SILENCE_SECONDS: &str = "0.02";

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

    let mut command = Command::new("ffmpeg");
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

    let mut command = Command::new("ffmpeg");
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
    let mut command = Command::new("ffmpeg");
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

fn run_ffmpeg(mut command: Command) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
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
}
