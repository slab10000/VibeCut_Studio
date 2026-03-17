import { NextResponse } from "next/server";
import { getGeminiClient, MODELS } from "@/lib/gemini";

export async function POST(req: Request) {
  try {
    const { query } = await req.json();

    if (!query) {
      return NextResponse.json({ error: "No query provided" }, { status: 400 });
    }

    const ai = getGeminiClient();
    const result = await ai.models.embedContent({
      model: MODELS.EMBEDDING,
      contents: query,
      config: {
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 256,
      },
    });

    const embedding = result.embeddings?.[0]?.values || [];

    return NextResponse.json({ embedding });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 }
    );
  }
}
