"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { pendoTrack } from "../lib/analytics";
import { downloadMarkdown, downloadPdf, toMarkdown } from "../lib/export";
import { useAudit } from "../lib/useAudit";
import type { AuditResult, Screenshot, Step } from "../lib/types";

const EXAMPLES = [
  "https://example.com",
  "https://news.ycombinator.com",
  "https://stripe.com",
];

export default function Home() {
  const [url, setUrl] = useState("");
  const {
    status,
    meta,
    liveViewUrl,
    thinking,
    steps,
    screenshots,
    result,
    error,
    start,
    stop,
  } = useAudit();
  const busy = status === "starting" || status === "running";
  const showLeft = busy || screenshots.length > 0;
  const showStage = busy || steps.length > 0 || !!result;

  const run = (raw: string, suggestedPrompt = false) => {
    const u = raw.trim();
    if (!u || busy) return;
    start(/^https?:\/\//i.test(u) ? u : `https://${u}`, undefined, suggestedPrompt);
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-5 py-10 sm:py-16">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <span aria-hidden>👁️</span> FreshEyes
        </div>
        <p className="text-zinc-600 dark:text-zinc-400">
          See your site through a first-time visitor&apos;s eyes. An agent walks
          your page like a brand-new user and reports exactly where they get
          stuck.
        </p>
      </header>

      <section className="rounded-2xl border border-black/[.08] bg-white p-5 shadow-sm dark:border-white/[.1] dark:bg-zinc-950">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(url);
          }}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="yoursite.com"
            inputMode="url"
            autoFocus
            className="h-12 flex-1 rounded-xl border border-black/[.1] bg-zinc-50 px-4 text-base text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:bg-white dark:border-white/[.12] dark:bg-zinc-900 dark:text-zinc-50 dark:focus:bg-zinc-900"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="h-12 rounded-xl bg-red-600 px-6 font-medium text-white transition hover:bg-red-500"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="h-12 rounded-xl bg-blue-600 px-6 font-medium text-white transition hover:bg-blue-500"
            >
              Run audit
            </button>
          )}
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
          <span>Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setUrl(ex);
                run(ex, true);
              }}
              disabled={busy}
              className="rounded-full border border-black/[.08] px-3 py-1 transition hover:border-blue-400 hover:text-blue-600 disabled:opacity-50 dark:border-white/[.12]"
            >
              {ex.replace(/^https?:\/\//, "")}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </div>
      )}

      {(busy || result || status === "cancelled") && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {busy && (
              <span className="inline-flex items-center gap-2 font-medium text-blue-600">
                <span className="h-2 w-2 animate-pulse rounded-full bg-blue-600" />
                Auditing
              </span>
            )}
            {status === "done" && (
              <span className="font-medium text-emerald-600">✓ Audit complete</span>
            )}
            {status === "cancelled" && (
              <span className="font-medium text-zinc-500">■ Stopped</span>
            )}
            {meta && <span className="text-zinc-500">{meta.title || meta.url}</span>}
          </div>
          {result && (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  downloadMarkdown(result);
                  pendoTrack("report_exported_markdown", {
                    url: result.url,
                    findingsCount: result.findings.length,
                    auditStatus: result.status,
                    exportFormat: "markdown",
                  });
                }}
                className="rounded-lg border border-black/[.1] px-3 py-1.5 text-sm font-medium transition hover:bg-black/[.04] dark:border-white/[.15] dark:hover:bg-white/[.06]"
              >
                ⬇ Markdown
              </button>
              <button
                onClick={() => {
                  downloadPdf(result);
                  pendoTrack("report_exported_pdf", {
                    url: result.url,
                    findingsCount: result.findings.length,
                    auditStatus: result.status,
                    exportFormat: "pdf",
                  });
                }}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500"
              >
                ⬇ PDF
              </button>
            </div>
          )}
        </div>
      )}

      {showStage && (
        <div
          className={`grid gap-6 ${showLeft ? "lg:grid-cols-2 lg:items-start" : ""}`}
        >
          {showLeft && (
            <div className="flex flex-col gap-3 lg:sticky lg:top-6">
              {busy ? (
                <>
                  <LiveView url={liveViewUrl} />
                  {thinking && (
                    <p className="animate-in-up text-sm italic leading-relaxed text-zinc-400 dark:text-zinc-500">
                      <span className="font-medium not-italic">AI:</span> {thinking}
                    </p>
                  )}
                </>
              ) : (
                <Recording screenshots={screenshots} />
              )}
            </div>
          )}

          <div>
            {result ? (
              <Report result={result} />
            ) : (
              <ActivityPanel steps={steps} busy={busy} />
            )}
          </div>
        </div>
      )}
    </main>
  );
}

/* ── Panel header ────────────────────────────────────────── */
function PanelHeader({
  title,
  subtitle,
  live,
}: {
  title: string;
  subtitle?: string;
  live?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-black/[.06] px-4 py-2.5 text-sm font-medium dark:border-white/[.08]">
      {live && <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />}
      {title}
      {subtitle && <span className="font-normal text-zinc-400">— {subtitle}</span>}
    </div>
  );
}

