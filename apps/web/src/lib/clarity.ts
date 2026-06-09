/**
 * Thin, safe wrappers around the Microsoft Clarity browser API.
 *
 * Clarity is injected by `components/analytics/ClarityAnalytics.tsx`. Its shim
 * (`window.clarity`) queues calls before the script finishes loading, so these
 * helpers are safe to call at any time — they no-op on the server and when
 * Clarity isn't present (e.g. admin routes, where it's never loaded).
 *
 * - `clarityTag` — a filterable session dimension (e.g. booking_step=checkout).
 *   Segment + search replays by it in the Clarity dashboard.
 * - `clarityEvent` — a named milestone (e.g. step:race:heats). Build funnels and
 *   smart events from these.
 */

type ClarityFn = (...args: unknown[]) => void;

function getClarity(): ClarityFn | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { clarity?: ClarityFn }).clarity;
  return typeof c === "function" ? c : null;
}

/** Set a filterable custom tag on the current Clarity session. */
export function clarityTag(key: string, value: string | string[]): void {
  getClarity()?.("set", key, value);
}

/** Record a named Clarity custom event (for funnels / smart events). */
export function clarityEvent(name: string): void {
  getClarity()?.("event", name);
}
