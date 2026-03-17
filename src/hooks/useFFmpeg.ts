"use client";
import { useState, useCallback } from "react";
import { getFFmpeg, extractAudio } from "@/lib/ffmpeg";

export function useFFmpeg() {
  const [isLoading, setIsLoading] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [progress, setProgress] = useState(0);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      await getFFmpeg();
      setIsLoaded(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const extractAudioFromVideo = useCallback(async (videoFile: File): Promise<Blob> => {
    setIsLoading(true);
    setProgress(0);
    try {
      const data = new Uint8Array(await videoFile.arrayBuffer());
      const audioBlob = await extractAudio(data, (p) => setProgress(p));
      return audioBlob;
    } finally {
      setIsLoading(false);
      setProgress(1);
    }
  }, []);

  return { isLoading, isLoaded, progress, load, extractAudioFromVideo };
}
