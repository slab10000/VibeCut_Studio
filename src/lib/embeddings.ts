export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rankByRelevance(
  queryEmbedding: number[],
  segments: { id: string; embedding: number[] }[]
): { id: string; score: number }[] {
  return segments
    .map((seg) => ({
      id: seg.id,
      score: cosineSimilarity(queryEmbedding, seg.embedding),
    }))
    .sort((a, b) => b.score - a.score);
}
