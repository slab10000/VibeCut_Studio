import { NextResponse } from "next/server";
import { getGeminiClient, MODELS } from "@/lib/gemini";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { prompt } = await req.json();

    if (!prompt) {
      return NextResponse.json({ error: "No prompt provided" }, { status: 400 });
    }

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: MODELS.VIDEO_GEN,
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      config: {
        // We only expect video (and perhaps text notes) back
      },
    });

    // Extract video from response parts
    const parts = response.candidates?.[0]?.content?.parts || [];
    let videoBase64 = "";
    let videoMimeType = "video/mp4";

    for (const part of parts) {
      // The GenAI SDK usually returns generated rich media in inlineData
      if (part.inlineData && part.inlineData.mimeType?.startsWith("video/")) {
        videoBase64 = part.inlineData.data || "";
        videoMimeType = part.inlineData.mimeType;
        break;
      }
    }

    if (!videoBase64) {
      return NextResponse.json({ error: "No video generated" }, { status: 500 });
    }

    return NextResponse.json({ videoBase64, mimeType: videoMimeType });
  } catch (error) {
    console.error("Video generation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Video generation failed" },
      { status: 500 }
    );
  }
}
