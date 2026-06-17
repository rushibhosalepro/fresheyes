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
  // NOTE: do NOT set "Connection: keep-alive". It's a forbidden connection-
  // specific header in HTTP/2, and Railway terminates TLS/HTTP2 at its edge —
  // sending it makes the browser kill the stream with ERR_HTTP2_PROTOCOL_ERROR.
  // (It works locally only because that's plain HTTP/1.1.) SSE stays open
  // without it.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
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

  // Heartbeat: keep the SSE connection alive through slow agent steps (an
  // observe/act can take 20-40s with no events) so a proxy or the browser
  // doesn't drop the idle stream and disconnect the run mid-audit.
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* connection already closed */
    }
  }, 15000);

  let aborted = false;
  const ac = new AbortController();
  req.on("close", () => {
    aborted = true;
    clearInterval(heartbeat);
    ac.abort(); // stop the agent loop + close the browser, so we don't burn credits
  });

  send("status", { status: "running", url: run.url });

  try {
    const result = await runAgent(run.url, {
      goal: run.goal,
      signal: ac.signal,
      onEvent: (e: AgentEvent) => {
        if (aborted) return;
        // The `done` result carries every screenshot's base64; sending them in
        // one SSE frame trips ERR_HTTP2_PROTOCOL_ERROR at the edge, so the client
        // never gets the report. Send a light `done` (no images) and let the
        // client pull the full result — with images — via GET /api/runs/:id.
        if (e.type === "done") {
          send("done", { ...e, result: { ...e.result, screenshots: [] } });
          return;
        }
        send(e.type, e);
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
    clearInterval(heartbeat);
    res.end();
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`FreshEyes backend → http://localhost:${port}`));