/* ── Live browser view (running) ─────────────────────────── */
function LiveView({ url }: { url: string | null }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
      <PanelHeader title="Live browser" subtitle="what the agent sees now" live />
      {url ? (
        <iframe
          src={url}
          title="Live browser session"
          className="aspect-video w-full bg-zinc-100 dark:bg-zinc-900"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      ) : (
        <Connecting />
      )}
    </section>
  );
}

function Connecting() {
  const msgs = [
    "Launching a fresh browser…",
    "Connecting to your page…",
    "Looking around like a first-time visitor…",
  ];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % msgs.length), 1800);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="grid aspect-video w-full place-items-center bg-zinc-50 dark:bg-zinc-900">
      <div className="flex flex-col items-center gap-3 text-zinc-500">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600" />
        <span className="text-sm">{msgs[i]}</span>
      </div>
    </div>
  );
}

/* ── Session recording (done) ────────────────────────────── */
function Recording({ screenshots }: { screenshots: Screenshot[] }) {
  const [i, setI] = useState(0);
  if (screenshots.length === 0) {
    return (
      <section className="overflow-hidden rounded-2xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
        <PanelHeader title="Session recording" />
        <div className="grid aspect-video w-full place-items-center bg-zinc-50 text-sm text-zinc-400 dark:bg-zinc-900">
          No frames captured
        </div>
      </section>
    );
  }
  const idx = Math.min(i, screenshots.length - 1);
  return (
    <section className="overflow-hidden rounded-2xl border border-black/[.08] bg-white dark:border-white/[.1] dark:bg-zinc-950">
      <PanelHeader
        title="Session recording"
        subtitle={`frame ${idx + 1} of ${screenshots.length}`}
      />
      {/* biome-ignore lint/performance/noImgElement: base64 data URIs */}
      <img
        src={`data:image/png;base64,${screenshots[idx].base64}`}
        alt={`frame ${idx + 1}`}
        className="aspect-video w-full bg-zinc-100 object-contain dark:bg-zinc-900"
      />
      <div className="flex gap-2 overflow-x-auto border-t border-black/[.06] p-2 dark:border-white/[.08]">
        {screenshots.map((s, k) => (
          <button
            key={s.id}
            onClick={() => setI(k)}
            className={`shrink-0 overflow-hidden rounded-md border-2 transition ${
              k === idx
                ? "border-blue-500"
                : "border-transparent opacity-60 hover:opacity-100"
            }`}
          >
            {/* biome-ignore lint/performance/noImgElement: base64 data URIs */}
            <img
              src={`data:image/png;base64,${s.base64}`}
              alt={`thumb ${k + 1}`}
              className="h-12 w-20 object-cover"
            />
          </button>
        ))}
      </div>
    </section>
  );
}

/* ── Full report as Markdown (done) ──────────────────────── */
function Report({ result }: { result: AuditResult }) {
  const images = new Map(result.screenshots.map((s) => [s.id, s.base64] as const));
  const md = toMarkdown(result, { images });
  return (
    <article className="md-report rounded-2xl border border-black/[.08] bg-white p-5 dark:border-white/[.1] dark:bg-zinc-950">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(u) =>
          u.startsWith("data:image/") ? u : defaultUrlTransform(u)
        }
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {md}
      </ReactMarkdown>
    </article>
  );
}

/* ── Live activity (running) ─────────────────────────────── */
function ActivityPanel({
  steps,
  busy,
}: {
  steps: Step[];
  busy: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll the activity list to the latest entry as steps stream in.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length, busy]);

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Agent activity
      </h2>

      <div
        ref={scrollRef}
        className="h-[420px] overflow-y-auto rounded-xl border border-black/[.06] bg-zinc-50/60 p-3 dark:border-white/[.08] dark:bg-zinc-900/40"
      >
        <ol className="flex flex-col gap-1.5">
          {steps.map((s, i) => {
            const { label, detail } = describe(s);
            return (
              <li key={i} className="animate-in-up flex items-start gap-2.5">
                <span aria-hidden className="mt-0.5">{toolIcon(s.tool)}</span>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
                  {detail && <span className="text-xs text-zinc-500">{detail}</span>}
                </div>
              </li>
            );
          })}
          {busy && (
            <li className="flex items-center gap-2 text-sm text-blue-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-600" />
              working…
            </li>
          )}
        </ol>
      </div>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────── */
function toolIcon(tool: string) {
  return (
    { observe: "👀", act: "🖱️", screenshot: "📸", record_finding: "⚠️", finish: "✅" }[
      tool
    ] ?? "•"
  );
}

function describe(s: Step): { label: string; detail?: string } {
  const a = (s.args ?? {}) as Record<string, string>;
  switch (s.tool) {
    case "observe":
      return { label: "Looking at the page", detail: a.instruction };
    case "act":
      return { label: "Taking an action", detail: a.instruction };
    case "screenshot":
      return { label: "Captured a screenshot", detail: a.note };
    case "record_finding":
      return {
        label: `Flagged a ${a.severity ?? ""} issue`.replace(/\s+/g, " ").trim(),
        detail: a.title,
      };
    case "finish":
      return {
        label:
          a.outcome === "blocked"
            ? "Stopped — couldn't get further"
            : "Reached the goal",
        detail: a.reason,
      };
    default:
      return { label: s.tool };
  }
}
