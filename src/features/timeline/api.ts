import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SequenceItem, TimelinePatch } from "@/shared/contracts";
import { desktopInvoke, isTauriRuntime } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";

export async function getTimeline(): Promise<SequenceItem[]> {
  if (!isTauriRuntime()) return [];
  return desktopInvoke<SequenceItem[]>("timeline_get");
}

export async function applyTimelinePatch(patch: TimelinePatch): Promise<SequenceItem[]> {
  if (!isTauriRuntime()) return patch.clips;
  return desktopInvoke<SequenceItem[]>("timeline_apply_patch", { patch });
}

export function useTimelineQuery() {
  return useQuery({
    queryKey: queryKeys.timeline,
    queryFn: getTimeline,
  });
}

export function useApplyTimelinePatchMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: applyTimelinePatch,
    onSuccess: (clips) => {
      queryClient.setQueryData(queryKeys.timeline, clips);
    },
  });
}
