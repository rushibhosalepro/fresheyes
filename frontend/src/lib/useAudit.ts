"use client";

import { useCallback, useRef, useState } from "react";
import type {
  AuditResult,
  Finding,
  RunStatus,
  Screenshot,
  Step,
} from "./types";
import { pendoTrack } from "./analytics";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8787";

interface Meta {
  url: string;
  goal: string;
  title: string;
}

/**
 * Drives one audit: POST /api/runs to create it, then stream the agent's
 * events over SSE, accumulating live view / reasoning / steps / findings.
 */
export function useAudit() {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(null);
  const [thinking, setThinking] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const toolsRef = useRef<string[]>([]);
  const auditUrlRef = useRef("");
  const stepsCountRef = useRef(0);
  const findingsCountRef = useRef(0);

  const reset = () => {
    setMeta(null);
    setLiveViewUrl(null);
    setThinking(null);
    setSteps([]);
    setFindings([]);
    setScreenshots([]);
    setResult(null);
    setError(null);
    toolsRef.current = [];
    auditUrlRef.current = "";
    stepsCountRef.current = 0;
    findingsCountRef.current = 0;
  };

  // Closing the EventSource drops the SSE connection, which the server detects
  // (req close) and uses to abort the agent — so cancelling actually stops work.
  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setThinking(null);
    setStatus("cancelled");
    pendoTrack("audit_cancelled", {
      url: auditUrlRef.current,
      stepsCompletedBeforeCancel: stepsCountRef.current,
      findingsCountBeforeCancel: findingsCountRef.current,
    });
  }, []);

  const start = useCallback(async (url: string, goal?: string, suggestedPrompt = false) => {
    esRef.current?.close();
    reset();
    auditUrlRef.current = url;
    setStatus("starting");

    try {
      const res = await fetch(`${API}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, goal }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { runId } = await res.json();

      try {
        if (typeof pendo !== "undefined") {
          pendo.trackAgent("prompt", {
            agentId: "72mxajaMoLqJ4EHLihyd39v7Wdw",
            conversationId: runId,
            messageId: crypto.randomUUID(),
            content: url,
            suggestedPrompt,
            fileUploaded: false,
          });
        }
      } catch { /* analytics must never break the app */ }

      const es = new EventSource(`${API}/api/runs/${runId}/events`);
      esRef.current = es;
      setStatus("running");
      pendoTrack("audit_started", { url, suggestedPrompt });

      const on = (name: string, fn: (data: any) => void) =>
        es.addEventListener(name, (ev) => {
          try {
            fn(JSON.parse((ev as MessageEvent).data));
          } catch {
            /* ignore malformed frame */
          }
        });

      on("session", (d) => d.liveViewUrl && setLiveViewUrl(d.liveViewUrl));
      on("start", (d) => setMeta({ url: d.url, goal: d.goal, title: d.title }));
      on("thinking", (d) => d.text && setThinking(d.text));
      on("step", (d: Step) => {
        setSteps((s) => [...s, d]);
        stepsCountRef.current += 1;
        if (d.tool) toolsRef.current.push(d.tool);
      });
      on("finding", (d: { finding: Finding }) => {
        findingsCountRef.current += 1;
        setFindings((f) => [...f, d.finding]);
      });
      on("done", (d: { result: AuditResult }) => {
        // The SSE `done` is sent without screenshots (too big for one frame);
        // the `end` handler below pulls the full result with images.
        setResult(d.result);
        setThinking(null);
        pendoTrack("audit_completed", {
          url,
          auditStatus: d.result.status,
          steps: d.result.steps,
          findingsCount: d.result.findings.length,
          screenshotsCount: d.result.screenshots.length,
        });
        try {
          if (typeof pendo !== "undefined") {
            pendo.trackAgent("agent_response", {
              agentId: "72mxajaMoLqJ4EHLihyd39v7Wdw",
              conversationId: runId,
              messageId: crypto.randomUUID(),
              content: d.result.summary,
              toolsUsed: [...new Set(toolsRef.current)],
            });
          }
        } catch { /* analytics must never break the app */ }
      });

      es.addEventListener("error", (ev) => {
        const data = (ev as MessageEvent).data;
        if (!data) return; // native EventSource error (e.g. stream closed) — ignore
        let msg = "stream error";
        try {
          msg = JSON.parse(data).message ?? "stream error";
        } catch {
          /* keep default */
        }
        setError(msg);
        setStatus("error");
        pendoTrack("audit_error", {
          url,
          errorMessage: msg.substring(0, 200),
          errorPhase: "stream",
          stepsCompletedBeforeError: stepsCountRef.current,
        });
        es.close();
      });

      es.addEventListener("end", async () => {
        setStatus("done");
        es.close();
        // Pull the full stored result so the report + recording keep their
        // images — the SSE `done` omits screenshots to stay under the HTTP/2
        // frame size that was killing the stream.
        try {
          const full = await fetch(`${API}/api/runs/${runId}`).then((r) => r.json());
          if (full?.result) {
            setResult(full.result);
            setScreenshots(full.result.screenshots ?? []);
          }
        } catch {
          /* keep the image-less report already shown */
        }
      });
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      setStatus("error");
      pendoTrack("audit_error", {
        url,
        errorMessage: (msg || "unknown").substring(0, 200),
        errorPhase: "init",
        stepsCompletedBeforeError: 0,
      });
    }
  }, []);

  return {
    status,
    meta,
    liveViewUrl,
    thinking,
    steps,
    findings,
    screenshots,
    result,
    error,
    start,
    stop,
  };
}
