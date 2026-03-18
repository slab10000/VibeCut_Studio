import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AiFontResponse,
  AiImageResponse,
  AiStyleSuggestion,
  AiVideoResponse,
  EditCommandResponse,
  JobRecord,
} from "@/shared/contracts";
import { desktopInvoke, isTauriRuntime } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";

export async function enqueueAiEditCommand(
  command: string,
  transcript: unknown,
  timeline: unknown
): Promise<JobRecord> {
  return desktopInvoke<JobRecord>("ai_enqueue_edit_command", {
    command,
    transcript: transcript ?? [],
    timeline: timeline ?? [],
  });
}

export function parseAiEditResult(job: JobRecord | undefined | null): EditCommandResponse | null {
  if (!job?.result) return null;
  const operations = Array.isArray(job.result.operations) ? (job.result.operations as EditCommandResponse["operations"]) : [];
  const explanation = typeof job.result.explanation === "string" ? job.result.explanation : "Edit applied";
  return { operations, explanation };
}

export function useEnqueueAiEditMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ command, transcript, timeline }: { command: string; transcript: unknown; timeline: unknown }) =>
      enqueueAiEditCommand(command, transcript, timeline),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

export async function aiGenerateImage(
  prompt: string,
  referenceBase64?: string,
  referenceMime?: string
): Promise<AiImageResponse> {
  if (!isTauriRuntime()) throw new Error("AI features require the desktop runtime.");
  return desktopInvoke<AiImageResponse>("ai_generate_image", {
    prompt,
    referenceBase64: referenceBase64 ?? null,
    referenceMime: referenceMime ?? null,
  });
}

export async function aiStyleSuggestions(text: string, referenceImage?: string): Promise<AiStyleSuggestion[]> {
  if (!isTauriRuntime()) throw new Error("AI features require the desktop runtime.");
  return desktopInvoke<AiStyleSuggestion[]>("ai_style_suggestions", {
    text,
    referenceImage: referenceImage ?? null,
  });
}

export async function aiGenerateVideo(
  prompt: string,
  imageBase64: string,
  imageMimeType: string
): Promise<AiVideoResponse> {
  if (!isTauriRuntime()) throw new Error("AI features require the desktop runtime.");
  return desktopInvoke<AiVideoResponse>("ai_generate_video", {
    prompt,
    imageBase64,
    imageMimeType,
  });
}

export async function aiGenerateTransition(
  lastFrameBase64: string,
  startFrameBase64?: string,
  description?: string
): Promise<AiVideoResponse> {
  if (!isTauriRuntime()) throw new Error("AI features require the desktop runtime.");
  return desktopInvoke<AiVideoResponse>("ai_generate_transition", {
    lastFrameBase64,
    startFrameBase64: startFrameBase64 ?? null,
    description: description ?? null,
  });
}

export async function aiGenerateFont(imageBase64: string): Promise<AiFontResponse> {
  if (!isTauriRuntime()) throw new Error("AI features require the desktop runtime.");
  return desktopInvoke<AiFontResponse>("ai_generate_font", { imageBase64 });
}

export async function aiGenerateEmbeddings(texts: string[]): Promise<{ embeddings: number[][] }> {
  if (!isTauriRuntime()) throw new Error("AI features require the desktop runtime.");
  return desktopInvoke<{ embeddings: number[][] }>("ai_generate_embeddings", { texts });
}
