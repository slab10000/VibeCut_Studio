"use client";
import { useState, useEffect } from "react";
import { FontOverlayData } from "./VibeFontPanel";

interface TextEditorBarProps {
  onApply: (data: FontOverlayData) => void;
  initialData?: FontOverlayData | null;
}

const COMMON_FONTS = [
  "Inter", "Roboto", "Outfit", "Playfair Display", "Montserrat", 
  "Bebas Neue", "Pacifico", "Syncopate", "Orbitron"
];

const PRESET_COLORS = [
  "#FFFFFF", "#F87171", "#FB923C", "#FBBF24", "#34D399", 
  "#38BDF8", "#818CF8", "#A78BFA", "#F472B6"
];

export default function TextEditorBar({ onApply, initialData }: TextEditorBarProps) {
  const [text, setText] = useState(initialData?.text || "CUSTOM TEXT");
  const [fontFamily, setFontFamily] = useState(initialData?.fontFamily || "Inter");
  const [color, setColor] = useState(initialData?.color || "#FFFFFF");
  const [fontSize, setFontSize] = useState(initialData?.fontSize || 64);
  const [textShadow, setTextShadow] = useState(initialData?.textShadow || "2px 2px 4px rgba(0,0,0,0.5)");

  useEffect(() => {
    if (initialData) {
      setText(initialData.text);
      setFontFamily(initialData.fontFamily);
      setColor(initialData.color);
      setFontSize(initialData.fontSize || 64);
      setTextShadow(initialData.textShadow);
    }
  }, [initialData]);

  const handleApply = () => {
    // Ensure font is loaded
    const fontUrl = `https://fonts.googleapis.com/css2?family=${fontFamily.replace(/ /g, '+')}&display=swap`;
    if (!document.querySelector(`link[href="${fontUrl}"]`)) {
      const link = document.createElement("link");
      link.href = fontUrl;
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }

    onApply({
      text,
      fontFamily,
      color,
      fontSize,
      textShadow,
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between border-b border-white/8 pb-3">
        <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Text Editor</p>
        <button
          onClick={handleApply}
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-black transition hover:bg-sky-400"
        >
          Apply Changes
        </button>
      </div>

      <div className="space-y-4">
        {/* Text Input */}
        <div>
          <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-white/25">Content</label>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-xl border border-white/8 bg-black/20 px-4 py-2.5 text-sm text-white transition focus:border-sky-500/50 focus:outline-none"
            placeholder="Enter text..."
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Font Selector */}
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-white/25">Typography</label>
            <select
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              className="w-full rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 text-sm text-white transition focus:border-sky-500/50 focus:outline-none"
            >
              {COMMON_FONTS.map((font) => (
                <option key={font} value={font} style={{ fontFamily: font }}>
                  {font}
                </option>
              ))}
            </select>
          </div>

          {/* Font Size */}
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-white/25">Font Size ({fontSize}px)</label>
            <input
              type="range"
              min="12"
              max="200"
              value={fontSize}
              onChange={(e) => setFontSize(parseInt(e.target.value))}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/8 accent-sky-400"
            />
          </div>
        </div>

        {/* Color Picker */}
        <div>
          <label className="mb-1.5 block text-[10px] uppercase tracking-wider text-white/25">Color</label>
          <div className="flex flex-wrap gap-2">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-full border-2 transition ${
                  color === c ? "border-white scale-110 shadow-lg shadow-white/10" : "border-transparent hover:scale-105"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-6 w-6 cursor-pointer border-none bg-transparent"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
