import { createStagehand } from "./browser";

// Smoke test: prove we can open a real Browserbase page, read it, and screenshot it.
// No LLM involved — this isolates the browser connection.
// Run:  bun run src/agent/browser-test.ts  [optional-url]
const url = process.argv[2] ?? "https://example.com";

const stagehand = createStagehand();
console.log("[browser] connecting to Browserbase…");
await stagehand.init();

try {
  const page = await stagehand.context.newPage();
  console.log(`[browser] navigating to ${url}`);
  await page.goto(url);

  console.log(`[browser] title : ${await page.title()}`);
  console.log(`[browser] url   : ${page.url()}`);

  await page.screenshot({ path: "smoke.png" });
  console.log("[browser] screenshot saved -> smoke.png ✅");
} finally {
  await stagehand.close();
  console.log("[browser] session closed");
}
