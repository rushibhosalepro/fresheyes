"use client";

type Props = Record<string, unknown>;

/**
 * Fire a custom event into Novus if it's loaded. Safe no-op otherwise, so the
 * app works fine before/without the snippet. We probe the common global shapes
 * (window.novus / window.Novus, as an object with .track or as a callable) so
 * this keeps working whatever exact API Novus exposes.
 */
export function track(event: string, props: Props = {}) {
  if (typeof window === "undefined") return;
  try {
    const n = (window as any).novus ?? (window as any).Novus;
    if (!n) return;
    if (typeof n.track === "function") n.track(event, props);
    else if (typeof n === "function") n("track", event, props);
  } catch {
    /* analytics must never break the app */
  }
}
