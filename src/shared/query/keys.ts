export const queryKeys = {
  project: ["project"] as const,
  library: ["library"] as const,
  timeline: ["timeline"] as const,
  jobs: ["jobs"] as const,
  capabilities: ["capabilities"] as const,
  transcript: (assetId: string | null | undefined) => ["transcript", assetId ?? "none"] as const,
};
