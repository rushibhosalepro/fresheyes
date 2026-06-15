import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { llm, MODEL } from "./client";
import { createStagehand } from "./browser";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolSchema = OpenAI.Chat.Completions.ChatCompletionTool;

const MAX_STEPS = 14; // hard cap on agent turns (each turn may also trigger Stagehand LLM calls)

// When true, screenshots are fed to the model so it can actually SEE the page
// (judge visual design, imagery, color, layout). Requires a vision-capable
// OPENROUTER_MODEL. Off by default so text-only models (e.g. Nemotron) keep working.
const VISION = process.env.OPENROUTER_VISION === "true";

export type Severity = "high" | "medium" | "low";

export type Category =
  | "clarity"
  | "cta"
  | "visual-design"
  | "imagery"
  | "copy"
  | "navigation"
  | "trust"
  | "forms"
  | "accessibility"
  | "performance"
  | "errors"
  | "other";

export interface Finding {
  severity: Severity;
  category: Category | string;
  title: string;
  description: string;
  fix: string;
  url?: string; // page URL where it was found
  screenshot?: string; // id of the captured screenshot, if any
}

export interface AuditResult {
  url: string;
  status: "done" | "blocked" | "max_steps" | "cancelled";
  steps: number;
  findings: Finding[];
  summary: string;
  screenshots: { id: string; base64: string }[];
}

/** Streamed as the agent works, so the server can forward them over SSE. */
export type AgentEvent =
  | { type: "session"; liveViewUrl?: string; sessionUrl?: string }
  | { type: "start"; url: string; goal: string; title: string }
  | { type: "thinking"; text: string }
  | { type: "step"; index: number; tool: string; args: any; result: any }
  | { type: "screenshot"; id: string; base64: string }
  | { type: "finding"; finding: Finding }
  | { type: "done"; result: AuditResult }
  | { type: "error"; message: string };

export interface RunOptions {
  goal?: string;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

// Load the audit rubric so the agent evaluates the whole first impression,
// not just the CTA. Kept in skill.md so it's easy to tune without touching code.
const AUDIT_GUIDE = (() => {
  try {
    return readFileSync(new URL("./skill.md", import.meta.url), "utf8");
  } catch {
    return "";
  }
})();

const SYSTEM_PROMPT = `You are FreshEyes — an agent that experiences a website exactly as a brand-new, first-time visitor and reports what genuinely helps or hurts that first impression across clarity, CTA, visual design, imagery, copy, navigation, trust, forms, accessibility, performance, and errors.

Work one tool call at a time: observe() to see the page, act("...") to click / scroll / type, screenshot() at meaningful moments, record_finding(...) for each REAL issue (with its category), and finish(...) when done or blocked.

Be proportionate. FIRST judge what kind of page this is and how finished it's meant to be, then match the depth of your audit to that. A deliberately minimal placeholder (like example.com) deserves only 1-2 low-severity notes plus a clear statement that it's a placeholder — never pad the report or invent problems to hit a number. Every fix must be concrete and specific: suggest actual colors / hex, button styles, type sizes, spacing, layout, or exact copy — never vague advice like "improve the design". Calibrate severity to real impact on this page's goal, and mention genuine strengths in your summary.

Follow this audit guide:

${AUDIT_GUIDE}`;

const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "observe",
      description:
        "Look at the current page and list the interactive elements a first-time visitor could use.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description:
              "What to look for, e.g. 'the primary call-to-action' or 'navigation links'.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "act",
      description:
        "Perform one action on the page, described in plain language (e.g. 'click the Sign up button').",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "The single action to perform.",
          },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Capture the current view as evidence for the report.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "Optional short label for what this shows.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_finding",
      description:
        "Record one issue a first-time visitor would hit — across clarity, CTA, visual design, imagery, copy, navigation, trust, forms, accessibility, performance, or errors.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "clarity",
              "cta",
              "visual-design",
              "imagery",
              "copy",
              "navigation",
              "trust",
              "forms",
              "accessibility",
              "performance",
              "errors",
            ],
            description:
              "Which aspect of the first-time experience this concerns.",
          },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: {
            type: "string",
            description: "Short, specific headline for the issue.",
          },
          description: {
            type: "string",
            description:
              "What a first-time visitor experiences and why it hurts them (their point of view).",
          },
          fix: { type: "string", description: "One concrete suggested fix." },
        },
        required: ["category", "severity", "title", "description", "fix"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the audit when the goal is reached or you are blocked.",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["done", "blocked"] },
          reason: { type: "string", description: "Brief reason for ending." },
        },
        required: ["outcome"],
      },
    },
  },
];

/**
 * runAgent — the brain + hands fused. Opens a Browserbase page, then runs a
 * bounded tool-calling loop where the model drives the browser as a first-time
 * visitor and records friction. Returns a structured audit.
 */
