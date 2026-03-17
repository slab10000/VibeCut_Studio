import { GoogleGenAI } from "@google/genai";

let client: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not set");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export const MODELS = {
  REASONING: "gemini-3.1-pro-preview",
  EMBEDDING: "gemini-embedding-2-preview",
  IMAGE_GEN: "gemini-3.1-flash-image-preview",
  VIDEO_GEN: "veo-3.1-fast-generate-preview",
} as const;
