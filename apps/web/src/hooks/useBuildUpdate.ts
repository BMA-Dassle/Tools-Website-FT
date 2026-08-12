"use client";

/**
 * IS THIS TAB RUNNING YESTERDAY'S CODE?
 *
 * An admin board on a desk PC is opened once and left open — the check-in station
 * runs a whole shift, often a whole week. So a deploy does NOT reach it: staff keep
 * using the build that happened to be live when someone last opened the tab, and
 * every "did you get the fix?" ends in "hard-refresh it" (owner 2026-08-12: "enable
 * this page to grab updates when needed so when we push this goes live").
 *
 * SAME SHAPE AS THE KIOSK'S SELF-UPDATE (features/kiosk/version.ts), which has run
 * this way since 2026-07-19, and the same endpoint — /api/kiosk/version returns the
 * DEPLOY's sha, which is not kiosk-specific. One difference, and it is a
 * simplification: a server component here bakes its own sha into the page, so this
 * hook is handed the boot version rather than having to capture it at runtime. That
 * removes the kiosk's whole "the boot fetch failed, don't latch" failure mode —
 * the boot version cannot be unknown.
 *
 * IT DOES NOT RELOAD ANYTHING. It reports; the page decides when a reload is safe,
 * because only the page knows whether somebody is mid-action. See CheckInClient,
 * which waits for a quiet stretch.
 *
 * FAILS TO SILENT: a dev build, an empty version, or an unreachable endpoint never
 * reports an update, so a flaky network cannot put a board into a reload loop.
 */
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";

/** Two minutes. A deploy is not urgent to the second, and this rides the same
 *  visibility-aware poller as everything else on these boards. */
const DEFAULT_POLL_MS = 120_000;

export interface BuildUpdate {
  /** The server is serving a different deploy than this tab booted on. */
  ready: boolean;
  /** What the server is serving now, short-form. Null until the first poll. */
  serverVersion: string | null;
  /** Hard-reload into the new build. */
  reloadNow: () => void;
}

/** Compare on the short sha: the page bakes 7 characters, the endpoint returns the
 *  full one, and a deployment id has no length contract at all. */
function short(v: string): string {
  return v.trim().slice(0, 7);
}

export function useBuildUpdate(currentVersion: string, pollMs = DEFAULT_POLL_MS): BuildUpdate {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const boot = short(currentVersion || "");
  // "dev" is a local build with no deploy behind it; an empty sha means the page
  // could not name its own build, and comparing against that would flag every
  // poll as an update.
  const comparable = boot !== "" && boot !== "dev";

  useVisibleInterval(
    async (signal) => {
      try {
        const res = await fetch("/api/kiosk/version", { cache: "no-store", signal });
        if (!res.ok || signal.aborted) return;
        const data = (await res.json()) as { version?: unknown };
        if (typeof data.version !== "string" || signal.aborted) return;
        setServerVersion(short(data.version));
      } catch {
        /* offline or aborted — say nothing, try again next tick */
      }
    },
    pollMs,
    comparable,
  );

  const reloadNow = useCallback(() => {
    window.location.reload();
  }, []);

  const ready =
    comparable && serverVersion !== null && serverVersion !== "dev" && serverVersion !== boot;

  return { ready, serverVersion, reloadNow };
}
