import type {
  AppCapabilities,
  DesktopBootstrap,
  EditCommandResponse,
  JobRecord,
  ProjectSnapshot,
  SequenceItem,
  TranscriptResponse,
} from "@/shared/contracts";
import { createPreviewUrl, importMedia, listenForFileDrop, listLibrary, pickVideoPaths } from "@/features/library/api";
import { searchTranscript } from "@/features/transcript/api";
import {
  aiGenerateEmbeddings,
  aiGenerateFont,
  aiGenerateImage,
  aiGenerateTransition,
  aiGenerateVideo,
  aiStyleSuggestions,
} from "@/features/ai/api";
import { pickSavePath } from "@/features/export/api";
import { desktopInvoke, isTauriRuntime, listenToJobUpdates } from "@/shared/desktop/transport";

export { createPreviewUrl, isTauriRuntime, listenForFileDrop, pickSavePath, pickVideoPaths };

export async function bootstrapProject(): Promise<DesktopBootstrap> {
  if (!isTauriRuntime()) {
    return {
      project: {
        projectId: "browser-preview",
        name: "Browser Preview",
        mediaAssets: [],
        sequenceItems: [],
      },
      jobs: [],
      capabilities: {
        ffmpegAvailable: false,
        ffprobeAvailable: false,
        sidecarAvailable: false,
        aiConfigured: false,
        hardwareEncoding: [],
        projectPath: "",
        cachePath: "",
      },
    };
  }

  return desktopInvoke<DesktopBootstrap>("project_bootstrap");
}

export async function getProjectSnapshot(): Promise<ProjectSnapshot> {
  if (!isTauriRuntime()) {
    return {
      projectId: "browser-preview",
      name: "Browser Preview",
      mediaAssets: [],
      sequenceItems: [],
    };
  }

  const project = await desktopInvoke<{ projectId: string; name: string }>("project_get");
  const [mediaAssets, sequenceItems] = await Promise.all([listLibrary(), desktopInvoke<SequenceItem[]>("timeline_get")]);

  return {
    ...project,
    mediaAssets,
    sequenceItems,
  };
}

export async function saveSequenceItems(sequenceItems: SequenceItem[]) {
  if (!isTauriRuntime()) return;
  await desktopInvoke("timeline_apply_patch", {
    patch: {
      kind: "replace_clips",
      clips: sequenceItems,
    },
  });
}

export { importMedia };

export async function transcribeAsset(assetId: string): Promise<TranscriptResponse | null> {
  if (!isTauriRuntime()) return null;
  return desktopInvoke<TranscriptResponse>("transcript_run", { assetId });
}

export { searchTranscript };

export async function getCapabilities(): Promise<AppCapabilities | null> {
  if (!isTauriRuntime()) return null;
  return desktopInvoke<AppCapabilities>("capabilities_get");
}

export async function getAiStatus() {
  if (!isTauriRuntime()) return { configured: false };
  return desktopInvoke<{ configured: boolean }>("ai_status");
}

export async function runEditCommand(
  command: string,
  transcript?: unknown,
  timeline?: unknown
): Promise<EditCommandResponse> {
  if (!isTauriRuntime()) {
    throw new Error("AI edit commands are only available in the desktop runtime.");
  }

  return desktopInvoke<EditCommandResponse>("ai_edit_command", {
    command,
    transcript: transcript ?? [],
    timeline: timeline ?? [],
  });
}

export async function listenToJobs(onEvent: (job: JobRecord) => void) {
  return listenToJobUpdates(onEvent);
}

export {
  aiGenerateEmbeddings,
  aiGenerateFont,
  aiGenerateImage,
  aiGenerateTransition,
  aiGenerateVideo,
  aiStyleSuggestions,
};

export async function exportTimeline(clips: SequenceItem[], outputPath: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error("Export requires the desktop runtime.");
  return desktopInvoke<string>("export_timeline", { clips, outputPath });
}

export async function mergeVideos(inputPaths: string[], outputPath: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error("Merge requires the desktop runtime.");
  return desktopInvoke<string>("merge_videos", { inputPaths, outputPath });
}
