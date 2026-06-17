import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { llm, MODEL } from "./client";
import { createStagehand } from "./browser";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolSchema = OpenAI.Chat.Completions.ChatCompletionTool;

// Safety cap on agent turns. Raise it for thorough audits with strong models via
// the MAX_STEPS env var. A hard bound stays on purpose: if a model never calls
// finish (it happens), an unbounded loop would run forever and burn tokens/minutes.
const MAX_STEPS = Number(process.env.MAX_STEPS) || 30;

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

Every tool call MUST include a "thought": one short, plain, first-person sentence narrating what you're doing and why — as if you're talking out loud to the person watching you browse (e.g. "The hero is vague, so let me scroll to find what this product actually does."). This narration is shown live to the user, so make it natural and specific, never robotic.

You can only audit THIS site. External / off-site links will not open — acting on one just returns you to the page. So don't try to follow links to other domains, and do NOT record a finding whose only issue is an external link (its destination, or the styling of a link that simply leaves the site). Judge the on-site first-time-visitor experience.

Be proportionate. FIRST judge what kind of page this is and how finished it's meant to be, then match the depth of your audit to that. A deliberately minimal placeholder (like example.com) deserves only 1-2 low-severity notes plus a clear statement that it's a placeholder — never pad the report or invent problems to hit a number. Every fix must be concrete and specific: suggest actual colors / hex, button styles, type sizes, spacing, layout, or exact copy — never vague advice like "improve the design". Calibrate severity to real impact on this page's goal, and mention genuine strengths in your summary.

Follow this audit guide:

${AUDIT_GUIDE}`;

// Every tool requires a `thought`: a short first-person narration of what the
// agent is doing and why. We surface it live so the user always sees the agent's
// reasoning — independent of whether the model emits reasoning tokens (many
// tool-calling models, e.g. Nemotron, return none on action turns).
const THOUGHT = {
  type: "string" as const,
  description:
    'One short, first-person sentence narrating what you\'re doing and why, for the person watching — e.g. "Let me try the signup button to see if it actually works."',
};

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
          thought: THOUGHT,
          instruction: {
            type: "string",
            description:
              "What to look for, e.g. 'the primary call-to-action' or 'navigation links'.",
          },
        },
        required: ["thought"],
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
          thought: THOUGHT,
          instruction: {
            type: "string",
            description: "The single action to perform.",
          },
        },
        required: ["thought", "instruction"],
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
          thought: THOUGHT,
          note: {
            type: "string",
            description: "Optional short label for what this shows.",
          },
        },
        required: ["thought"],
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
          thought: THOUGHT,
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
        required: ["thought", "category", "severity", "title", "description", "fix"],
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
          thought: THOUGHT,
          outcome: { type: "string", enum: ["done", "blocked"] },
          reason: { type: "string", description: "Brief reason for ending." },
        },
        required: ["thought", "outcome"],
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
  let step = 0; // declared before the try so the catch can still report progress

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
        const before = page.url();
        const res: any = await stagehand.act(instruction);
        const after = page.url();

        // Stay on the site that was pasted — don't follow links off-domain.
        if (!sameSite(after, url)) {
          await page.goto(before).catch(() => {});
          return {
            success: false,
            message: `That action left the site (it went to ${hostOf(after)}). This audit stays on ${hostOf(url)} only — I returned to the page. Don't follow links to other domains; audit just this site.`,
            url: page.url(),
            title: await page.title(),
          };
        }

        return {
          success: res?.success ?? true,
          message: res?.message ?? res?.action ?? null,
          url: after,
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

    let nudges = 0; // times we've nudged a narrating model to actually call a tool
    let emptyResponses = 0; // provider returned no choices (rate limit / hiccup)
    let sessionClosed = false; // Browserbase session ended (e.g. 15-min cap)
    // Bounded by MAX_STEPS (plus the model calling finish, the run being
    // cancelled, or the Browserbase session closing). No wall-clock cap.
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
      // OpenRouter can return a 200 with NO choices — an error payload instead
      // (rate-limited free model, provider hiccup). Reading res.choices[0]
      // directly then crashes ("undefined is not an object"). Guard it: retry a
      // few times for a transient blip, then stop gracefully with a report.
      const msg = res?.choices?.[0]?.message;
      if (!msg) {
        emptyResponses++;
        console.log(
          `Model returned no choices (attempt ${emptyResponses}):`,
          truncate(JSON.stringify(res)),
        );
        if (emptyResponses <= 3) continue; // transient — try again
        break; // give up and synthesize from what we have so far
      }
      messages.push(msg as ChatMessage);

      // Surface the model's reasoning so the UI can show what it's thinking.
      // OpenRouter exposes reasoning in different shapes per model: a `reasoning`
      // string, OR a `reasoning_details` array of { type, text } parts. Read both,
      // then fall back to the message content.
      const m = msg as any;
      let reasoning = typeof m.reasoning === "string" ? m.reasoning.trim() : "";
      if (!reasoning && Array.isArray(m.reasoning_details)) {
        reasoning = m.reasoning_details
          .map((d: any) => (typeof d?.text === "string" ? d.text : ""))
          .join(" ")
          .trim();
      }
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
        const args = safeForEvent(fn?.arguments);
        // Every tool call carries a first-person `thought` (required by the
        // schema). Surface it as the agent's reasoning — this is the reliable,
        // model-agnostic source, unlike optional reasoning tokens above.
        const narration =
          typeof (args as any)?.thought === "string"
            ? (args as any).thought.trim()
            : "";
        if (narration) onEvent({ type: "thinking", text: narration });
        const result = await runTool(impls, fn?.name, fn?.arguments);
        console.log(
          `[step ${step}] ${fn?.name}(${truncate(fn?.arguments)}) -> ${truncate(JSON.stringify(result))}`,
        );
        onEvent({
          type: "step",
          index: step,
          tool: fn?.name,
          args,
          result,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
        // The Browserbase session ended (e.g. hit the 15-min cap). Stop and build
        // a report from what we already have instead of erroring or looping.
        if ((result as any)?.__sessionClosed) {
          sessionClosed = true;
          break;
        }
      }
      if (sessionClosed) break;

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
      : await synthesize(messages, findings, sessionClosed).catch(
          () => "Could not generate a summary.",
        );
    const status: AuditResult["status"] = aborted
      ? "cancelled"
      : finished
        ? (finished as { outcome: "done" | "blocked" }).outcome
        : sessionClosed
          ? "blocked"
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
    // If the failure is just the Browserbase session ending, don't error out —
    // hand back a report built from whatever was found so far.
    if (isSessionClosed(err)) {
      const summary = await synthesize([], findings, true).catch(
        () => "The audit ended early when the browser session closed.",
      );
      const result: AuditResult = {
        url,
        status: "blocked",
        steps: step,
        findings,
        summary,
        screenshots,
      };
      onEvent({ type: "done", result });
      return result;
    }
    onEvent({ type: "error", message: (err as Error).message });
    throw err;
  } finally {
    await stagehand.close().catch(() => {});
  }
}

