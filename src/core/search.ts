import { SearchHit, TranscriptSegment } from "@/types";

export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index++) {
    dotProduct += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rankLexicalSearch(query: string, segments: TranscriptSegment[]): SearchHit[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) return [];

  return segments
    .map((segment) => {
      const normalized = segment.text.toLowerCase();
      const score = tokens.reduce((value, token) => value + (normalized.includes(token) ? 1 : 0), 0) / tokens.length;
      return {
        id: segment.id,
        sourceClipId: segment.sourceClipId,
        score,
      };
    })
    .filter((segment) => segment.score > 0)
    .sort((left, right) => right.score - left.score);
}
