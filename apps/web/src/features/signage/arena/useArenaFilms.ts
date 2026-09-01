"use client";

/**
 * Keep this player's copy of the arena promo films up to date, and hand the
 * scene a URL it can play.
 *
 * The briefing rooms' sibling of this (briefing/useBriefingAssets.ts) is the
 * reference for the mechanics — Cache Storage rather than the HTTP cache,
 * background download then swap, `cache.put()` rejecting a half-download so
 * there is never a partial entry to guard against. Read the header there for the
 * full account of why.
 *
 * IT IS A SEPARATE HOOK, NOT A REUSE, FOR ONE REASON: the briefing hook's most
 * important behaviour is that it PAUSES prefetching while a film is playing,
 * because a 218 MB download starved the player mid-safety-briefing and blacked
 * a room out (2026-08-11). That rule is exactly wrong here. A promo reel plays
 * for most of the arena board's day, so pausing on playback would mean a newly
 * uploaded film never downloads at all. Bolting a mode switch onto the briefing
 * hook to express "and sometimes do the opposite" would put the room's hard-won
 * behaviour one boolean away from being turned off by accident.
 *
 * The trade is honest and small: an arena promo streaming over venue wifi while
 * a download runs may stutter. A stuttering advert costs nothing. That is not
 * true of a safety briefing, which is the whole reason the two are apart.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ARENA_CACHE,
  cachedObjectUrl,
  cachedUrls,
  ensureCached,
  planCacheOps,
  pruneCache,
  requestPersistence,
} from "../video-cache";
import type { ArenaActivity } from "~/features/arena-tickets/types";
import type { TvFeed } from "../types";

/** Re-check after a failed download. Long enough not to chew venue internet on
 *  every 15-second poll, short enough to recover within an evening. */
const RETRY_FLOOR_MS = 60_000;

export interface ArenaFilmSources {
  /** A playable URL for this activity's film, or null when none is uploaded. */
  srcFor: (activity: ArenaActivity) => string | null;
  /** True when that URL is a local cache copy rather than a network stream. */
  isLocal: (activity: ArenaActivity) => boolean;
  /** For the ?debug=1 overlay. */
  status: { cachedCount: number; pending: number };
}

export function useArenaFilms(arena: TvFeed["arena"], enabled: boolean): ArenaFilmSources {
  // url → object URL, for everything confirmed on disk.
  const [local, setLocal] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(0);
  // url → last attempt, so a failing download backs off instead of retrying on
  // every poll.
  const attemptedAt = useRef<Record<string, number>>({});
  // Object URLs we created, so they can be revoked. An un-revoked blob URL pins
  // its whole file in memory, and this page runs for weeks.
  const created = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const laserUrl = arena?.films["laser-tag"]?.url ?? null;
  const gelUrl = arena?.films["gel-blaster"]?.url ?? null;

  // Primitive dependency rather than the object: the feed is a new object every
  // poll, and depending on it would restart the sync every fifteen seconds.
  const manifestKey = `${laserUrl ?? ""}|${gelUrl ?? ""}`;

  const sync = useCallback(async () => {
    if (!enabled) return;
    const manifest = [laserUrl, gelUrl];
    if (manifest.every((u) => !u)) return;

    await requestPersistence();

    const { fetch: toFetch } = planCacheOps(await cachedUrls(ARENA_CACHE), manifest);

    // Adoption is a disk read, not a download — it always runs, so a player that
    // boots with films already cached plays them locally on its first frame
    // instead of streaming bytes it is sitting on.
    for (const url of manifest) {
      if (!url || toFetch.includes(url)) continue;
      await adopt(url);
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const now = Date.now();
    const due = toFetch.filter((url) => now - (attemptedAt.current[url] ?? 0) >= RETRY_FLOOR_MS);

    if (due.length > 0) {
      setPending(due.length);
      for (const url of due) {
        attemptedAt.current[url] = Date.now();
        // Sequential on purpose. Two large downloads racing each other on venue
        // internet both finish later than one after the other, and the first one
        // finishing is what gets the board a film.
        if (controller.signal.aborted) break;
        if (await ensureCached(url, controller.signal, ARENA_CACHE)) await adopt(url);
        setPending((n) => Math.max(0, n - 1));
      }
    }

    // Prune only AFTER the new files are safely down, so a replaced film keeps
    // playing until its successor is completely on disk.
    await pruneCache(manifest, ARENA_CACHE);

    async function adopt(url: string) {
      // Re-adopting would leak an object URL per poll.
      if (created.current.has(url)) return;
      const objectUrl = await cachedObjectUrl(url, ARENA_CACHE);
      if (!objectUrl) return;
      created.current.add(url);
      setLocal((prev) => ({ ...prev, [url]: objectUrl }));
    }
  }, [enabled, laserUrl, gelUrl]);

  useEffect(() => {
    void sync();
  }, [sync, manifestKey]);

  // Nothing half-downloaded should outlive the screen.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Revoke on unmount only. Revoking when a URL leaves the manifest would pull
  // a film out from under a reel that is mid-play.
  useEffect(() => {
    const urls = created.current;
    const map = local;
    return () => {
      for (const objectUrl of Object.values(map)) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* nothing to do */
        }
      }
      urls.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(() => {
    const urlFor = (activity: ArenaActivity) => (activity === "laser-tag" ? laserUrl : gelUrl);
    return {
      srcFor: (activity: ArenaActivity) => {
        const url = urlFor(activity);
        if (!url) return null;
        // Local copy first; otherwise stream from the store while it downloads.
        return local[url] ?? url;
      },
      isLocal: (activity: ArenaActivity) => {
        const url = urlFor(activity);
        return !!url && !!local[url];
      },
      status: { cachedCount: Object.keys(local).length, pending },
    };
  }, [local, pending, laserUrl, gelUrl]);
}
