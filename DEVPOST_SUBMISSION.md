# FreshEyes — Devpost Submission

> An AI agent that walks your website like a brand-new visitor and reports exactly where they get stuck — with concrete fixes and screenshot evidence.

---

## 🔗 Try it

- **Live app:** https://fresheyes.vercel.app/
- **Demo video (2–3 min):** https://youtu.be/Q598AuZNlkk
- **Full audit of a larger site (~15 min, end-to-end):** https://youtu.be/1sqHTFl_Npw
- **Code:** https://github.com/rushibhosalepro/fresheyes
- **Novus dashboard proof:** https://github.com/rushibhosalepro/fresheyes/tree/main/novus-proofs

---

## Mission

Everyone ships now — but shipping isn't the finish line; being *understood* is. FreshEyes exists to give every builder the one thing they can't get on their own: an honest, first-time look at their own product. We want a stranger's confusion to be visible *before* it costs you a user — so anyone, on any budget, can see their product through fresh eyes and fix the first impression early.

---

## Inspiration

Everyone ships now — developers, PMs, and designers can all build and put a site live. But you can't un-see your own product: the people who build a website already know what it is, who it's for, and where every button leads. So they're the *worst* judges of the first 10 seconds a stranger spends on it, even though those 10 seconds decide whether the stranger stays.

The usual ways to close that gap are bad: real user testing is slow and expensive — and by the time that feedback reaches you, you've already lost users; "audit" tools just run Lighthouse and hand you performance scores; and asking friends gets you politeness instead of the moment they got lost. There's a gap between *"technically works"* and *"a real person lands on it and actually gets it."* FreshEyes lives in that gap — it sends an AI through your site as a confused newcomer and tells you what it found.

---

## What it does

Paste any URL. FreshEyes:

- **Opens a real cloud browser** and visits your site as a first-time visitor — no logins, no assumptions.
- **Streams every action live** — you watch it look, click, and react in real time, with its reasoning shown as it goes.
- **Judges the whole first impression** across 11 dimensions — clarity, CTA, visual design, imagery, copy, navigation, trust, forms, accessibility, performance, and errors.
- **Records each friction point** with a severity, the page URL, a screenshot as evidence, and a **concrete** fix (actual colors, button styles, copy — not "improve the design").
- **Returns a Markdown report** you can read inline, scrub frame-by-frame, and export to Markdown or PDF.

Crucially, it's **calibrated, not padded**: it first figures out *what kind of page this is* — a throwaway placeholder vs. a real product page — and matches the depth and severity of its audit to reality.

---

## How I built it

FreshEyes is a **brain + hands** agent. An LLM does the reasoning; a real cloud browser does the doing; everything streams to the UI live.

- **Brain:** the OpenAI SDK pointed at **OpenRouter**, running a hand-rolled, bounded tool-calling loop. The model decides the next browser action one step at a time.
- **Hands:** **Stagehand** on **Browserbase** — a managed remote browser with a live view. The model's tools are `observe`, `act`, `screenshot`, `record_finding`, and `finish`.
- **The rubric is a file:** the agent's judgment lives in `skill.md`, a first-time-visitor audit guide loaded into the system prompt — so the product's "taste" can be tuned without touching code.
- **Backend:** Bun + Express, streaming the agent's steps, reasoning, screenshots, and findings to the browser over Server-Sent Events.
- **Frontend:** Next.js + Tailwind — a live browser view, a streaming activity feed, and a Markdown report with PDF/Markdown export.
- **Analytics — Novus:** the app is instrumented with **Novus** (Pendo's product agent, the hackathon's sponsor tool). Novus connected to the repo, auto-detected pages and click events, and instruments the full audit funnel (`audit_started → audit_completed`) plus AI-agent analytics on the audit interaction itself — so real user behavior is measurable the moment the first stranger lands, without hand-writing tracking code. **Novus dashboard proof:** https://github.com/rushibhosalepro/fresheyes/tree/main/novus-proofs

---

## Challenges I ran into

- **Driving a real browser reliably.** An agent clicking through arbitrary sites fails in a hundred ways — logins, bot-checks, timeouts. The fix was to treat a block as a *finding* (not a crash), cap the loop, capture the live view immediately so it never *looks* stuck, and guard the run so a dropped connection can never re-trigger a second audit.
- **Making the model behave reliably as an agent.** Models can emit malformed tool calls. The loop had to feed every error back as a message the model could read and self-correct from, instead of dead-ending.
- **Proportionate judgment.** Early versions over-reported — four findings and a "HIGH" on a placeholder page. Moving the calibration logic into `skill.md` ("figure out the page type first, then audit to that") was the biggest jump in quality.
- **Streaming an agentic loop to the UI.** Surfacing the agent's reasoning, actions, screenshots, and findings as distinct live events — and letting the user truly cancel mid-run — took real iteration.

---

## What I learned

- **The rubric is the product.** A plain "review this site" prompt produces generic, padded feedback. A calibrated `skill.md` is what turned it into something useful.
- **A defensive loop matters more than the model.** Feeding tool errors back so malformed calls self-correct is what made the agent reliable, and routing through OpenRouter let me swap models with a one-line change.
- **Reliability beats cleverness for a demo.** Live view, block-as-finding, a real Stop, and a run-once guard are what keep a stranger's URL from ever hitting a blank screen.
- **Watching is the magic.** Streaming the agent's actions live turned "an AI looked at your site" into "I watched an AI get confused by my site" — far more convincing.

---

## What's next

- **Background jobs for long audits** — large sites can take anywhere from ~5 minutes to an hour to crawl fully. Move audits onto a durable background job queue with persistent run storage, so a scan keeps running independent of the browser connection and users can close the tab and come back to a finished report.
- **Vision by default** — pair a vision-capable model with the existing screenshot path so visual-design and imagery findings come from real pixels, not the DOM.
- **Multi-page journeys** — follow a full funnel (landing → pricing → signup), not just the first screen.
- **Before/after re-audits** — track a score over time as you ship fixes.
- **Persona modes** — audit as a "skeptical buyer," a "mobile user on slow data," or an "accessibility-first" visitor.
- **Shareable report links** — a public URL per audit to hand to your team.

---

## Built with

Next.js · React · Tailwind · Bun · Express · Server-Sent Events · OpenRouter · OpenAI SDK · Stagehand · Browserbase · Novus (Pendo) · react-markdown · jsPDF · Vercel · Railway
