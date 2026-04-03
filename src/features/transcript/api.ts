import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobRecord, MediaAsset, SearchHit } from "@/shared/contracts";
import { desktopInvoke, isTauriRuntime } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";
import { createPreviewUrl } from "@/features/library/api";

export interface TranscriptEnqueueInput {
  assetId: string;
  language?: string | null;
  discardManualCorrections?: boolean;
}

export interface ManualWordTimingInput {
  assetId: string;
  wordId: string;
  startTime: number;
  endTime: number;
}

function hydrateAsset(asset: MediaAsset): MediaAsset {
  return {
    ...asset,
    previewUrl: createPreviewUrl(asset.proxyPath || asset.previewPath || asset.sourcePath),
  };
}

export async function getTranscript(assetId: string): Promise<MediaAsset | null> {
  if (!isTauriRuntime()) return null;
  const asset = await desktopInvoke<MediaAsset>("transcript_get", { assetId });
  return hydrateAsset(asset);
}

export async function enqueueTranscript(input: TranscriptEnqueueInput): Promise<JobRecord> {
  return desktopInvoke<JobRecord>("transcript_enqueue", {
    assetId: input.assetId,
    language: input.language ?? undefined,
    discardManualCorrections: input.discardManualCorrections ?? false,
  });
}

export async function updateTranscriptWordTiming(input: ManualWordTimingInput): Promise<MediaAsset> {
  return desktopInvoke<MediaAsset>("transcript_update_word_timing", {
    assetId: input.assetId,
    wordId: input.wordId,
    startTime: input.startTime,
    endTime: input.endTime,
  }).then(hydrateAsset);
}

export async function searchTranscript(query: string): Promise<SearchHit[]> {
  if (!isTauriRuntime()) return [];
  return desktopInvoke<SearchHit[]>("search_query", { query });
}

export function useTranscriptQuery(assetId: string | null) {
  return useQuery({
    queryKey: queryKeys.transcript(assetId),
    queryFn: () => (assetId ? getTranscript(assetId) : Promise.resolve(null)),
    enabled: Boolean(assetId),
  });
}

export function useEnqueueTranscriptMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: enqueueTranscript,
    onMutate: async ({ assetId }) => {
      const markPending = (asset: MediaAsset | null | undefined) => {
        if (!asset) return asset ?? null;
        return hydrateAsset({
          ...asset,
          status: "processing",
          transcriptStatus: "processing",
          error: null,
        });
      };

      queryClient.setQueryData(queryKeys.library, (current: MediaAsset[] | undefined) =>
        (current || []).map((asset) => (asset.id === assetId ? markPending(asset)! : asset))
      );
      queryClient.setQueryData(queryKeys.transcript(assetId), (current: MediaAsset | null | undefined) =>
        markPending(current)
      );
    },
    onSuccess: (_job, { assetId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(assetId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.library });
    },
    onError: (_error, { assetId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(assetId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.library });
    },
  });
}

export function useUpdateTranscriptWordTimingMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateTranscriptWordTiming,
    onSuccess: (asset, { assetId }) => {
      queryClient.setQueryData(queryKeys.transcript(assetId), asset);
      void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(assetId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.library });
    },
  });
}
