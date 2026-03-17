import { NextResponse } from "next/server";
import { generateStyleSuggestion, generateTextImage, generateTextVideo, generateVibeTransition } from "@/lib/ai-media";

export const maxDuration = 300; // 5 minutes max since video polling takes time

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action } = body;

    if (!action) {
      return NextResponse.json({ error: "No action provided" }, { status: 400 });
    }

    if (action === "style") {
      const { text, referenceImage } = body;
      console.log(`[VibeText] Starting style generation for: "${text}"`);
      if (!text) {
        console.error("[VibeText] Missing text parameter for style action");
        return NextResponse.json({ error: "Missing text parameter" }, { status: 400 });
      }
      const suggestions = await generateStyleSuggestion(text, referenceImage);
      console.log(`[VibeText] Style generation complete. Found ${suggestions.length} suggestions.`);
      return NextResponse.json({ suggestions });
    }

    if (action === "image") {
      const { text, style, typographyPrompt, referenceImage } = body;
      console.log(`[VibeText] Starting image generation. Text: "${text}", Style: "${style}"`);
      if (!text || !style) {
        console.error("[VibeText] Missing required parameters for image action");
        return NextResponse.json({ error: "Missing text or style parameters" }, { status: 400 });
      }
      const result = await generateTextImage({ text, style, typographyPrompt, referenceImage });
      console.log("[VibeText] Image generation completed.");
      return NextResponse.json(result);
    }

    if (action === "video") {
      const { text, imageBase64, imageMimeType, style } = body;
      console.log(`[VibeText] Received video generation request for text: "${text}"`);
      if (!text || !imageBase64 || !imageMimeType || !style) {
         console.error("[VibeText] Missing required video parameters:", { text: !!text, image: !!imageBase64, mime: !!imageMimeType, style: !!style });
         return NextResponse.json({ error: "Missing required video parameters" }, { status: 400 });
      }
      const videoUri = await generateTextVideo(text, imageBase64, imageMimeType, style);
      console.log("[VibeText] Video generation successful. Returning URI.");
      return NextResponse.json({ videoUri });
    }

    if (action === "transition") {
      const { lastFrameBase64, imageMimeType, nextClipDescription, startFrameBBase64 } = body;
      console.log(`[VibeText] Starting AI transition generation. Mode: ${startFrameBBase64 ? "Automatic (Two Frames)" : "Manual (Description)"}`);
      if (!lastFrameBase64 || (!nextClipDescription && !startFrameBBase64)) {
        return NextResponse.json({ error: "Missing required transition parameters. Provide either a description or a second frame." }, { status: 400 });
      }
      const videoUri = await generateVibeTransition(
        lastFrameBase64, 
        imageMimeType || "image/png", 
        nextClipDescription,
        startFrameBBase64
      );
      console.log("[VibeText] AI transition generation complete.");
      return NextResponse.json({ videoUri });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (error) {
    console.error("VibeText API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error occurred" },
      { status: 500 }
    );
  }
}
