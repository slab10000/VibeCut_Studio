import { useMutation, useQueryClient } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import type { JobRecord, SequenceItem } from "@/shared/contracts";
import { desktopInvoke, isTauriRuntime } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return save({
    defaultPath: defaultName,
    filters: [{ name: "Video", extensions: ["mp4"] }],
  });
}

export async function enqueueExport(clips: SequenceItem[], outputPath: string): Promise<JobRecord> {
  return desktopInvoke<JobRecord>("export_enqueue", { clips, outputPath });
}

export function useEnqueueExportMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ clips, outputPath }: { clips: SequenceItem[]; outputPath: string }) =>
      enqueueExport(clips, outputPath),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}
