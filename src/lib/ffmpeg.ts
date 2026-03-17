import { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
const FFMPEG_BASE_PATH = "/ffmpeg";

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg && ffmpeg.loaded) return ffmpeg;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const instance = new FFmpeg();
    try {
      // Use unpkg CDN for ffmpeg core assets to avoid local serving issues with MIME types,
      // cross-origin headers, and path resolution in complex Next.js builds.
      const coreURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js';
      const wasmURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';
      
      await instance.load({
        coreURL,
        wasmURL,
      });
    } catch (err) {
      // Reset so it can be retried
      loadPromise = null;
      throw new Error(`Failed to load ffmpeg.wasm: ${err instanceof Error ? err.message : err}`);
    }
    ffmpeg = instance;
    return instance;
  })();

  return loadPromise;
}

export async function extractAudio(
  videoData: Uint8Array,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const ff = await getFFmpeg();
  if (onProgress) {
    ff.on("progress", ({ progress }) => onProgress(progress));
  }
  await ff.writeFile("input.mp4", videoData);
  await ff.exec([
    "-i", "input.mp4",
    "-vn",
    "-acodec", "libmp3lame",
    "-ar", "16000",
    "-ac", "1",
    "-b:a", "64k",
    "audio.mp3",
  ]);
  const data = await ff.readFile("audio.mp3");
  await ff.deleteFile("input.mp4");
  await ff.deleteFile("audio.mp3");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Blob([data as any], { type: "audio/mp3" });
}
export async function mergeVideos(
  video1Data: Uint8Array,
  video2Data: Uint8Array,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const ff = await getFFmpeg();
  if (onProgress) {
    ff.on("progress", ({ progress }) => onProgress(progress));
  }

  await ff.writeFile("video1.mp4", video1Data);
  await ff.writeFile("video2.mp4", video2Data);

  // Create a concat list file
  const concatContent = "file video1.mp4\nfile video2.mp4";
  await ff.writeFile("list.txt", new TextEncoder().encode(concatContent));

  await ff.exec([
    "-f", "concat",
    "-safe", "0",
    "-i", "list.txt",
    "-c", "copy",
    "output.mp4"
  ]);

  const data = await ff.readFile("output.mp4");

  await ff.deleteFile("video1.mp4");
  await ff.deleteFile("video2.mp4");
  await ff.deleteFile("list.txt");
  await ff.deleteFile("output.mp4");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Blob([data as any], { type: "video/mp4" });
}
