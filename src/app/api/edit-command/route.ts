import { NextResponse } from "next/server";
import { getGeminiClient, MODELS } from "@/lib/gemini";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { command, transcript, timeline } = await req.json();

    if (!command) {
      return NextResponse.json({ error: "No command provided" }, { status: 400 });
    }

    const ai = getGeminiClient();

    const systemPrompt = `You are a video editing AI assistant. Interpret the user's natural language request and convert it into structured sequence operations.

The sequence can contain multiple source clips. Every transcript segment includes a sourceClipId. Every timeline clip includes its sequence index and the source clip/time window it uses.

Available operation types:
- "remove_time_range": remove spoken content inside a specific source clip. Must include sourceClipId, startTime, endTime.
- "keep_only_ranges": rebuild the sequence using only specific source ranges. Must include a ranges array of {sourceClipId, startTime, endTime}.
- "insert_image": generate a still image and insert it after a sequence time. Must include prompt, afterTime, duration.
- "reorder": move an existing sequence item by index. Must include fromIndex and toIndex.

Return ONLY valid JSON with this shape:
{
  "operations": [
    {"type": "remove_time_range", "sourceClipId": "string", "startTime": number, "endTime": number, "reason": "string"},
    {"type": "keep_only_ranges", "ranges": [{"sourceClipId": "string", "startTime": number, "endTime": number}], "reason": "string"},
    {"type": "insert_image", "afterTime": number, "prompt": "string", "duration": number, "reason": "string"},
    {"type": "reorder", "fromIndex": number, "toIndex": number, "reason": "string"}
  ],
  "explanation": "brief description of what will be done"
}

Rules:
- Be conservative and preserve meaning unless the user explicitly asks for aggressive edits.
- Prefer the smallest set of operations that satisfies the request.
- Use reorder only when the user clearly wants sequence order changed.
- When referencing transcript content, always ground the operation in sourceClipId + timestamps.
- Do not return markdown fences or any extra prose.`;

    const response = await ai.models.generateContent({
      model: MODELS.REASONING,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${systemPrompt}

Current transcript segments:
${JSON.stringify(transcript, null, 2)}

Current timeline clips:
${JSON.stringify(timeline, null, 2)}

User command: "${command}"`,
            },
          ],
        },
      ],
    });

    const text = response.text?.trim() || "{}";
    const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned);

    return NextResponse.json(parsed);
  } catch (error) {
    console.error("Edit command error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Edit command failed" },
      { status: 500 }
    );
  }
}
