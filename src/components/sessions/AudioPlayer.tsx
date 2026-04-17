import { useEffect, useRef, useState } from "react";
import { Button, Slider } from "antd";
import type { SessionListItem } from "../../types";
import { getErrorMessage, parseDurationHms, pauseAudioElement, resolveSessionAudioPath } from "../../lib/appUtils";
import { tauriConvertFileSrc } from "../../lib/tauri";

type AudioPlayerProps = {
  item: SessionListItem;
  setStatus: (status: string) => void;
};

export function AudioPlayer({ item, setStatus }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioPath = resolveSessionAudioPath(item);
  const audioSrc = audioPath ? tauriConvertFileSrc(audioPath) : "";
  const fallbackDuration = parseDurationHms(item.audio_duration_hms);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(fallbackDuration);
  const isDisabled = !audioSrc || item.status === "recording";

  useEffect(() => {
    setIsPlaying(false);
    setProgressPercent(0);
    setDurationSeconds(fallbackDuration);
    if (!audioRef.current) return;
    pauseAudioElement(audioRef.current);
    audioRef.current.currentTime = 0;
  }, [audioSrc, fallbackDuration]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      pauseAudioElement(audio);
    };
  }, []);

  function syncProgressFromAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    const nextDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration;
    const nextTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    setDurationSeconds(nextDuration);
    setProgressPercent(nextDuration > 0 ? Math.min(100, (nextTime / nextDuration) * 100) : 0);
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || isDisabled) return;
    try {
      if (!isPlaying) {
        await audio.play();
      } else {
        pauseAudioElement(audio, true);
      }
    } catch (err) {
      setStatus(`error: ${getErrorMessage(err)}`);
    }
  }

  function handleSeek(nextPercent: number) {
    const audio = audioRef.current;
    setProgressPercent(nextPercent);
    if (!audio) return;
    const effectiveDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationSeconds;
    if (effectiveDuration <= 0) return;
    audio.currentTime = (nextPercent / 100) * effectiveDuration;
  }

  return (
    <div className={`session-audio-player${isDisabled ? " is-disabled" : ""}`}>
      <Button
        type="text"
        htmlType="button"
        aria-label={isPlaying ? "Пауза" : "Воспроизвести аудио"}
        onClick={() => void togglePlayback()}
        disabled={isDisabled}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          {isPlaying ? (
            <>
              <line x1="6.5" y1="4.5" x2="6.5" y2="15.5" />
              <line x1="13.5" y1="4.5" x2="13.5" y2="15.5" />
            </>
          ) : (
            <path d="M6 4.5 14.5 10 6 15.5Z" />
          )}
        </svg>
      </Button>
      <Slider
        min={0}
        max={100}
        step={1}
        aria-label="Позиция аудио"
        {...({ ariaLabelForHandle: "Позиция аудио" } as { ariaLabelForHandle: string })}
        value={Math.round(progressPercent)}
        tooltip={{ open: false }}
        onChange={(value) => handleSeek(Number(value))}
        disabled={isDisabled || durationSeconds <= 0}
      />
      <audio
        data-session-id={item.session_id}
        ref={audioRef}
        src={audioSrc || undefined}
        preload="metadata"
        onLoadedMetadata={syncProgressFromAudio}
        onTimeUpdate={syncProgressFromAudio}
        onEnded={() => {
          setIsPlaying(false);
          setProgressPercent(100);
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />
    </div>
  );
}
