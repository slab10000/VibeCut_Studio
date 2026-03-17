"use client";
import { useState } from "react";
import Image from "next/image";

interface AssetGenPanelProps {
  onInsertImage: (imageSrc: string) => void;
  onAddFiles: (files: File[]) => void;
  contextText?: string;
}

export default function AssetGenPanel({ onInsertImage, onAddFiles, contextText }: AssetGenPanelProps) {
  const [activeTab, setActiveTab] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [generatedVideo, setGeneratedVideo] = useState<string | null>(null);
  const [generatedVideoFile, setGeneratedVideoFile] = useState<File | null>(null);
  
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleGenerate = async () => {
    const finalPrompt = prompt.trim() || (contextText ? `Create a visual illustration for: ${contextText}` : "");
    if (!finalPrompt) return;

    setIsGenerating(true);
    setError(null);
    setGeneratedImage(null);
    setGeneratedVideo(null);
    setGeneratedVideoFile(null);

    try {
      if (activeTab === "image") {
        const res = await fetch("/api/generate-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: finalPrompt }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Image generation failed");
        }

        const { imageBase64, mimeType } = await res.json();
        const src = `data:${mimeType};base64,${imageBase64}`;
        setGeneratedImage(src);
      } else {
        const res = await fetch("/api/generate-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: finalPrompt }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Video generation failed");
        }

        const { videoBase64, mimeType } = await res.json();
        const src = `data:${mimeType};base64,${videoBase64}`;
        setGeneratedVideo(src);
        
        // Convert base64 to File
        const fetchRes = await fetch(src);
        const blob = await fetchRes.blob();
        const file = new File([blob], `AI_Video_${Date.now()}.mp4`, { type: mimeType });
        setGeneratedVideoFile(file);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setIsGenerating(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex min-w-0 items-center gap-2 self-start rounded-xl bg-amber-600/50 px-4 py-2 text-sm text-white transition-colors hover:bg-amber-500/60"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        Generate Media
      </button>
    );
  }

  return (
    <div className="min-w-0 space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">Generate Media</h3>
        <button
          onClick={() => setIsOpen(false)}
          className="text-white/40 hover:text-white/60 text-lg"
        >
          x
        </button>
      </div>

      <div className="flex gap-2 rounded-lg bg-white/5 p-1">
        <button
          onClick={() => setActiveTab("image")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            activeTab === "image" ? "bg-amber-600 text-white" : "text-white/60 hover:text-white/80"
          }`}
        >
          Image
        </button>
        <button
          onClick={() => setActiveTab("video")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            activeTab === "video" ? "bg-amber-600 text-white" : "text-white/60 hover:text-white/80"
          }`}
        >
          Video
        </button>
      </div>

      <textarea
        placeholder={`Describe the ${activeTab} you want to generate...`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50 resize-none"
      />

      <button
        onClick={handleGenerate}
        disabled={isGenerating || (!prompt.trim() && !contextText)}
        className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
      >
        {isGenerating ? `Generating ${activeTab}...` : "Generate"}
      </button>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {generatedImage && activeTab === "image" && (
        <div className="space-y-2">
          <Image
            src={generatedImage}
            alt="Generated Image"
            width={1024}
            height={1024}
            unoptimized
            className="w-full rounded-lg"
          />
          <button
            onClick={() => {
              onInsertImage(generatedImage);
              setGeneratedImage(null);
              setPrompt("");
            }}
            className="w-full px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Insert into Timeline
          </button>
        </div>
      )}

      {generatedVideo && activeTab === "video" && (
        <div className="space-y-2">
          <video
            src={generatedVideo}
            autoPlay
            loop
            muted
            className="w-full rounded-lg bg-black"
          />
          <button
            onClick={() => {
              if (generatedVideoFile) {
                onAddFiles([generatedVideoFile]);
                setGeneratedVideo(null);
                setGeneratedVideoFile(null);
                setPrompt("");
              }
            }}
            className="w-full px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Add to Library
          </button>
        </div>
      )}
    </div>
  );
}
