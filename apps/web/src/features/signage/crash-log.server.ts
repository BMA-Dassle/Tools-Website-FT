/**
 * WHERE A WALL PANEL'S EXCEPTION GOES.
 *
 * Until now: nowhere. app/tv/error.tsx said it plainly in its own header — "the
 * boundary itself is the only place this exception is ever observable" — and it
 * writes to a console nobody is standing at. So when five front-desk TVs rebooted
 * mid-evening (owner 2026-09-01, on a kiosk check-in), there was no stack, no
 * scene name, and no way to tell a render throw from a GPU stall. The only honest
 * answer to "why did they crash" was "we cannot see it", which is not an answer
 * anyone can fix.
 *
 * A capped Redis list, not a table: this is a black box recorder, not history.
 * Fifty entries and a week is enough to answer "what threw last night" while
 * being impossible to grow into a cost.
 *
 * NOTHING HERE MAY EVER BE ALLOWED TO FAIL A REQUEST — the writer is a screen
 * that has already crashed once, and a rejected report would be a second fault
 * on top of the first.
 */
import redis from "@/lib/redis";

export const CRASH_LOG_KEY = "signage:crashes";

/** Deep enough to hold an evening's worth of a looping panel, shallow enough to stay free. */
const KEEP = 50;
const TTL_SECONDS = 7 * 24 * 60 * 60;

/** How much of a stack is worth keeping. Production stacks are minified, so the
 *  top few frames carry everything a name can carry; the rest is React internals. */
const MAX_STACK = 2_000;
const MAX_MESSAGE = 500;

export interface CrashReport {
  /** ISO instant the report was received (server clock — a panel's may be wrong). */
  at: string;
  /** Which screen, e.g. "HPFM:4". Null when the panel crashed before resolving it. */
  screen: string | null;
  /** The build that tab was running — a crash on code we have already replaced is not a bug. */
  build: string | null;
  /**
   * The scene that threw, when a SCENE boundary caught it. Null from the route
   * boundary, which only ever sees "something under /tv threw".
   */
  scene: string | null;
  /** "scene" (degraded, panel kept running) or "route" (panel rebooted). */
  origin: "scene" | "route";
  message: string;
  stack: string | null;
  /** Next's server-error digest, on the rare client error that carries one. */
  digest: string | null;
}

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, max);
}

/**
 * Coerce whatever a screen posted into a report we are willing to store.
 *
 * The body is untrusted — this endpoint is public, like the feed it sits beside —
 * so every field is clamped and nothing is echoed back.
 */
export function toCrashReport(body: unknown, nowIso: string): CrashReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const message = clamp(b.message, MAX_MESSAGE);
  if (!message) return null; // a report with no message tells us nothing
  return {
    at: nowIso,
    screen: clamp(b.screen, 40),
    build: clamp(b.build, 40),
    scene: clamp(b.scene, 40),
    origin: b.origin === "scene" ? "scene" : "route",
    message,
    stack: clamp(b.stack, MAX_STACK),
    digest: clamp(b.digest, 60),
  };
}

/** Newest first. Never throws — a failed write must not fail the report. */
export async function recordCrash(report: CrashReport): Promise<void> {
  try {
    await redis.lpush(CRASH_LOG_KEY, JSON.stringify(report));
    await redis.ltrim(CRASH_LOG_KEY, 0, KEEP - 1);
    await redis.expire(CRASH_LOG_KEY, TTL_SECONDS);
  } catch (e) {
    console.error("[signage] crash report not stored:", (e as Error).message);
  }
}

/** Newest first. Returns [] rather than throwing, so a reader is never the fault. */
export async function readCrashes(limit: number = KEEP): Promise<CrashReport[]> {
  try {
    const raw = await redis.lrange(CRASH_LOG_KEY, 0, Math.max(0, limit - 1));
    const out: CrashReport[] = [];
    for (const entry of raw) {
      try {
        out.push(JSON.parse(entry) as CrashReport);
      } catch {
        /* a malformed entry is not worth failing the whole read for */
      }
    }
    return out;
  } catch {
    return [];
  }
}
