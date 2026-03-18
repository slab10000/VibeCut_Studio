import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listenToEntityChanges, listenToJobUpdates } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";

export function useDesktopEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    void listenToJobUpdates((job) => {
      queryClient.setQueryData(queryKeys.jobs, (current: unknown) => {
        const jobs = Array.isArray(current) ? current : [];
        const next = jobs.filter((item) => (item as { id?: string }).id !== job.id);
        return [...next, job].sort(
          (left, right) =>
            ((right as { updatedAt?: number }).updatedAt ?? 0) - ((left as { updatedAt?: number }).updatedAt ?? 0)
        );
      });
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => cleanup?.();
  }, [queryClient]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    void listenToEntityChanges((event) => {
      switch (event.entityType) {
        case "project":
          void queryClient.invalidateQueries({ queryKey: queryKeys.project });
          break;
        case "library":
          void queryClient.invalidateQueries({ queryKey: queryKeys.library });
          if (event.entityId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(event.entityId) });
          }
          break;
        case "timeline":
          void queryClient.invalidateQueries({ queryKey: queryKeys.timeline });
          break;
        case "transcript":
          if (event.entityId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.transcript(event.entityId) });
          }
          void queryClient.invalidateQueries({ queryKey: queryKeys.library });
          break;
        case "job":
          void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
          break;
        case "capabilities":
          void queryClient.invalidateQueries({ queryKey: queryKeys.capabilities });
          break;
        default:
          break;
      }
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => cleanup?.();
  }, [queryClient]);
}
