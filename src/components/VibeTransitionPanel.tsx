"use client";

import { useState, useRef } from "react";
import Image from "next/image";

interface VibeTransitionPanelProps {
  onTransitionGenerated: (videoUri: string) => void;
  onCancel: () => void;
}

export default function VibeTransitionPanel({ onTransitionGenerated, onCancel }: VibeTransitionPanelProps) {
  const [step, setStep] = useState<"capture-a" | "capture-b" | "review" | "generating">("capture-a");
  const [frameA, setFrameA] = useState<string | null>(null);
  const [frameB, setFrameB] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const captureFrame = (target: "a" | "b") => {
    const videoEl = document.getElementById("main-player-video") as HTMLVideoElement | null;
    const imageEl = document.getElementById("main-player-image") as HTMLImageElement | null;
    
    let dataUrl = "";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (videoEl && videoEl.videoWidth > 0) {
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0);
      dataUrl = canvas.toDataURL("image/png");
    } else if (imageEl && imageEl.complete) {
      canvas.width = imageEl.naturalWidth;
      canvas.height = imageEl.naturalHeight;
      ctx.drawImage(imageEl, 0, 0);
      dataUrl = canvas.toDataURL("image/png");
    } else {
      setError("No active video or image found in player to capture.");
      return;
    }
    
    if (target === "a") {
      setFrameA(dataUrl);
      setStep("capture-b");
    } else {
      setFrameB(dataUrl);
      setStep("review");
    }
    setError(null);
  };

  const handleGenerate = async () => {
    if (!frameA) return;

    setStep("generating");
    setError(null);

    try {
      const response = await fetch("/api/vibe-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "transition",
          lastFrameBase64: frameA,
          startFrameBBase64: frameB || undefined,
          imageMimeType: "image/png",
          nextClipDescription: description || undefined
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      onTransitionGenerated(data.videoUri);
    } catch (err: any) {
      setError(err.message);
      setStep("review");
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-black/80 p-5 backdrop-blur-2xl shadow-2xl overflow-hidden">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white/90">AI Vibe Transition</h3>
            <p className="text-[10px] uppercase tracking-wider text-white/40">Automatic Join Mode</p>
          </div>
        </div>
        <button onClick={onCancel} className="p-1 text-white/40 hover:text-white/60 transition-colors">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {step === "capture-a" && (
        <div className="space-y-6">
          <div className="rounded-lg bg-sky-500/10 p-4 border border-sky-500/20">
            <p className="text-xs leading-relaxed text-sky-200/80">
              <span className="font-bold text-sky-400">Step 1:</span> Pause the video at the <span className="underline underline-offset-4">end</span> of your first clip.
            </p>
          </div>
          <button
            onClick={() => captureFrame("a")}
            className="group relative w-full overflow-hidden rounded-xl bg-sky-600 px-4 py-4 text-sm font-semibold text-white shadow-lg shadow-sky-900/40 hover:bg-sky-500 transition-all active:scale-[0.98]"
          >
            <span className="relative z-10">Capture End of Clip A</span>
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
          </button>
        </div>
      )}

      {step === "capture-b" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
            <div className="h-4 w-4 flex items-center justify-center rounded-full bg-green-500/20 text-green-400 text-[10px] font-bold">✓</div>
            <span>Clip A Captured</span>
          </div>
          <div className="rounded-lg bg-purple-500/10 p-4 border border-purple-500/20">
            <p className="text-xs leading-relaxed text-purple-200/80">
              <span className="font-bold text-purple-400">Step 2:</span> Seek and pause at the <span className="underline underline-offset-4">start</span> of your next clip.
            </p>
          </div>
          <button
            onClick={() => captureFrame("b")}
            className="group relative w-full overflow-hidden rounded-xl bg-purple-600 px-4 py-4 text-sm font-semibold text-white shadow-lg shadow-purple-900/40 hover:bg-purple-500 transition-all active:scale-[0.98]"
          >
            <span className="relative z-10">Capture Start of Clip B</span>
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
          </button>
          <button onClick={() => setStep("capture-a")} className="w-full text-[10px] uppercase tracking-widest text-white/30 hover:text-white/60 transition-colors">Reselect Clip A</button>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-6">
          <div className="flex gap-3">
            <div className="flex-1 space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-white/40 text-center">Clip A End</p>
              <div className="aspect-video relative overflow-hidden rounded-lg bg-black/40 border border-white/5 ring-1 ring-white/10">
                {frameA && <Image src={frameA} alt="Clip A" fill className="object-cover" unoptimized />}
              </div>
            </div>
            <div className="flex-1 space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-white/40 text-center">Clip B Start</p>
              <div className="aspect-video relative overflow-hidden rounded-lg bg-black/40 border border-white/5 ring-1 ring-white/10">
                {frameB && <Image src={frameB} alt="Clip B" fill className="object-cover" unoptimized />}
              </div>
            </div>
          </div>
          
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] uppercase tracking-[0.2em] text-white/30 font-semibold">Evolution Prompt (Optional)</label>
              <span className="text-[9px] text-sky-400/60 font-mono italic">Gemini will auto-fill if empty</span>
            </div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Gemini will decide the transition based on the clips above..."
              rows={2}
              className="w-full rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 text-xs text-white placeholder:text-white/20 focus:outline-none focus:ring-2 focus:ring-sky-500/40 transition-all resize-none shadow-inner"
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep("capture-b")}
              className="flex-1 rounded-xl bg-white/5 px-4 py-4 text-sm font-semibold text-white hover:bg-white/10 border border-white/10 transition-all"
            >
              Back
            </button>
            <button
              onClick={handleGenerate}
              className="flex-[2] relative overflow-hidden rounded-xl bg-gradient-to-r from-sky-600 to-sky-500 px-4 py-4 text-sm font-bold text-white shadow-[0_0_20px_rgba(14,165,233,0.3)] hover:shadow-[0_0_30px_rgba(14,165,233,0.5)] transition-all active:scale-[0.98]"
            >
              Generate AI Join
            </button>
          </div>
          {error && <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-center">{error}</p>}
        </div>
      )}

      {step === "generating" && (
        <div className="py-16 text-center">
          <div className="relative inline-block mb-6">
            <div className="absolute inset-0 blur-xl bg-sky-500/20 animate-pulse rounded-full" />
            <div className="relative h-16 w-16 animate-spin rounded-full border-4 border-white/5 border-t-sky-500 shadow-[0_0_15px_rgba(14,165,233,0.4)]" />
          </div>
          <h4 className="text-sm font-bold text-sky-400 font-mono uppercase tracking-[0.3em] mb-2 animate-pulse">Dreaming Sequence...</h4>
          <p className="text-[10px] text-white/30 max-w-[200px] mx-auto leading-relaxed">
            Gemini is analyzing the cinematic flow and synthesizing your evolve-state bridge.
          </p>
        </div>
      )}
    </div>
  );
}
