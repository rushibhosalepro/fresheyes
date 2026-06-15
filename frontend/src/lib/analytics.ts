"use client";

type Props = Record<string, unknown>;

/** Fire a Pendo Track Event if the agent is loaded. Safe no-op otherwise. */
export function pendoTrack(event: string, props: Props = {}) {
  if (typeof window === "undefined") return;
  try {
    const p = (window as any).pendo;
    if (p && typeof p.track === "function") p.track(event, props);
  } catch {
    /* analytics must never break the app */
  }
}
