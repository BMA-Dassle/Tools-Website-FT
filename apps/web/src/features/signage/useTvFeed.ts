"use client";

/**
 * Poll the feed, and never let the screen go blank because of it.
 *
 * THE LAST GOOD FEED IS THE FLOOR. A failed poll keeps whatever we last had —
 * and that value is mirrored into localStorage, so even a cold boot during an
 * outage paints real content instead of an empty rotation. This is the same
 * "silent poll" discipline the reservations board uses, taken further because
 * nobody is standing at a TV to hit refresh.
 *
 * useVisibleInterval gives no-overlap scheduling and a per-cycle AbortSignal.
 * Its pause-on-hidden buys nothing on a wall panel that is never hidden, but the
 * no-overlap guarantee matters enormously on a page that runs for weeks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { TV_POLL_MS, TV_PULSE_MS } from "./constants";
import type { TvFeed } from "./types";

const CACHE_PREFIX = "tv_feed_cache:";

export function useTvFeed(screenId: string | null): TvFeed | null {
  const [feed, setFeed] = useState<TvFeed | null>(null);
  const lastGood = useRef<TvFeed | null>(null);

  // Seed from the previous session so a boot mid-outage still has content.
  // Deferred a microtask so the state write lands in a callback rather than
  // synchronously in the effect body (house pattern — see AttractScreen's boot
  // effect, which sets state only after an await).
  useEffect(() => {
    if (!screenId) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled || lastGood.current) return;
      try {
        const raw = localStorage.getItem(CACHE_PREFIX + screenId);
        if (!raw) return;
        const parsed = JSON.parse(raw) as TvFeed;
        lastGood.current = parsed;
        setFeed(parsed);
      } catch {
        /* private mode or corrupt entry — the poll below fills in */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screenId]);

  const poll = useCallback(
    async (signal: AbortSignal) => {
      if (!screenId) return;
      try {
        const res = await fetch(`/api/tv/feed?screen=${encodeURIComponent(screenId)}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok) return; // keep last good
        const next = (await res.json()) as TvFeed;
        if (signal.aborted) return;
        lastGood.current = next;
        setFeed(next);
        try {
          localStorage.setItem(CACHE_PREFIX + screenId, JSON.stringify(next));
        } catch {
          /* cache is an optimization, not a requirement */
        }
      } catch {
        /* offline / aborted — the screen keeps rendering the last good feed */
      }
    },
    [screenId],
  );

  useVisibleInterval(poll, TV_POLL_MS, !!screenId);

  /* ── the fast lane ───────────────────────────────────────────────────
     Only the live half — scans, birthdays, wrong-race, reload, preview. It is
     three Redis reads, so it can run every couple of seconds without putting
     the party board's database work on the same cadence. Merged OVER the last
     full feed, so the board data it does not carry is left untouched. */
  const [pulse, setPulse] = useState<Pulse | null>(null);

  const pollPulse = useCallback(
    async (signal: AbortSignal) => {
      if (!screenId) return;
      try {
        const res = await fetch(`/api/tv/feed?pulse=1&screen=${encodeURIComponent(screenId)}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok) return;
        const next = (await res.json()) as Pulse;
        if (!signal.aborted) setPulse(next);
      } catch {
        /* keep the last pulse — a dropped beat must not clear the rail */
      }
    },
    [screenId],
  );

  useVisibleInterval(pollPulse, TV_PULSE_MS, !!screenId);

  return useMemo(() => {
    if (!feed) return null;
    if (!pulse) return feed;
    // The pulse is newer by construction; never let a slow full-feed response
    // land afterwards and undo a scan that has already appeared.
    return {
      ...feed,
      now: Math.max(feed.now, pulse.now),
      kioskEvents: pulse.kioskEvents,
      reloadAt: pulse.reloadAt,
      demoMode: pulse.demoMode,
    };
  }, [feed, pulse]);
}

interface Pulse {
  now: number;
  kioskEvents: TvFeed["kioskEvents"];
  reloadAt: number | null;
  demoMode: string | null;
}
