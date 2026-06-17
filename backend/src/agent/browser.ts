import { Stagehand, CustomOpenAIClient } from "@browserbasehq/stagehand";
import { llm, STAGEHAND_MODEL } from "./client";

/**
 * Creates a Stagehand (v3) instance wired to Browserbase for the browser,
 * and to OpenRouter for its act/observe/extract reasoning (same free model
 * as the brain, via CustomOpenAIClient wrapping our OpenAI-compatible client).
 *
 * Call `await stagehand.init()` before use and `await stagehand.close()` after.
 *   - navigation/screenshots:  stagehand.context.newPage() -> page.goto / page.screenshot
 *   - high-level actions:      stagehand.act / .observe / .extract
 */
export function createStagehand() {
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    throw new Error(
      "Missing BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID — set them in backend/.env",
    );
  }

  return new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    llmClient: new CustomOpenAIClient({ modelName: STAGEHAND_MODEL, client: llm }),
    verbose: 1,
    // Pages that constantly mutate the DOM (e.g. a streaming AI chat like
    // Finbuddy) never "settle", so Stagehand waits the full default (~30s) on
    // EVERY observe/act before proceeding — that's the hang/"stuck". Bound the
    // settle wait and the per-action time so the agent keeps moving.
    domSettleTimeout: 5000,
    actTimeoutMs: 30000,
    // Give the session the full free-tier window (15 min / 900s) instead of the
    // lower project default. When the session does time out, the agent builds
    // the final report from whatever it gathered so far (see runAgent's
    // session-closed handling) rather than failing.
    browserbaseSessionCreateParams: {
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      timeout: 900,
    },
  });
}
