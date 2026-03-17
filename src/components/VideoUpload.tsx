"use client";
import { useCallback, useState } from "react";

interface VideoUploadProps {
  onVideoSelected: (file: File, url: string) => void;
}

export default function VideoUpload({ onVideoSelected }: VideoUploadProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("video/")) return;
      const url = URL.createObjectURL(file);
      onVideoSelected(file, url);
    },
    [onVideoSelected]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`flex flex-col items-center justify-center w-full h-full min-h-[400px] border-2 border-dashed rounded-2xl transition-all cursor-pointer ${
        isDragging
          ? "border-violet-400 bg-violet-500/10"
          : "border-white/20 bg-white/5 hover:border-white/40 hover:bg-white/10"
      }`}
    >
      <div className="text-center p-8">
        <div className="text-5xl mb-4">🎬</div>
        <h2 className="text-xl font-semibold text-white mb-2">Drop your video here</h2>
        <p className="text-white/50 text-sm mb-6">or click to browse</p>
        <label className="px-6 py-3 bg-violet-600 hover:bg-violet-500 text-white rounded-xl font-medium cursor-pointer transition-colors">
          Choose Video
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </label>
      </div>
    </div>
  );
}
