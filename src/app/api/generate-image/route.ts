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
      model: MODELS.IMAGE_GEN,
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      config: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    });

    // Extract image from response parts
    const parts = response.candidates?.[0]?.content?.parts || [];
    let imageBase64 = "";
    let imageMimeType = "image/png";

    for (const part of parts) {
      if (part.inlineData) {
        imageBase64 = part.inlineData.data || "";
        imageMimeType = part.inlineData.mimeType || "image/png";
        break;
      }
    }

    if (!imageBase64) {
      return NextResponse.json({ error: "No image generated" }, { status: 500 });
    }

    return NextResponse.json({ imageBase64, mimeType: imageMimeType });
  } catch (error) {
    console.error("Image generation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Image generation failed" },
      { status: 500 }
    );
  }
}
