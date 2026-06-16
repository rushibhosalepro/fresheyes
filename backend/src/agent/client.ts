import OpenAI from "openai";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("Missing OPENROUTER_API_KEY — set it in backend/.env");
}

export const MODEL =
  process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";

// Cheaper/faster model for the browser "hands" (Stagehand observe/act). Those are
// frequent, mechanical "which element matches this instruction" calls that don't
// need the strong brain model — route them to a cheap/free model to save cost.
// The brain (MODEL above) is still used for reasoning, findings, and the summary.
export const STAGEHAND_MODEL =
  process.env.STAGEHAND_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";

console.log(MODEL);
export const llm = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    // "HTTP-Referer": "https://fresheyes.app",
    // "X-Title": "FreshEyes",
  },
});
