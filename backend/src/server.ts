import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { runAgent, type AgentEvent, type AuditResult } from "./agent/runAgent";

type RunRecord = {
  url: string;
  goal?: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  result?: AuditResult;
  error?: string;
};

// In-memory run store (fine for the hackathon; swap for Turso later).
const runs = new Map<string, RunRecord>();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// 1) Create a run → returns { runId }.
app.post("/api/runs", (req, res) => {
  const { url, goal } = req.body ?? {};
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "Provide a valid http(s) url" });
    return;
  }
  const runId = randomUUID();
  runs.set(runId, { url, goal: typeof goal === "string" ? goal : undefined, status: "queued" });
  res.json({ runId });
});

// 2) Fetch a finished run (for shareable report links).
app.get("/api/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({ status: run.status, result: run.result ?? null, error: run.error ?? null });
});

// 3) Stream a run's events live (SSE). Starts the agent on connect.
app.get("/api/runs/:id/events", async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  // SSE headers (setHeader keeps the CORS header the middleware already set).
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering so events flush live
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Run-once guard: the agent must execute exactly once per run id. Browsers
  // auto-reconnect a dropped EventSource, and without this each reconnect would
  // start a brand-new audit. Any non-queued state → replay the result and close.
  if (run.status !== "queued") {
    if (run.result) send("done", { result: run.result });
    send("end", { ok: true });
    res.end();
    return;
  }
  run.status = "running";

  let aborted = false;
  const ac = new AbortController();
  req.on("close", () => {
    aborted = true;
    ac.abort(); // stop the agent loop + close the browser, so we don't burn credits
  });

  send("status", { status: "running", url: run.url });

  try {
    const result = await runAgent(run.url, {
      goal: run.goal,
      signal: ac.signal,
      onEvent: (e: AgentEvent) => {
        if (!aborted) send(e.type, e);
      },
    });
    run.status = aborted ? "cancelled" : "done";
    run.result = result;
    if (!aborted) send("end", { ok: true });
  } catch (err) {
    run.status = aborted ? "cancelled" : "error";
    run.error = (err as Error).message;
    if (!aborted) send("error", { message: run.error });
  } finally {
    res.end();
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`FreshEyes backend → http://localhost:${port}`));
