import { useQuery } from "@tanstack/react-query";
import type { AppCapabilities, ProjectSummary } from "@/shared/contracts";
import { desktopInvoke, isTauriRuntime } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";

export async function getProject(): Promise<ProjectSummary> {
  if (!isTauriRuntime()) {
    return {
      projectId: "browser-preview",
      name: "Browser Preview",
    };
  }

  return desktopInvoke<ProjectSummary>("project_get");
}

export async function getCapabilities(): Promise<AppCapabilities | null> {
  if (!isTauriRuntime()) return null;
  return desktopInvoke<AppCapabilities>("capabilities_get");
}

export function useProjectQuery() {
  return useQuery({
    queryKey: queryKeys.project,
    queryFn: getProject,
  });
}

export function useCapabilitiesQuery() {
  return useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: getCapabilities,
  });
}
