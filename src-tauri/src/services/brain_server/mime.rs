use std::path::Path;

/// Brain upload multipart Content-Type for recorded audio files.
///
/// Opus recordings are written into an Ogg container (see `opus_writer`), so the
/// conservative contract for Brain ingest is `audio/ogg;codecs=opus` — aligned with
/// `pipeline::salute_speech_upload_content_type` and Telegram bot ingest (`audio/ogg`).
pub fn brain_upload_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("opus") => "audio/ogg;codecs=opus",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_upload_uses_ogg_container_mime_with_opus_codec() {
        assert_eq!(
            brain_upload_content_type(Path::new("/tmp/audio.opus")),
            "audio/ogg;codecs=opus"
        );
    }

    #[test]
    fn ogg_upload_uses_ogg_container_mime() {
        assert_eq!(
            brain_upload_content_type(Path::new("/tmp/audio.ogg")),
            "audio/ogg"
        );
    }
}
