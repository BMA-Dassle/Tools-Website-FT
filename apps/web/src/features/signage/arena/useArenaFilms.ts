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
import { NEXUS_REEL } from "../assets";
import type { ArenaActivity } from "~/features/arena-tickets/types";
import type { TvFeed } from "../types";

/** Re-check after a failed download. Long enough not to chew venue internet on
 *  every 15-second poll, short enough to recover within an evening. */
const RETRY_FLOOR_MS = 60_000;

/**
 * source url → object url, ONE PER FILM FOR THE LIFE OF THE PAGE — the same shape, and
 * for the same reason, as the wall's hook (useWallFilms.ts, which carries the full
 * account).
 *
 * It matters here too because this scene is NOT permanent: a called session takes the
 * board over, so the promo unmounts and remounts after every call. Revoking on unmount
 * meant the handle died with it, the next mount began with nothing, and the reel streamed
 * from the network again while the disk read caught up — on a file already sitting on the
 * disk. Bounded by the number of distinct films, not by the number of calls.
 */
const adopted = new Map<string, string>();

/** Release a film's handle — only when it leaves the manifest, never on unmount. */
function release(url: string) {
  const objectUrl = adopted.get(url);
  if (!objectUrl) return;
  adopted.delete(url);
  try {
    URL.revokeObjectURL(objectUrl);
  } catch {
    /* nothing to do */
  }
}

export interface ArenaFilmSources {
  /** A playable URL for this activity's film, or null when none is uploaded. */
  srcFor: (activity: ArenaActivity) => string | null;
  /** True when that URL is a local cache copy rather than a network stream. */
  isLocal: (activity: ArenaActivity) => boolean;
  /** For the ?debug=1 overlay. */
  status: { cachedCount: number; pending: number };
}

export function useArenaFilms(arena: TvFeed["arena"], enabled: boolean): ArenaFilmSources {
  // Seeded SYNCHRONOUSLY from the module map, so a remount after a call already holds
  // the handles it had before and plays from disk on its first frame.
  const [local, setLocal] = useState<Record<string, string>>(() => Object.fromEntries(adopted));
  const [pending, setPending] = useState(0);
  // url → last attempt, so a failing download backs off instead of retrying on
  // every poll.
  const attemptedAt = useRef<Record<string, number>>({});
  /** False once this mount is gone — only used to skip a pointless setState. */
  const aliveRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  // An uploaded reel wins; otherwise the house Nexus cut, so this board always has
  // something moving to play. That is what lets the arena playlist drop the house ad
  // slides entirely (owner 2026-09-01: "I didn't want the normal ad rotation on those
  // check in screens") — without a guaranteed film, `requiresData` would close over the
  // promo and the rotation would fall through to exactly the slides being removed.
  const laserUrl = arena?.films["laser-tag"]?.url ?? NEXUS_REEL;
  const gelUrl = arena?.films["gel-blaster"]?.url ?? NEXUS_REEL;

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
    // playing until its successor is completely on disk. Handles for anything that has
    // left the manifest go with it — the only moment one is really finished with.
    await pruneCache(manifest, ARENA_CACHE);
    for (const url of [...adopted.keys()]) if (!manifest.includes(url)) release(url);

    async function adopt(url: string) {
      // At most one handle per film, ever — see the module map.
      if (adopted.has(url)) return;
      const objectUrl = await cachedObjectUrl(url, ARENA_CACHE);
      if (!objectUrl) return;
      // Recorded even if this mount is already gone: the handle is what the next mount
      // needs. Only the setState is skipped.
      adopted.set(url, objectUrl);
      if (aliveRef.current) setLocal((prev) => ({ ...prev, [url]: objectUrl }));
    }
  }, [enabled, laserUrl, gelUrl]);

  /**
   * Sync on mount, and again on a slow beat while anything is still missing.
   *
   * Without the interval this ran ONCE PER PAGE LOAD, and the arena board's playlist is
   * a single scene — so `frameKey` never changes and this hook never remounts. A player
   * that relaunched during a wifi blip would therefore stream its reel off the network
   * for the life of the page, which is weeks: the exact pathology video-cache.ts exists
   * to prevent, since a file this size is evicted from the HTTP cache and re-downloaded
   * on every loop. `RETRY_FLOOR_MS` had nothing to fire it.
   */
  useEffect(() => {
    void sync();
    const iv = setInterval(() => void sync(), RETRY_FLOOR_MS);
    return () => clearInterval(iv);
  }, [sync, manifestKey]);

  // Nothing half-downloaded should outlive the screen.
  useEffect(() => () => abortRef.current?.abort(), []);

  // NOTHING IS REVOKED ON UNMOUNT — see the module map above. Handles are released when
  // a film leaves the manifest, which is the only moment one is really finished with.
  useEffect(() => {
    // Re-arm on (re)mount — StrictMode's dev double-mount runs this cleanup and then
    // the effect again on the same instance.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
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
