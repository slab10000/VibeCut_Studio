import { NextResponse } from "next/server";
import { getGeminiClient, MODELS } from "@/lib/gemini";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { imageBase64 } = await req.json();
    console.log("[GenerateFont] Received request. Image included:", !!imageBase64);

    if (!imageBase64) {
      console.error("[GenerateFont] No image provided");
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    const ai = getGeminiClient();
    console.log("[GenerateFont] Requesting font analysis from Gemini...");
    
    const prompt = `
Analyze this video frame and generate a highly thematic typography style perfectly suited to its visual vibe, aesthetic, texture, and content.
For example, if the video is of water/river, the font should be dripping and flowing (e.g., "Nosifer", "Creepster", or "Water Brush"). If the frame shows fire, use a burning font (e.g., "Rubik Burned", "Eater").
You MUST select a valid Google Font name that strongly matches the physical feeling of the content.
Return a suggested Google Font name, a complementary text color (hex code), a CSS text-shadow value, and an advanced CSS cssFilter to complete the effect (e.g., dropshadow, blur, contrast).
Provide the response strictly as a JSON object with the following keys:
- "fontFamily": The exact name of a thematic Google Font.
- "color": A hex color code (e.g., "#FFFFFF", "#FF3366").
- "textShadow": A valid CSS text-shadow string (e.g., "2px 2px 4px rgba(0,0,0,0.8)").
- "cssFilter": A valid CSS filter string (e.g., "drop-shadow(0px 0px 8px rgba(0,255,0,0.8)) blur(0.5px)", or "none").
    `;

    const response = await ai.models.generateContent({
      model: MODELS.REASONING,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: imageBase64.split(",")[1] || imageBase64,
                mimeType: "image/jpeg",
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
      },
    });

    const text = response.text || "{}";
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        // Fallback or regex extraction if hallucinated markdown is present
        const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
        data = jsonMatch ? JSON.parse(jsonMatch[1]) : {};
    }

    const fontFamily = data.fontFamily || "Inter";
    const color = data.color || "#FFFFFF";
    const textShadow = data.textShadow || "0px 0px 8px rgba(0,0,0,0.8)";
    const cssFilter = data.cssFilter || "none";

    console.log("[GenerateFont] Font generation successful:", { fontFamily, color });
    return NextResponse.json({ fontFamily, color, textShadow, cssFilter });
  } catch (error) {
    console.error("Font generation error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Font generation failed" },
      { status: 500 }
    );
  }
}
