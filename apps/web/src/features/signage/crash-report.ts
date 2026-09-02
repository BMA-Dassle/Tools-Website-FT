"use client";

/**
 * Tell the server what just threw, from a page that may be about to reload.
 *
 * `keepalive` is the whole trick: the route boundary reports and then reloads
 * the tab, and an ordinary fetch is cancelled the moment navigation starts. A
 * keepalive request outlives the document, which is the difference between
 * knowing why five TVs rebooted and guessing at it for an evening.
 *
 * DELIBERATELY FIRE-AND-FORGET, and deliberately incapable of throwing. This is
 * called from an error boundary — from code whose entire job is handling a
 * failure — so a reporter that could itself fail would turn one fault into two.
 */

/** Baked at build time, same as the feed poller's. Identifies which code threw. */
const BUILD_SHA = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 8);

/**
 * At most one report per scene per minute.
 *
 * A scene that throws is re-selected on the next 250ms tick, so an unguarded
 * reporter would post four times a second for as long as the fault lasts — a
 * self-inflicted flood from nineteen screens at once, drowning the one report
 * that mattered. The FIRST of a burst is the one worth having.
 */
const REPORT_FLOOR_MS = 60_000;
const lastReportAt = new Map<string, number>();

export interface SceneCrashInput {
  error: unknown;
  /** The scene that threw, or null from the route-level boundary. */
  scene: string | null;
  origin: "scene" | "route";
}

/** This panel's screen id, read from the canonical URL TvApp rewrites at boot. */
function screenId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("screen");
  } catch {
    return null;
  }
}

export function reportCrash({ error, scene, origin }: SceneCrashInput): void {
  try {
    const key = `${origin}:${scene ?? "-"}`;
    const now = Date.now();
    if (now - (lastReportAt.get(key) ?? 0) < REPORT_FLOOR_MS) return;
    lastReportAt.set(key, now);

    const err = error as { message?: unknown; stack?: unknown; digest?: unknown } | null;
    const body = JSON.stringify({
      screen: screenId(),
      build: BUILD_SHA,
      scene,
      origin,
      message: typeof err?.message === "string" ? err.message : String(error),
      stack: typeof err?.stack === "string" ? err.stack : null,
      digest: typeof err?.digest === "string" ? err.digest : null,
    });

    void fetch("/api/tv/crash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // Survives the reload the route boundary is about to perform.
      keepalive: true,
    }).catch(() => {
      /* offline, or the origin is the thing that is broken — nothing to do */
    });
  } catch {
    /* reporting must never be the second fault */
  }
}
