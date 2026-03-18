import { useQuery } from "@tanstack/react-query";
import type { JobRecord } from "@/shared/contracts";
import { desktopInvoke, isTauriRuntime } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";

export async function listJobs(): Promise<JobRecord[]> {
  if (!isTauriRuntime()) return [];
  return desktopInvoke<JobRecord[]>("jobs_list");
}

export function useJobsQuery() {
  return useQuery({
    queryKey: queryKeys.jobs,
    queryFn: listJobs,
  });
}
