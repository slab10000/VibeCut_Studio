"use client";
import { RefObject, useState, useRef } from "react";

interface VideoPlayerProps {
  videoUrl?: string | null;
  imageSrc?: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  title: string;
  subtitle?: string;
  emptyLabel?: string;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  fontOverlay?: {
    text: string;
    fontFamily: string;
    color: string;
    textShadow: string;
    cssFilter?: string;
    fontSize?: number;
  } | null;
}

function VolumeControl({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const applyVolume = (nextVolume: number, nextMuted: boolean) => {
    const video = videoRef.current;
    if (video) {
      video.volume = nextMuted ? 0 : nextVolume;
      video.muted = nextMuted;
    }
  };

  const handleVolumeChange = (value: number) => {
    setVolume(value);
    const nextMuted = value === 0;
    setMuted(nextMuted);
    applyVolume(value, nextMuted);
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    applyVolume(volume, nextMuted);
  };

  const displayVolume = muted ? 0 : volume;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        onClick={toggleMute}
        title={muted ? "Unmute" : "Mute"}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/5 text-white/85 transition hover:bg-white/8"
      >
        {displayVolume === 0 ? (
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
          </svg>
        ) : displayVolume < 0.5 ? (
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
          </svg>
        ) : (
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          </svg>
        )}
      </button>

      <div className="relative h-1.5 w-20 rounded-full bg-white/8">
        <div
          className="absolute h-full rounded-full bg-white/40"
          style={{ width: `${displayVolume * 100}%` }}
        />
        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={displayVolume}
          onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
    </div>
  );
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export default function VideoPlayer({
  videoUrl,
  imageSrc,
  videoRef,
  isPlaying,
  currentTime,
  duration,
  title,
  subtitle,
  emptyLabel,
  onTogglePlay,
  onSeek,
  fontOverlay,
}: VideoPlayerProps) {
  const hasVisual = Boolean(videoUrl || imageSrc);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = () => setIsFullscreen((prev) => !prev);

  return (
    <div ref={containerRef} className={`flex flex-1 h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-white/8 bg-[#111215]${isFullscreen ? " fixed inset-0 z-[100] rounded-none border-0" : ""}`}>
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">{title}</p>
          {subtitle && <p className="mt-1 truncate text-xs text-white/58">{subtitle}</p>}
        </div>
        <div className="shrink-0 rounded-full border border-white/8 bg-white/[0.04] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/34">
          {formatTime(duration)}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-white/6 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.1),_transparent_35%),linear-gradient(180deg,_#0b0d10,_#07080b)]">
          {videoUrl ? (
            <video
              id="main-player-video"
              ref={videoRef}
              src={videoUrl}
              className="h-full w-full object-contain"
              onClick={onTogglePlay}
              crossOrigin="anonymous"
            />
          ) : imageSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img 
              id="main-player-image"
              src={imageSrc} 
              alt="Timeline still" 
              className="h-full w-full object-contain" 
            />
          ) : (
            <div className="flex max-w-sm flex-col items-center text-center">
              <div className="mb-4 h-14 w-14 rounded-2xl border border-white/8 bg-white/[0.04]" />
              <p className="text-sm font-medium text-white/75">{emptyLabel || "No preview available"}</p>
              <p className="mt-2 text-xs leading-5 text-white/34">
                Import clips on the left and drag them into the sequence to build your edit.
              </p>
            </div>
          )}

          {hasVisual && !isPlaying && videoUrl && (
            <button
              onClick={onTogglePlay}
              className="absolute inset-0 flex items-center justify-center bg-black/24 transition hover:bg-black/18"
            >
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/92 shadow-[0_12px_36px_rgba(0,0,0,0.35)]">
                <svg className="ml-1 h-6 w-6 text-black" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </button>
          )}

          {fontOverlay && (
            <div className="absolute inset-x-8 bottom-12 flex justify-center text-center pointer-events-none">
              <span
                style={{
                  fontFamily: `'${fontOverlay.fontFamily}', sans-serif`,
                  color: fontOverlay.color,
                  textShadow: fontOverlay.textShadow,
                  filter: fontOverlay.cssFilter,
                  fontSize: fontOverlay.fontSize ? `${fontOverlay.fontSize}px` : "4rem",
                  lineHeight: 1.1,
                }}
              >
                {fontOverlay.text}
              </span>
            </div>
          )}
        </div>

        <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3 xl:flex-nowrap">
          <button
            onClick={onTogglePlay}
            disabled={!hasVisual || (!videoUrl && !imageSrc)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.05] text-white/85 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-35"
          >
            {isPlaying ? (
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
              </svg>
            ) : (
              <svg className="ml-0.5 h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <div className="relative h-1.5 min-w-[160px] flex-1 rounded-full bg-white/8">
            <div
              className="absolute h-full rounded-full bg-sky-400"
              style={{ width: duration ? `${(currentTime / duration) * 100}%` : "0%" }}
            />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.05}
              value={Math.min(currentTime, duration || 0)}
              onChange={(event) => onSeek(parseFloat(event.target.value))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </div>

          <span className="shrink-0 text-right text-xs font-medium tabular-nums text-white/48">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <VolumeControl videoRef={videoRef} />

          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.05] text-white/85 transition hover:bg-white/[0.08]"
          >
            {isFullscreen ? (
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
