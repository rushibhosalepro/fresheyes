"use client";

import { useCallback, useRef, useState } from "react";
import type {
  AuditResult,
  Finding,
  RunStatus,
  Screenshot,
  Step,
} from "./types";

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

  const reset = () => {
    setMeta(null);
    setLiveViewUrl(null);
    setThinking(null);
    setSteps([]);
    setFindings([]);
    setScreenshots([]);
    setResult(null);
    setError(null);
  };

  // Closing the EventSource drops the SSE connection, which the server detects
  // (req close) and uses to abort the agent — so cancelling actually stops work.
  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setThinking(null);
    setStatus("cancelled");
  }, []);

  const start = useCallback(async (url: string, goal?: string) => {
    esRef.current?.close();
    reset();
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

      const es = new EventSource(`${API}/api/runs/${runId}/events`);
      esRef.current = es;
      setStatus("running");

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
      on("step", (d: Step) => setSteps((s) => [...s, d]));
      on("screenshot", (d: Screenshot) =>
        setScreenshots((s) => [...s, { id: d.id, base64: d.base64 }]),
      );
      on("finding", (d: { finding: Finding }) =>
        setFindings((f) => [...f, d.finding]),
      );
      on("done", (d: { result: AuditResult }) => {
        setResult(d.result);
        setThinking(null);
      });

      es.addEventListener("error", (ev) => {
        const data = (ev as MessageEvent).data;
        if (!data) return; // native EventSource error (e.g. stream closed) — ignore
        try {
          setError(JSON.parse(data).message ?? "stream error");
        } catch {
          setError("stream error");
        }
        setStatus("error");
        es.close();
      });

      es.addEventListener("end", () => {
        setStatus("done");
        es.close();
      });
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
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
