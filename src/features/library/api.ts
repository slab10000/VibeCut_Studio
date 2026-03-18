import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { MediaAsset } from "@/shared/contracts";
import { desktopInvoke, isTauriRuntime } from "@/shared/desktop/transport";
import { queryKeys } from "@/shared/query/keys";

export function createPreviewUrl(path?: string | null) {
  if (!path) return null;
  return isTauriRuntime() ? convertFileSrc(path) : path;
}

function hydrateAsset(asset: MediaAsset): MediaAsset {
  return {
    ...asset,
    previewUrl: createPreviewUrl(asset.proxyPath || asset.previewPath || asset.sourcePath),
  };
}

export async function pickVideoPaths() {
  if (!isTauriRuntime()) return [] as string[];

  const result = await open({
    multiple: true,
    filters: [
      {
        name: "Video",
        extensions: ["mp4", "mov", "m4v", "webm", "avi", "mkv"],
      },
    ],
  });

  if (!result) return [] as string[];
  return Array.isArray(result) ? result : [result];
}

export async function listLibrary(): Promise<MediaAsset[]> {
  if (!isTauriRuntime()) return [];
  const assets = await desktopInvoke<MediaAsset[]>("library_list");
  return assets.map(hydrateAsset);
}

export async function importMedia(paths: string[]) {
  if (!isTauriRuntime()) return [] as MediaAsset[];
  const assets = await desktopInvoke<MediaAsset[]>("library_import_paths", { paths });
  return assets.map(hydrateAsset);
}

export async function listenForFileDrop(onPaths: (paths: string[]) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      const paths = (event.payload.paths || []).filter((path: string) => /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(path));
      if (paths.length > 0) onPaths(paths);
    }
  });
  return unlisten;
}

export function useLibraryQuery() {
  return useQuery({
    queryKey: queryKeys.library,
    queryFn: listLibrary,
  });
}

export function useImportMediaMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: importMedia,
    onSuccess: (assets) => {
      queryClient.setQueryData(queryKeys.library, (current: MediaAsset[] | undefined) => [
        ...(current || []),
        ...assets,
      ]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.library });
    },
  });
}