export async function runAgent(
  url: string,
  opts: RunOptions = {},
): Promise<AuditResult> {
  const { goal, onEvent = () => {}, signal } = opts;

  const stagehand = createStagehand();
  await stagehand.init();

  const findings: Finding[] = [];
  const screenshots: { id: string; base64: string }[] = [];
  const pendingImages: string[] = []; // screenshots captured this turn, fed to a vision model
  let finished: { outcome: "done" | "blocked"; reason: string } | null = null;

  try {
    // Use the session's existing page (single target) so the live view shows
    // exactly what the agent drives. Opening a new tab makes Browserbase's live
    // view display a different, blank target — which looks like an empty browser.
    const page =
      stagehand.context.activePage() ?? (await stagehand.context.newPage());

    // Surface the live view as soon as we have the page so the user can watch.
    const sessionId = stagehand.browserbaseSessionID;
    if (sessionId) {
      onEvent({
        type: "session",
        liveViewUrl: await getLiveViewUrl(sessionId),
        sessionUrl: stagehand.browserbaseSessionURL,
      });
    }

    await page.goto(url);
    const startTitle = await page.title();
    onEvent({
      type: "start",
      url,
      goal: goal ?? "reach the primary call to action",
      title: startTitle,
    });

    // Tool implementations, closing over this run's browser + collectors.
    const impls: Record<string, (args: any) => Promise<unknown>> = {
      observe: async ({ instruction }) => {
        const actions = await stagehand.observe(
          instruction ??
            "the main interactive elements a first-time visitor would use",
        );
        return {
          url: page.url(),
          elements: (actions as any[]).slice(0, 15).map((a) => ({
            description: a.description ?? a.selector ?? "element",
          })),
        };
      },
      act: async ({ instruction }) => {
        const res: any = await stagehand.act(instruction);
        return {
          success: res?.success ?? true,
          message: res?.message ?? res?.action ?? null,
          url: page.url(),
          title: await page.title(),
        };
      },
      screenshot: async ({ note }) => {
        const buffer = await page.screenshot({});
        const id = `step-${screenshots.length + 1}`;
        const base64 = buffer.toString("base64");
        screenshots.push({ id, base64 });
        if (VISION) pendingImages.push(base64); // hand it to the model after this turn
        onEvent({ type: "screenshot", id, base64 });
        return { ok: true, id, note: note ?? null };
      },
      record_finding: async (args) => {
        const finding: Finding = {
          severity: (["high", "medium", "low"].includes(args?.severity)
            ? args.severity
            : "medium") as Severity,
          category: String(args?.category ?? "other"),
          title: String(args?.title ?? "Untitled finding"),
          description: String(args?.description ?? ""),
          fix: String(args?.fix ?? ""),
          url: page.url(),
          screenshot: screenshots.at(-1)?.id,
        };
        findings.push(finding);
        onEvent({ type: "finding", finding });
        return { ok: true, totalFindings: findings.length };
      },
      finish: async ({ outcome, reason }) => {
        finished = {
          outcome: outcome === "blocked" ? "blocked" : "done",
          reason: String(reason ?? ""),
        };
        return { ok: true };
      },
    };

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Audit this site as a brand-new first-time visitor.\n` +
          `URL: ${url}\n` +
          `Page title: ${startTitle}\n` +
          `Goal: judge the whole first impression and try the primary action (${goal ?? "sign up / get started / buy"}).\n\n` +
          `First judge what kind of page this is and how finished it's meant to be, then audit proportionately. Observe the page, scroll through the key sections, and try the primary action if there is one. Screenshot meaningful moments. Record only findings that genuinely matter for this page — across whichever categories apply — with specific, concrete fixes (actual colors, button styles, type, spacing, copy). Don't pad. Finish when done or blocked.`,
      },
    ];

    let step = 0;
    let nudges = 0; // times we've nudged a narrating model to actually call a tool
    while (step < MAX_STEPS && !finished && !signal?.aborted) {
      step++;
      let res;

      try {
        res = await llm.chat.completions.create({
          model: MODEL,
          messages,
          tools: TOOL_SCHEMAS,
          // tool_choice: "auto",
        });
      } catch (error) {
        console.log(error);
        throw error;
      }
      const msg = res.choices[0]?.message;
      if (!msg) break;
      messages.push(msg as ChatMessage);

      // Surface the model's reasoning so the UI can show what it's thinking.
      // Reasoning models (via OpenRouter) put their chain-of-thought on
      // msg.reasoning, separate from msg.content — prefer it, fall back to content.
      const reasoning =
        typeof (msg as any).reasoning === "string"
          ? (msg as any).reasoning.trim()
          : "";
      const content = typeof msg.content === "string" ? msg.content.trim() : "";
      const thought = reasoning || content;
      if (thought) onEvent({ type: "thinking", text: thought });

      // No tool call this turn. Weaker models sometimes *describe* an action
      // ("To resolve this, I'll record a finding.") instead of *calling* the tool.
      // Don't end the run on that — nudge the model to actually act, a few times,
      // before giving up. Ending here is what caused bogus "0 findings / max_steps".
      if (!msg.tool_calls?.length) {
        if (nudges < 3) {
          nudges++;
          messages.push({
            role: "user",
            content:
              "Don't just describe what you'll do — actually call a tool now. " +
              "Use observe / act / screenshot / record_finding to continue, or call finish when you are truly done. " +
              "If you noticed an issue, call record_finding for it before finishing.",
          });
          continue;
        }
        break;
      }

      for (const call of msg.tool_calls) {
        const fn = (call as any).function;
        const result = await runTool(impls, fn?.name, fn?.arguments);
        console.log(
          `[step ${step}] ${fn?.name}(${truncate(fn?.arguments)}) -> ${truncate(JSON.stringify(result))}`,
        );
        onEvent({
          type: "step",
          index: step,
          tool: fn?.name,
          args: safeForEvent(fn?.arguments),
          result,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }

      // If vision is on, show the model the screenshot(s) it just captured so it
      // can judge visual design, imagery, layout, and color from real pixels.
      // (Added after the tool results to keep the message order valid.)
      if (VISION && pendingImages.length) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "Screenshot of the current page:" },
            ...pendingImages.map((b64) => ({
              type: "image_url" as const,
              image_url: { url: `data:image/png;base64,${b64}` },
            })),
          ],
        });
        pendingImages.length = 0;
      }
    }

    const aborted = signal?.aborted ?? false;
    const summary = aborted
      ? "Audit cancelled."
      : await synthesize(messages, findings);
    const status: AuditResult["status"] = aborted
      ? "cancelled"
      : finished
        ? (finished as { outcome: "done" | "blocked" }).outcome
        : "max_steps";

    const result: AuditResult = {
      url,
      status,
      steps: step,
      findings,
      summary,
      screenshots,
    };
    onEvent({ type: "done", result });
    return result;
  } catch (err) {
    onEvent({ type: "error", message: (err as Error).message });
    throw err;
  } finally {
    await stagehand.close();
  }
}

/** One last model call to summarize the first-time-visitor experience. */
async function synthesize(
  messages: ChatMessage[],
  findings: Finding[],
): Promise<string> {
  const res = await llm.chat.completions.create({
    model: MODEL,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          `Write a 3-4 sentence executive summary of the first-time-visitor experience for a busy founder. ` +
          `Lead with the overall impression, then the most important things to fix, and mention any genuine strengths. ` +
          `Be specific and reference what you actually saw. Findings: ${JSON.stringify(findings)}`,
      },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
}

/**
 * Runs one tool call. Always resolves to a JSON-able result — never throws —
 * so a bad arg or a failing tool becomes an error the model can read and
 * self-correct on its next turn.
 */
async function runTool(
  impls: Record<string, (args: any) => Promise<unknown>>,
  name: string,
  rawArgs: unknown,
): Promise<unknown> {
  const parsed = parseArgs(rawArgs);
  if (!parsed.ok) {
    return {
      error: parsed.error,
      hint: "Re-call this tool with valid JSON arguments.",
    };
  }

  const impl = impls[name];
  if (!impl) return { error: `unknown tool: ${name}` };

  try {
    return await impl(parsed.value);
  } catch (e) {
    return {
      error: `tool "${name}" threw: ${(e as Error).message}`,
      hint: "Try a different action, observe again, or finish as blocked if you cannot proceed.",
    };
  }
}

function parseArgs(
  raw: unknown,
): { ok: true; value: any } | { ok: false; error: string } {
  if (typeof raw !== "string")
    return { ok: false, error: "arguments missing or not a JSON string" };
  try {
    return { ok: true, value: JSON.parse(raw || "{}") };
  } catch (e) {
    return {
      ok: false,
      error: `invalid JSON arguments: ${(e as Error).message}`,
    };
  }
}

function truncate(s: unknown, n = 140): string {
  const str = typeof s === "string" ? s : String(s);
  return str.length > n ? str.slice(0, n) + "…" : str;
}

// Fetch Browserbase's embeddable live-view URL for a session (never throws).
async function getLiveViewUrl(sessionId: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://api.browserbase.com/v1/sessions/${sessionId}/debug`,
      {
        headers: { "X-BB-API-Key": process.env.BROWSERBASE_API_KEY ?? "" },
      },
    );
    if (!res.ok) return undefined;
    const data: any = await res.json();
    return (
      data?.debuggerFullscreenUrl ?? data?.pages?.[0]?.debuggerFullscreenUrl
    );
  } catch {
    return undefined;
  }
}

// Best-effort parse of tool args for event payloads (never throws).
function safeForEvent(raw: unknown): any {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { _raw: raw };
  }
}

// Direct run:  bun run src/agent/runAgent.ts  [url]
// if (import.meta.main) {
//   const url = process.argv[2] ?? "https://example.com";
//   const result = await runAgent(url);
//   console.log("\n=== AUDIT RESULT ===");
//   console.log(`status: ${result.status}  steps: ${result.steps}  findings: ${result.findings.length}  screenshots: ${result.screenshots.length}`);
//   console.log(`summary: ${result.summary}`);
//   for (const f of result.findings) console.log(` - [${f.severity}] ${f.title} — ${f.fix}`);
// }
