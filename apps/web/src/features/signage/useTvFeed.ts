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
import type { TvFeed, TvPulse } from "./types";

const CACHE_PREFIX = "tv_feed_cache:";

/**
 * The build this tab is running, so the admin page can tell a stale board from
 * a broken feature. Baked at build time; a reloaded tab reports the new one.
 */
const BUILD_SHA = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 8);

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
        const res = await fetch(
          `/api/tv/feed?screen=${encodeURIComponent(screenId)}&build=${BUILD_SHA}`,
          {
            cache: "no-store",
            signal,
          },
        );
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
  const [pulse, setPulse] = useState<TvPulse | null>(null);

  const pollPulse = useCallback(
    async (signal: AbortSignal) => {
      if (!screenId) return;
      try {
        const res = await fetch(
          `/api/tv/feed?pulse=1&screen=${encodeURIComponent(screenId)}&build=${BUILD_SHA}`,
          {
            cache: "no-store",
            signal,
          },
        );
        if (!res.ok) return;
        const next = (await res.json()) as TvPulse;
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
      // A send must reach a briefing room's wall on the fast lane, not wait out
      // the 15s full poll — a group is standing in the room. Merged the same way
      // the scan rail is: pulse wins, and a dropped beat keeps the last known
      // state rather than clearing a room mid-video.
      briefingRooms: pulse.briefingRooms ?? feed.briefingRooms,
      // The pit lanes ride the same fast lane for the same reason: "send to
      // holding" and "race returned" are presses with a group standing at the
      // seats, and the rail they flip must move in seconds.
      pitLanes: pulse.pitLanes ?? feed.pitLanes,
      /**
       * THE CAMERA STRIP, on the fast lane so a registration clears in seconds
       * rather than on the next 15s poll (owner 2026-08-12).
       *
       * `in`, NOT `??`, and that difference is load-bearing. `null` here means the
       * KILL SWITCH IS OFF, so it has to win — with `??` a switched-off server
       * could never clear a strip already sitting in a screen's cached feed, which
       * would have made the switch useless in exactly the outage it exists for.
       * The `in` test still lets a pulse from an older build (no such field) fall
       * back rather than blanking the strip.
       *
       * Overlaid onto the briefing section rather than replacing it, so the films
       * and the welcome-back board keep coming from the full feed.
       */
      briefing: feed.briefing
        ? {
            ...feed.briefing,
            cameraReturn: "cameraReturn" in pulse ? pulse.cameraReturn : feed.briefing.cameraReturn,
          }
        : feed.briefing,
    };
  }, [feed, pulse]);
}
