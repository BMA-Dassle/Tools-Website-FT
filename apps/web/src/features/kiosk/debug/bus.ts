/**
 * On-screen debug bus for the TEST kiosk (kiosk 99).
 *
 * Why this exists: the waiver path spans three rails — our Neon store, the BMI
 * cloud, and the center's local Firebird — and the interesting decisions happen
 * on the SERVER (barrier verdicts, which path was taken) or in a client branch
 * nobody can see (whether `ownValid` came from our record or Pandora's). When
 * something reads as "weird" on the floor, the only artefacts today are Vercel
 * logs nobody has open and a guest standing there. This puts the narration on
 * the glass.
 *
 * Deliberately NOT a logger. It is a bounded in-memory ring buffer with a
 * subscribe hook, and it is INERT unless armed by `armKioskDebug()` — which the
 * kiosk shell only calls for `isTestKiosk(cfg)`. On every other kiosk `push()`
 * returns immediately, so instrumentation can be left in place at call sites
 * without costing a guest-facing screen anything.
 *
 * No PII beyond what staff already see on the kiosk (first names, BMI person
 * ids). Never log a signature image, a card, or a key.
 */

export type DebugLevel = "info" | "good" | "warn" | "bad";

export interface DebugEvent {
  /** Monotonic within a session, so ordering survives identical timestamps. */
  seq: number;
  /** Wall clock ms — rendered as HH:MM:SS.mmm. */
  at: number;
  /** Short subsystem tag, e.g. "waiver", "guardian", "mint". */
  tag: string;
  message: string;
  level: DebugLevel;
}

/** Bounded so a long shift cannot grow this without limit. */
const MAX_EVENTS = 300;

let armed = false;
let seq = 0;
let events: DebugEvent[] = [];
const listeners = new Set<(e: DebugEvent[]) => void>();

/** Turn the bus on. Called only by the kiosk shell, only for kiosk 99. */
export function armKioskDebug(): void {
  armed = true;
}

export function isKioskDebugArmed(): boolean {
  return armed;
}

/**
 * Record one step. No-op unless armed, so call sites need no guard of their own.
 *
 * `message` should read like a sentence a manager could act on ("guardian
 * already waivered per OUR record — skipping their own pad"), not a variable
 * dump. The point is to make a decision legible, not to mirror the code.
 */
export function kioskDebug(tag: string, message: string, level: DebugLevel = "info"): void {
  if (!armed) return;
  const e: DebugEvent = { seq: ++seq, at: Date.now(), tag, message, level };
  // New events first: the panel is read top-down while something is happening,
  // and the newest line is the one being waited on.
  events = [e, ...events].slice(0, MAX_EVENTS);
  for (const fn of listeners) fn(events);
}

/**
 * Replay a SERVER-side trace. The sign route returns its own timestamped steps
 * (barrier verdicts, which path it took, what Pandora said) because the browser
 * cannot see any of it — that is the half of the story that was invisible.
 */
export function kioskDebugServerTrace(tag: string, trace: unknown): void {
  if (!armed || !Array.isArray(trace)) return;
  for (const line of trace) {
    if (typeof line !== "string") continue;
    /**
     * Convention: the route marks a line "!" for a problem or "+" for a success,
     * so the server colours its own narration without inventing a schema.
     *
     * The marker sits AFTER the route's own `[+1.2s]` elapsed-time prefix, so
     * this must skip that prefix first — matching on the raw string only ever
     * saw the "[" and rendered every line as plain info.
     */
    const m = /^(?:\[\+[\d.]+s\]\s*)?([!+])?\s*([\s\S]*)$/.exec(line);
    const marker = m?.[1];
    const rest = m?.[2] ?? line;
    const level: DebugLevel = marker === "!" ? "bad" : marker === "+" ? "good" : "info";
    // Keep the elapsed-time prefix visible — the gap between steps is the whole
    // point when you are diagnosing a sync wait.
    const elapsed = /^\[\+[\d.]+s\]/.exec(line)?.[0] ?? "";
    kioskDebug(tag, elapsed ? `${elapsed} ${rest}` : rest, level);
  }
}

export function subscribeKioskDebug(fn: (e: DebugEvent[]) => void): () => void {
  listeners.add(fn);
  fn(events);
  return () => listeners.delete(fn);
}

export function clearKioskDebug(): void {
  events = [];
  for (const fn of listeners) fn(events);
}

export function kioskDebugEvents(): DebugEvent[] {
  return events;
}
