"use client";
import { useEffect, useRef, useState } from "react";

interface CommandInputProps {
  onSubmit: (command: string) => void;
  isProcessing: boolean;
  lastExplanation?: string | null;
}

export default function CommandInput({ onSubmit, isProcessing, lastExplanation }: CommandInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [value]);

  const handleSubmit = () => {
    if (value.trim() && !isProcessing) {
      onSubmit(value.trim());
      setValue("");
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-2">
        <textarea
          ref={textareaRef}
          placeholder='Try: "make this snappier", "remove the introduction", "cut filler words"...'
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
          disabled={isProcessing}
          rows={4}
          className="min-h-28 w-full resize-none overflow-y-auto rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-white placeholder-white/25 focus:border-violet-500/50 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={isProcessing || !value.trim()}
          className="flex self-end items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isProcessing ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Edit
            </>
          )}
        </button>
      </div>
      <p className="px-1 text-[11px] text-white/32">Press Ctrl/Cmd + Enter to submit.</p>
      {lastExplanation && (
        <p className="text-xs text-violet-300/70 px-1">{lastExplanation}</p>
      )}
    </div>
  );
}
