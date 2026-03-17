import { NextResponse } from "next/server";
import { getGeminiClient, MODELS } from "@/lib/gemini";

export async function POST(req: Request) {
  try {
    const { texts } = await req.json();

    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      return NextResponse.json({ error: "No texts provided" }, { status: 400 });
    }

    const ai = getGeminiClient();

    const embeddings: number[][] = [];
    // Batch in groups of 10 to avoid rate limits
    for (let i = 0; i < texts.length; i += 10) {
      const batch = texts.slice(i, i + 10);
      const results = await Promise.all(
        batch.map((text: string) =>
          ai.models.embedContent({
            model: MODELS.EMBEDDING,
            contents: text,
            config: {
              taskType: "RETRIEVAL_DOCUMENT",
              outputDimensionality: 256,
            },
          })
        )
      );
      for (const result of results) {
        embeddings.push(result.embeddings?.[0]?.values || []);
      }
    }

    return NextResponse.json({ embeddings });
  } catch (error) {
    console.error("Embeddings error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Embedding failed" },
      { status: 500 }
    );
  }
}
