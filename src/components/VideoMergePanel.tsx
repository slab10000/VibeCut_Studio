"use client";
import { useState } from "react";
import { LibraryClip } from "@/types";
import { mergeVideos } from "@/lib/ffmpeg";

interface VideoMergePanelProps {
  clips: LibraryClip[];
  onAddFiles: (files: File[]) => void;
}

export default function VideoMergePanel({ clips, onAddFiles }: VideoMergePanelProps) {
  const [video1Id, setVideo1Id] = useState<string>("");
  const [video2Id, setVideo2Id] = useState<string>("");
  const [isMerging, setIsMerging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const readyClips = clips.filter((c) => c.status === "ready");

  const handleMerge = async () => {
    if (!video1Id || !video2Id) return;
    if (video1Id === video2Id) {
      setError("Please select two different videos.");
      return;
    }

    const v1 = readyClips.find((c) => c.id === video1Id);
    const v2 = readyClips.find((c) => c.id === video2Id);

    if (!v1 || !v2) return;

    setIsMerging(true);
    setError(null);
    setProgress(0);

    try {
      const v1Data = new Uint8Array(await v1.file.arrayBuffer());
      const v2Data = new Uint8Array(await v2.file.arrayBuffer());

      const mergedBlob = await mergeVideos(v1Data, v2Data, (p) => {
        setProgress(Math.round(p * 100));
      });

      const mergedFile = new File([mergedBlob], `merged_${Date.now()}.mp4`, {
        type: "video/mp4",
      });

      onAddFiles([mergedFile]);
      setVideo1Id("");
      setVideo2Id("");
      setIsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setIsMerging(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex min-w-0 items-center gap-2 self-start rounded-xl bg-indigo-600/50 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-500/60"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
        Merge Two Videos
      </button>
    );
  }

  return (
    <div className="min-w-0 space-y-4 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">Merge Videos</h3>
        <button
          onClick={() => setIsOpen(false)}
          className="text-white/40 hover:text-white/60 text-lg"
        >
          &times;
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-[10px] uppercase tracking-[0.15em] text-white/40 mb-1">
            First Video
          </label>
          <select
            value={video1Id}
            onChange={(e) => setVideo1Id(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50"
          >
            <option value="" disabled className="bg-[#1e1f23]">Select a clip...</option>
            {readyClips.map((clip) => (
              <option key={clip.id} value={clip.id} className="bg-[#1e1f23]">
                {clip.fileName}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[10px] uppercase tracking-[0.15em] text-white/40 mb-1">
            Second Video
          </label>
          <select
            value={video2Id}
            onChange={(e) => setVideo2Id(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50"
          >
            <option value="" disabled className="bg-[#1e1f23]">Select a clip...</option>
            {readyClips.map((clip) => (
              <option key={clip.id} value={clip.id} className="bg-[#1e1f23]">
                {clip.fileName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {isMerging ? (
        <div className="space-y-2">
          <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
            <div 
              className="h-full bg-indigo-500 transition-all duration-300" 
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-center text-[11px] text-white/50">Merging... {progress}%</p>
        </div>
      ) : (
        <button
          onClick={handleMerge}
          disabled={!video1Id || !video2Id || video1Id === video2Id}
          className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
        >
          Start Merge
        </button>
      )}
    </div>
  );
}
