import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobRecord, MediaAsset, SearchHit } from "@/shared/contracts";
import { desktopInvoke, isTauriRuntime } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";
import { createPreviewUrl } from "@/features/library/api";

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

export async function enqueueTranscript(assetId: string): Promise<JobRecord> {
  return desktopInvoke<JobRecord>("transcript_enqueue", { assetId });
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
    onSuccess: (_job, assetId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(assetId) });
    },
  });
}
