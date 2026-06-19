use std::path::Path;

/// Computes the Yandex.Disk remote path of a session's audio file, mirroring the
/// layout produced by the sync runner: `disk:/{folder}/{rel}/{audio_file}`, where
/// `rel` is `session_dir` relative to `recording_root` in POSIX form.
///
/// Returns `None` when there is nothing to share: an empty `audio_file`, or a
/// `session_dir` that is not located under `recording_root`.
pub fn remote_audio_path(
    remote_folder: &str,
    recording_root: &Path,
    session_dir: &Path,
    audio_file: &str,
) -> Option<String> {
    let audio_file = audio_file.trim();
    if audio_file.is_empty() {
        return None;
    }
    let rel = session_dir.strip_prefix(recording_root).ok()?;
    let folder = remote_folder.trim().trim_matches('/');
    let mut parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    parts.push(audio_file.to_string());
    Some(format!("disk:/{}/{}", folder, parts.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_remote_path_for_nested_session() {
        let root = Path::new("/data/recordings");
        let dir = Path::new("/data/recordings/10.04.2026/meeting_15-06-07");
        let got = remote_audio_path("BigEcho", root, dir, "audio.opus");
        assert_eq!(
            got.as_deref(),
            Some("disk:/BigEcho/10.04.2026/meeting_15-06-07/audio.opus")
        );
    }

    #[test]
    fn trims_surrounding_slashes_in_folder() {
        let root = Path::new("/r");
        let dir = Path::new("/r/s");
        assert_eq!(
            remote_audio_path("/BigEcho/", root, dir, "audio.mp3").as_deref(),
            Some("disk:/BigEcho/s/audio.mp3")
        );
    }

    #[test]
    fn none_when_audio_file_blank() {
        let root = Path::new("/r");
        let dir = Path::new("/r/s");
        assert_eq!(remote_audio_path("BigEcho", root, dir, "   "), None);
    }

    #[test]
    fn none_when_session_dir_outside_root() {
        let root = Path::new("/r");
        let dir = Path::new("/other/s");
        assert_eq!(remote_audio_path("BigEcho", root, dir, "audio.opus"), None);
    }
}
