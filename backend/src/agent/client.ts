import OpenAI from "openai";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("Missing OPENROUTER_API_KEY — set it in backend/.env");
}

export const MODEL =
  process.env.OPENROUTER_MODEL ?? "google/gemini-2.0-flash-exp:free";

export const llm = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    // "HTTP-Referer": "https://fresheyes.app",
    // "X-Title": "FreshEyes",
  },
});