/** One last model call to summarize the first-time-visitor experience. */
async function synthesize(
  messages: ChatMessage[],
  findings: Finding[],
  timeLimited = false,
): Promise<string> {
  const res = await llm.chat.completions.create({
    model: MODEL,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          `Write a short executive summary of the first-time-visitor experience for a busy founder. ` +
          `Lead with the overall impression, then the most important things to fix, then name 2-3 concrete strengths (specific things the page does well). ` +
          `If there were no real problems, say so plainly and make it a short "what's working well" list of strengths instead of inventing or padding issues. ` +
          `Be specific and reference what you actually saw.` +
          (timeLimited
            ? ` Note: the audit ended early (the browser session reached its time limit), so summarize only what was observed so far.`
            : ``) +
          ` Findings: ${JSON.stringify(findings)}`,
      },
    ],
  });

  // Read the summary from content, but fall back to reasoning shapes — some
  // models (e.g. gemini-2.5-pro) return the prose in `reasoning` /
  // `reasoning_details` and leave `content` empty, which left the report's
  // Summary blank ("—").
  const msg = res?.choices?.[0]?.message as any;
  let out = typeof msg?.content === "string" ? msg.content.trim() : "";
  if (!out && typeof msg?.reasoning === "string") out = msg.reasoning.trim();
  if (!out && Array.isArray(msg?.reasoning_details)) {
    out = msg.reasoning_details
      .map((d: any) => (typeof d?.text === "string" ? d.text : ""))
      .join(" ")
      .trim();
  }
  if (out) return out;

  // Model returned nothing usable — build a deterministic summary from the
  // findings so the report is never left without one.
  if (!findings.length) {
    return "No significant friction was found for a first-time visitor — the core flow worked and the page read clearly.";
  }
  const top = findings.find((f) => f.severity === "high") ?? findings[0];
  return (
    `A first-time visitor would hit ${findings.length} issue${findings.length > 1 ? "s" : ""} on this page. ` +
    `The most important: ${top.title}. ${top.fix}`
  );
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
    if (isSessionClosed(e)) {
      return { error: "the browser session ended", __sessionClosed: true };
    }
    return {
      error: `tool "${name}" threw: ${(e as Error).message}`,
      hint: "Try a different action, observe again, or finish as blocked if you cannot proceed.",
    };
  }
}

// Detect errors that mean the Browserbase session is gone (e.g. it hit the
// 15-min cap, or the CDP socket closed). When this happens we stop and report
// what we have instead of erroring or looping forever.
function isSessionClosed(err: unknown): boolean {
  const m = String((err as any)?.message ?? err ?? "").toLowerCase();
  return [
    "session timed out",
    "transport closed",
    "socket-close",
    "target closed",
    "connection ended",
    "session not found",
    "browser has disconnected",
    "cdp connection closed",
  ].some((s) => m.includes(s));
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
// Retries briefly: right after init the debugger URL may not be provisioned
// yet, and a single failed fetch would leave the live view stuck on
// "Connecting…" for the whole run (looks like the live browser never updates).
async function getLiveViewUrl(
  sessionId: string,
  attempts = 5,
): Promise<string | undefined> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(
        `https://api.browserbase.com/v1/sessions/${sessionId}/debug`,
        {
          headers: { "X-BB-API-Key": process.env.BROWSERBASE_API_KEY ?? "" },
        },
      );
      if (res.ok) {
        const data: any = await res.json();
        const url =
          data?.debuggerFullscreenUrl ?? data?.pages?.[0]?.debuggerFullscreenUrl;
        if (url) return url;
      }
    } catch {
      /* transient — retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
}

// Best-effort parse of tool args for event payloads (never throws).
// Is `target` on the same site as `base`? True for the same host or the same
// apex domain (so subdomains of the audited site count as inside, external
// domains don't). Used to keep the agent on the pasted link only.
function sameSite(target: string, base: string): boolean {
  try {
    const ht = new URL(target).hostname.replace(/^www\./, "");
    const hb = new URL(base).hostname.replace(/^www\./, "");
    if (ht === hb) return true;
    const apex = (h: string) => h.split(".").slice(-2).join(".");
    return apex(ht) === apex(hb);
  } catch {
    return false;
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

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
