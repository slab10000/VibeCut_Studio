"use client";
import { RefObject, useState, useRef, useEffect } from "react";

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

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch((err) => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <div ref={containerRef} className="flex flex-1 h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-white/8 bg-[#111215]">
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
