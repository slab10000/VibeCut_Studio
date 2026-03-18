import { invoke } from "@tauri-apps/api/core";
import type { EntityChangeEvent, JobRecord } from "@/shared/contracts";

const JOBS_UPDATED_EVENT = "jobs-updated";
const ENTITIES_CHANGED_EVENT = "entities-changed";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime() {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function desktopInvoke<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, payload);
}

export async function listenToJobUpdates(onEvent: (job: JobRecord) => void) {
  if (!isTauriRuntime()) return () => undefined;

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<JobRecord>(JOBS_UPDATED_EVENT, (event) => onEvent(event.payload));

  return () => {
    void unlisten();
  };
}

export async function listenToEntityChanges(onEvent: (event: EntityChangeEvent) => void) {
  if (!isTauriRuntime()) return () => undefined;

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<EntityChangeEvent>(ENTITIES_CHANGED_EVENT, (event) => onEvent(event.payload));

  return () => {
    void unlisten();
  };
}
