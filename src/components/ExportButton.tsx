"use client";
import { useState } from "react";
import { TimelineClip } from "@/types";
import { getFFmpeg } from "@/lib/ffmpeg";

interface ExportButtonProps {
  clips: TimelineClip[];
  videoFile: File | null;
}

export default function ExportButton({ clips, videoFile }: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleExport = async () => {
    if (!videoFile || clips.length === 0) return;

    setIsExporting(true);
    setProgress(0);

    try {
      const ff = await getFFmpeg();
      ff.on("progress", ({ progress: p }) => setProgress(p));

      // Write video source
      const videoData = new Uint8Array(await videoFile.arrayBuffer());
      await ff.writeFile("source.mp4", videoData);

      // Write image files
      const imageClips = clips.filter((c) => c.type === "image" && c.imageSrc);
      for (let i = 0; i < imageClips.length; i++) {
        const clip = imageClips[i];
        const base64 = clip.imageSrc!.split(",")[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
        await ff.writeFile(`img_${i}.png`, bytes);
      }

      // Build concat file
      const filterParts: string[] = [];
      const concatInputs: string[] = [];

      let inputIdx = 0;
      // Always add the source video as input 0
      const args: string[] = ["-i", "source.mp4"];
      inputIdx = 1;

      // Add image inputs
      for (let i = 0; i < imageClips.length; i++) {
        args.push("-loop", "1", "-t", String(imageClips[i].duration), "-i", `img_${i}.png`);
      }

      // Build filter complex
      let filterIdx = 0;

      for (const clip of clips) {
        if (clip.type === "video") {
          const label = `v${filterIdx}`;
          const alabel = `a${filterIdx}`;
          filterParts.push(
            `[0:v]trim=start=${clip.sourceStartTime}:end=${clip.sourceEndTime},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[${label}]`
          );
          filterParts.push(
            `[0:a]atrim=start=${clip.sourceStartTime}:end=${clip.sourceEndTime},asetpts=PTS-STARTPTS[${alabel}]`
          );
          concatInputs.push(`[${label}][${alabel}]`);
          filterIdx++;
        } else if (clip.type === "image" && clip.imageSrc) {
          const label = `v${filterIdx}`;
          const alabel = `a${filterIdx}`;
          filterParts.push(
            `[${inputIdx}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[${label}]`
          );
          filterParts.push(
            `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${clip.duration}[${alabel}]`
          );
          concatInputs.push(`[${label}][${alabel}]`);
          inputIdx++;
          filterIdx++;
        }
      }

      if (filterIdx === 0) {
        setIsExporting(false);
        return;
      }

      filterParts.push(
        `${concatInputs.join("")}concat=n=${filterIdx}:v=1:a=1[outv][outa]`
      );

      args.push(
        "-filter_complex",
        filterParts.join(";"),
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "fast",
        "-c:a", "aac",
        "-y",
        "output.mp4"
      );

      await ff.exec(args);

      const rawData = await ff.readFile("output.mp4");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = new Blob([rawData as any], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "vibecut-studio-export.mp4";
      a.click();
      URL.revokeObjectURL(url);

      // Cleanup
      await ff.deleteFile("source.mp4");
      await ff.deleteFile("output.mp4");
      for (let i = 0; i < imageClips.length; i++) {
        try { await ff.deleteFile(`img_${i}.png`); } catch {}
      }
    } catch (err) {
      console.error("Export error:", err);
      alert("Export failed. Check console for details.");
    } finally {
      setIsExporting(false);
      setProgress(0);
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={isExporting || !videoFile || clips.length === 0}
      className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors flex items-center gap-2"
    >
      {isExporting ? (
        <>
          <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          Exporting {Math.round(progress * 100)}%
        </>
      ) : (
        <>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export
        </>
      )}
    </button>
  );
}
