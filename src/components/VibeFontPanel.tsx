import { useState, RefObject, useCallback } from "react";
import {
  aiGenerateFont,
  aiStyleSuggestions,
  aiGenerateImage,
  aiGenerateVideo,
  createPreviewUrl,
} from "@/lib/desktop-client";

export interface FontOverlayData {
  text: string;
  fontFamily: string;
  color: string;
  textShadow: string;
  cssFilter?: string;
  fontSize?: number;
}

interface VibeFontPanelProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  onApplyFont?: (overlay: FontOverlayData) => void;
}

type Step = "input" | "generating-style" | "style-review" | "generating-image" | "image-review" | "generating-video";
type Mode = "overlay" | "video";

export default function VibeFontPanel({ videoRef, onApplyFont }: VibeFontPanelProps) {
  const [mode, setMode] = useState<Mode>("overlay");
  const [text, setText] = useState("VIBE CUT");

  const [step, setStep] = useState<Step>("input");
  const [suggestions, setSuggestions] = useState<{ style: string; typography: string }[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [referenceFrame, setReferenceFrame] = useState<string | null>(null);
  const [baseImages, setBaseImages] = useState<{ data: string; mimeType: string }[]>([]);

  const [isGeneratingOverlay, setIsGeneratingOverlay] = useState(false);
  const [generatedFont, setGeneratedFont] = useState<Omit<FontOverlayData, "text"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  }, [videoRef]);

  const handleGenerateOverlay = async () => {
    const frameBase64 = captureFrame();
    if (!frameBase64) {
      setError("Failed to capture video frame. Is a video playing?");
      return;
    }

    setIsGeneratingOverlay(true);
    setError(null);

    try {
      const data = await aiGenerateFont(frameBase64);

      const fontUrl = `https://fonts.googleapis.com/css2?family=${data.fontFamily.replace(/ /g, "+")}&display=swap`;
      if (!document.querySelector(`link[href="${fontUrl}"]`)) {
        const link = document.createElement("link");
        link.href = fontUrl;
        link.rel = "stylesheet";
        document.head.appendChild(link);
      }

      setGeneratedFont({
        fontFamily: data.fontFamily,
        color: data.color,
        textShadow: data.textShadow,
        cssFilter: data.cssFilter,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setIsGeneratingOverlay(false);
    }
  };

  const handleApplyOverlay = () => {
    if (generatedFont && onApplyFont) {
      onApplyFont({ text: text || "VibeCut", ...generatedFont });
    }
  };

  const handleStartVideo = async () => {
    const frameBase64 = captureFrame();
    if (!frameBase64) {
      setError("Failed to capture video frame. Is a video playing?");
      return;
    }

    setReferenceFrame(frameBase64);
    setStep("generating-style");
    setError(null);

    try {
      const rawSuggestions = await aiStyleSuggestions(text, frameBase64);
      setSuggestions(rawSuggestions);
      setStep("style-review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Style generation failed");
      setStep("input");
    }
  };

  const handleGenerateImage = async () => {
    setStep("generating-image");
    setError(null);

    try {
      const imagePromises = suggestions.map((s) =>
        aiGenerateImage(
          `Create a cinematic image featuring the text "${text}". Typography: ${s.typography}. Style: ${s.style}.`,
          referenceFrame ?? undefined,
          "image/jpeg"
        )
      );

      const results = await Promise.all(imagePromises);
      setBaseImages(
        results.map((r) => ({
          data: `data:${r.mimeType};base64,${r.imageBase64}`,
          mimeType: r.mimeType,
        }))
      );
      setStep("image-review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate preview images");
      setStep("style-review");
    }
  };

  const handleGenerateVideo = async () => {
    setStep("generating-video");
    setError(null);

    if (selectedIndex === null || !suggestions[selectedIndex] || !baseImages[selectedIndex]) return;
    const selectedSuggestion = suggestions[selectedIndex];
    const selectedImage = baseImages[selectedIndex];

    try {
      const result = await aiGenerateVideo(
        `Cinematic animation. ${selectedSuggestion.style}. High quality, 8k, smooth motion.`,
        selectedImage.data,
        selectedImage.mimeType
      );

      // Video saved to disk by Rust — show preview via asset URL
      const previewUrl = createPreviewUrl(result.videoPath);
      if (previewUrl) {
        // Could add to library or play preview here
        console.log("Generated video at:", result.videoPath);
      }

      setStep("input");
      setBaseImages([]);
      setSuggestions([]);
      setSelectedIndex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Video generation failed");
      setStep("image-review");
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="border-b border-white/8 px-4 py-3">
        <p className="text-sm font-medium text-white/84">Cinematic Text</p>
        <p className="mt-1 text-xs leading-5 text-white/38">
          Add dynamic text overlays to the current frame or generate AI intro videos.
        </p>
      </div>

      <div className="flex gap-2 p-4 pb-0">
        <button
          onClick={() => setMode("overlay")}
          className={`px-3 py-1.5 text-[11px] font-medium rounded-lg uppercase tracking-widest transition-colors ${mode === "overlay" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/60"}`}
        >
          Overlay
        </button>
        <button
          onClick={() => setMode("video")}
          className={`px-3 py-1.5 text-[11px] font-medium rounded-lg uppercase tracking-widest transition-colors ${mode === "video" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/60"}`}
        >
          AI Video Intro
        </button>
      </div>

      <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto overflow-x-hidden p-4">
        {mode === "overlay" && (
          <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
            <input
              type="text"
              placeholder="Text to display..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-violet-500/50 focus:outline-none"
            />

            <button
              onClick={handleGenerateOverlay}
              disabled={isGeneratingOverlay}
              className="w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isGeneratingOverlay ? "Analyzing Frame..." : "Generate VibeFont Overlay"}
            </button>

            {error && <p className="text-xs text-red-400">{error}</p>}

            {generatedFont && (
              <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
                <div
                  className="flex min-h-[80px] items-center justify-center rounded-lg bg-black/40 p-4 text-center overflow-hidden"
                  style={{
                    fontFamily: `'${generatedFont.fontFamily}', sans-serif`,
                    color: generatedFont.color,
                    textShadow: generatedFont.textShadow,
                    filter: generatedFont.cssFilter,
                    fontSize: "2rem",
                  }}
                >
                  {text || "Preview text"}
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] text-white/50">
                  <div className="rounded bg-black/20 p-2">
                    <span className="block text-white/30">Font</span>
                    {generatedFont.fontFamily}
                  </div>
                  <div className="rounded bg-black/20 p-2">
                    <span className="block text-white/30">Color</span>
                    {generatedFont.color}
                  </div>
                </div>

                <button
                  onClick={handleApplyOverlay}
                  className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
                >
                  Apply Overlay to Video
                </button>
              </div>
            )}
          </div>
        )}

        {mode === "video" && (
          <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
            {step === "input" && (
              <>
                <input
                  type="text"
                  placeholder="Cinematic Text..."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-violet-500/50 focus:outline-none"
                />
                <button
                  onClick={handleStartVideo}
                  disabled={!text}
                  className="w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Start Magic Video Generator
                </button>
                {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
              </>
            )}

            {step === "generating-style" && (
              <div className="py-8 text-center text-sm text-white/60 animate-pulse">
                Dreaming up art direction...
              </div>
            )}

            {step === "style-review" && (
              <div className="space-y-4">
                <p className="text-[10px] uppercase tracking-widest text-white/40">Choose AI Art Direction</p>
                <div className="space-y-3">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedIndex(i === selectedIndex ? null : i)}
                      className={`w-full text-left rounded-xl border p-3 transition-all ${
                        selectedIndex === i
                          ? "border-sky-400 bg-sky-400/10"
                          : "border-white/10 bg-white/5 hover:bg-white/8"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`mt-1 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center ${selectedIndex === i ? "border-sky-400" : "border-white/20"}`}>
                          {selectedIndex === i && <div className="h-2 w-2 rounded-full bg-sky-400" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-white/90">Option {i + 1}</p>
                          <p className="mt-1 text-[11px] leading-relaxed text-white/60 line-clamp-2 italic">&quot;{s.style}&quot;</p>
                          <p className="mt-1 text-[10px] text-white/40 truncate">Font: {s.typography}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setStep("input")}
                    className="flex-1 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleGenerateImage}
                    disabled={selectedIndex === null}
                    className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Generate Previews
                  </button>
                </div>
              </div>
            )}

            {step === "generating-image" && (
              <div className="py-8 text-center">
                <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-emerald-500 mb-3" />
                <p className="text-sm text-white/60">Compositing cinematic base plates...</p>
              </div>
            )}

            {step === "image-review" && (
              <div className="space-y-4">
                <p className="text-[10px] uppercase tracking-widest text-white/40">Select the best base frame</p>
                <div className="grid grid-cols-1 gap-3">
                  {baseImages.map((img, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedIndex(i)}
                      className={`relative aspect-[16/9] overflow-hidden rounded-xl border-2 transition-all ${
                        selectedIndex === i ? "border-amber-500 ring-2 ring-amber-500/50" : "border-white/10 opacity-70 hover:opacity-100"
                      }`}
                    >
                      <img src={img.data} alt={`Option ${i + 1}`} className="absolute inset-0 h-full w-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 bg-black/60 p-2 backdrop-blur-sm">
                        <p className="text-[10px] text-white/90 truncate italic">&quot;{suggestions[i]?.style}&quot;</p>
                      </div>
                      {selectedIndex === i && (
                        <div className="absolute top-2 right-2 rounded-full bg-amber-500 p-1 shadow-lg">
                          <svg className="h-3 w-3 text-black" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                          </svg>
                        </div>
                      )}
                    </button>
                  ))}
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setStep("style-review")}
                    className="flex-1 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleGenerateVideo}
                    disabled={selectedIndex === null}
                    className="flex-1 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                  >
                    Animate with Veo
                  </button>
                </div>
                {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
              </div>
            )}

            {step === "generating-video" && (
              <div className="py-12 text-center">
                <div className="inline-block h-10 w-10 animate-spin rounded-full border-4 border-amber-500/20 border-t-amber-500 mb-4" />
                <p className="text-sm text-amber-500 font-medium">Synthesizing with Veo 3.1...</p>
                <p className="mt-2 text-[11px] text-white/40">This usually takes 2-3 minutes</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
