# FreshEyes — Architecture

> An AI agent that walks your site as a first-time visitor and reports exactly where they get stuck.

Scope (locked): **first-time visitor experience audit** — the agent pursues the site's primary goal (landing → main CTA → start signup) the way a brand-new user would, streams its steps live, and returns a ranked friction report with screenshots.

---

## 1. Tech stack (what we use, and why)

| Layer | Choice | Why |
|---|---|---|
| **Frontend** | Next.js 15 (App Router) + React + Tailwind, deploy on **Vercel** | Polished UI fast (Craft score), great DX, Novus snippet drops in the root layout. |
| **Backend** | **Bun + Express**, deploy on **Railway** | Bun = fast TS runtime (already `bun init`'d). Express = familiar, ubiquitous middleware/routing; runs fine on Bun. SSE is done manually (`res.write` + headers) — a few lines. Runs the agent. |
| **Agent brain** | **OpenAI SDK** (`openai`) → **OpenRouter** (OpenAI-compatible `baseURL`) | OpenRouter speaks the OpenAI wire format, so the `openai` client is a model-agnostic gateway (free model now, Claude later = 1-line `model:` swap). We **hand-roll the tool-calling loop** — full control, easy to debug, no hidden framework flow. |
| **LLM (model)** | OpenRouter **free** model — pick a tool-calling + vision one (e.g. `google/gemini-2.0-flash-exp:free`) | Free for budget. Vision lets the agent *look* at screenshots to judge confusion. |
| **Browser (hands)** | **Stagehand** on **Browserbase** | Stagehand = natural-language `act/observe/extract` over Playwright; Browserbase = managed remote browser w/ stealth. De-risks the fragile clicking. |
| **Database** | `bun:sqlite` (dev) → **Turso / libSQL** (prod, free, durable) | Zero-infra in dev; durable across redeploys in prod. |
| **Screenshots** | base64 inline for the live stream + **Cloudflare R2** (free) for the saved report | Live view is instant; persisted report survives. |
| **Analytics** | **Novus.ai** snippet on the frontend | Required for prizes; tracks the funnel judges care about. |
| **Streaming** | **Server-Sent Events (SSE)** | One-way server→client is all we need; simpler than WebSockets. In Express: set `text/event-stream` headers and `res.write('data: ...\n\n')` per event. |

---

## 2. System components & how they connect

```
Browser (judge/user)
   │  HTTPS
   ▼
Next.js frontend (Vercel)  ──── Novus snippet (analytics)
   │  ① POST /api/runs {url, goal}        → returns { runId }
   │  ② EventSource GET /api/runs/:id/events  (SSE: live steps)
   ▼
Bun + Express backend (Railway)
   ├─ Agent orchestrator (hand-rolled tool-calling loop)
   │     ├─ brain  → OpenAI SDK → OpenRouter (free model)  [decide next action / judge friction / write report]
   │     └─ hands  → Stagehand → Browserbase browser  [navigate / act / observe / screenshot]
   ├─ SQLite/Turso  [runs, steps, findings]
   └─ R2  [persisted screenshots]
```

**Two network calls from the frontend:**
1. `POST /api/runs` with the URL → backend creates a run row, returns `runId`.
2. `EventSource('/api/runs/:runId/events')` → backend runs the agent and **streams every step** back as SSE. `EventSource` is GET-only, so the create/stream split keeps it clean.

---

## 3. End-to-end flow

1. User enters a URL on the frontend and clicks **Run audit** (or clicks a curated "try one of these").
2. Frontend `POST /api/runs` → backend inserts a `run` (status `queued`), returns `runId`. → Novus `run_started`.
3. Frontend opens `EventSource('/api/runs/:runId/events')`.
4. Backend starts the **agent loop**, emitting SSE events as it goes:
   - `plan` — inferred goal + step plan
   - `step` — `{ index, thought, action, screenshot(base64), errors }` (one per loop iteration)
   - `finding` — a friction point the agent logged
   - `done` — the full ranked report (or `blocked`/`error` with partial results)
5. Frontend renders a **live timeline** (thought + action + screenshot per step) as events arrive.
6. On `done`, frontend shows the **ranked report** (findings by severity, each with screenshot + fix) + export button. → Novus `run_completed`, `report_viewed`.
7. Backend persists run/steps/findings + uploads screenshots to R2.

---

## 4. The agent — how it actually works

A **bounded perceive→plan→act→observe loop** (max ~10 steps / 90s). The Vercel AI SDK runs the tool-calling loop; we give the model a small, robust toolset.

### Tools exposed to the model
| Tool | Signature | What it does |
|---|---|---|
| `goto` | `(url)` | Navigate the Browserbase page. |
| `observe` | `(instruction?)` | Stagehand returns candidate actionable elements (the "what can I click" list). |
| `act` | `(instruction)` | Stagehand performs a natural-language action ("click the Sign up button"). |
| `extract` | `(instruction, schema)` | Structured data from the page (e.g., is there a visible CTA?). |
| `screenshot` | `()` | Capture current view → base64 (streamed) + queued for R2. |
| `record_finding` | `(severity, title, description, fix)` | Agent logs a friction point. |
| `finish` | `(reason)` | End the run (goal reached / dead-end / blocked). |

### Loop (pseudocode) — hand-rolled OpenAI-SDK tool-calling loop
```ts
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,           // model-agnostic gateway
});

const messages = [
  { role: "system", content: FIRST_TIME_VISITOR_SYSTEM_PROMPT },
  { role: "user",   content: `Audit ${url}. Behave like a first-time visitor and reach: ${goal ?? "the primary CTA"}.` },
];

for (let step = 0; step < MAX_STEPS; step++) {        // hard cap = 10
  const res = await client.chat.completions.create({
    model: process.env.OPENROUTER_MODEL,             // free model
    messages,
    tools: TOOL_SCHEMAS,                             // goto/observe/act/extract/screenshot/record_finding/finish
    tool_choice: "auto",
  });
  const msg = res.choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) break;               // model stopped calling tools

  for (const call of msg.tool_calls) {
    const args = safeParse(call.function.arguments); // defensive: free models emit bad JSON
    const result = await runTool(call.function.name, args);
    sse.send(mapToEvent(call, result));             // stream 'step' / 'finding'
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    if (call.function.name === "finish") return synthesize(messages);
  }
}
return synthesize(messages);                          // cap reached → still produce a report
// synthesize() = one final call → ranked report → SSE 'done'
```

### Three reasoning jobs the model does
1. **Plan** — read landing page (DOM + screenshot) → infer the primary goal + a short step plan.
2. **Step decisions** — at each step pick the next tool call toward the goal; after observing, **judge friction** (confusing CTA, dead end, broken/!!404 link, slow load, form asking too much, unclear next step) and `record_finding` when warranted.
3. **Synthesize** — produce the final **ranked report**: each finding → severity, the screenshot, a one-line concrete fix, plus an overall "first-time visitor" summary + score. *(This is the Craft surface judges read — the one place to spend a few cents on a better model if budget allows.)*

### Block = finding, never a crash
Login wall / bot-block / timeout → the agent calls `record_finding` ("a first-time visitor can't proceed past X") and `finish('blocked')`. The user still gets a useful partial report. **No spinner of death.**

---

## 5. API (Express)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/runs` | Create a run `{url, goal?}` → `{runId}`. |
| `GET` | `/api/runs/:id/events` | **SSE** stream of `plan`/`step`/`finding`/`done`. |
| `GET` | `/api/runs/:id` | Fetch a finished run + findings (for shareable report links). |
| `GET` | `/api/examples` | Curated pre-baked demo runs (instant, no live call). |

---

## 6. Data model (SQLite / libSQL)

```sql
runs(    id, url, goal, status,        -- queued|running|done|blocked|error
         summary, score, created_at )
steps(   id, run_id, idx, thought, action, screenshot_url, errors_json, created_at )
findings(id, run_id, step_idx, severity,  -- high|medium|low
         title, description, fix, screenshot_url )
```

---

## 7. SSE event contract (frontend ↔ backend)

```
event: plan     data: { goal, steps: string[] }
event: step     data: { index, thought, action, screenshot, errors }
event: finding  data: { severity, title, description, fix, screenshot }
event: done     data: { status, summary, score, findings[] }
event: error    data: { message }
```

---

## 8. Environment / keys

```
# backend/.env
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemini-2.0-flash-exp:free
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
TURSO_DATABASE_URL=        # prod only; dev uses local sqlite file
TURSO_AUTH_TOKEN=
R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= R2_BUCKET=   # optional
FRONTEND_ORIGIN=http://localhost:3000   # CORS

# frontend/.env.local
NEXT_PUBLIC_API_BASE=http://localhost:8787
NEXT_PUBLIC_NOVUS_ID=
```

---

## 9. Reliability mechanisms (= our win strategy)

- **Open on a finished report** — frontend loads a pre-baked example instantly; the input is the *second* thing seen. No cold start.
- **Pre-baked demo runs** served from `/api/examples` so the video + first impression never depend on a live free-model call.
- **Curated "try one of these" URLs** verified to run cleanly.
- **Hard caps** (10 steps / 90s) + **graceful partial report**.
- **Defensive tool-calls** — validate args, retry once, then `finish` cleanly. Free models are flakier, so the loop assumes it.
- **Block-as-finding** (above).

---

## 10. Novus funnel (events to instrument)

`run_started` → `run_completed` (or `run_blocked`) → `report_viewed` → `finding_expanded` → `export_clicked` → `return_visit`. Also `example_clicked`. This shows judges real behavior + an engagement funnel.

---

## 11. Repo structure

```
fresheyes/
├─ backend/                # Bun + Hono
│  ├─ src/
│  │  ├─ index.ts          # Express app, routes, CORS
│  │  ├─ agent/
│  │  │  ├─ loop.ts        # hand-rolled OpenAI-SDK tool-calling loop
│  │  │  ├─ tools.ts       # goto/observe/act/extract/screenshot/record_finding/finish
│  │  │  ├─ prompts.ts     # system + synthesis prompts
│  │  │  └─ browser.ts     # Stagehand/Browserbase session
│  │  ├─ db.ts             # sqlite/libSQL + schema
│  │  ├─ sse.ts            # SSE helpers
│  │  └─ examples.ts       # pre-baked demo runs
│  └─ package.json
├─ frontend/               # Next.js + Tailwind
│  ├─ app/                 # landing + /run/[id] report page
│  ├─ components/          # Timeline, FindingCard, RunInput, ScoreBadge
│  └─ lib/novus.ts
├─ ARCHITECTURE.md
├─ README.md
└─ LICENSE
```

---

## 12. Build order (6-day sprint)

1. **Day 1** — Foundations + smoke test: Hono SSE endpoint streaming dummy steps → Next.js renders them. Stagehand connects to Browserbase and screenshots one page. Confirm the free model does a tool call. *(Prove the spine before building on it.)*
2. **Day 2** — Real agent loop: tools wired, bounded loop, plan + step decisions, findings.
3. **Day 3** — Synthesis report + report UI (timeline, finding cards, score) + persistence.
4. **Day 4** — Reliability: pre-baked examples, caps, block-handling, "try one of these", polish copy/UI.
5. **Day 5** — Novus install + event instrumentation, deploy frontend (Vercel) + backend (Railway), end-to-end on the live URL.
6. **Day 6** — Record the 2–3 min video, write the submission description, buffer for fixes.
```
