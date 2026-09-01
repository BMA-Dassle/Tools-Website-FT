"use client";

/**
 * Keep this panel's copy of its marketing reels on disk, and hand the scene a URL it
 * can play.
 *
 * Cache Storage, not the HTTP cache — briefing/useBriefingAssets.ts carries the full
 * account of why (Chromium caps a single HTTP cache entry at roughly an eighth of the
 * disk cache, and `cache.put()` rejects a half-download so a partial file can never
 * become an entry). This is the arena hook's shape rather than the briefing hook's,
 * for the arena hook's reason: the briefing hook PAUSES prefetching during playback,
 * which is right for a safety film and exactly wrong for a reel that plays most of the
 * evening — pausing would mean a new file never downloads at all.
 *
 * EACH PANEL CACHES ONLY ITS OWN FILMS. The manifest is what this panel plays, not the
 * wall's whole set: five players each holding four reels is four times the venue
 * bandwidth and disk for no gain, since a panel never plays its neighbour's film.
 * `pruneCache` is therefore scoped by the same manifest, which is why the wall has its
 * own cache name — a shared store would have five panels deleting each other's files.
 *
 * Nothing here throws. Every failure degrades to "stream it from the blob store", which
 * is what an uncached first evening looks like anyway.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WALL_CACHE,
  cachedObjectUrl,
  cachedUrls,
  ensureCached,
  planCacheOps,
  pruneCache,
  requestPersistence,
} from "./video-cache";

/** Re-check after a failed download. Long enough not to chew venue internet on every
 *  15-second poll, short enough to recover within an evening. */
const RETRY_FLOOR_MS = 60_000;

export interface WallFilmSources {
  /** A playable URL — the local copy when it is down, else the blob store. */
  srcFor: (url: string | null | undefined) => string | null;
  /** True when that URL is a local cache copy rather than a network stream. */
  isLocal: (url: string | null | undefined) => boolean;
}

/**
 * @param films every file THIS panel may play, in any order.
 * @param enabled false on a panel that shows no video at all, which is most of them —
 *        a disabled hook touches neither the network nor the disk.
 */
export function useWallFilms(films: readonly string[], enabled: boolean): WallFilmSources {
  // url → object URL, for everything confirmed on disk.
  const [local, setLocal] = useState<Record<string, string>>({});
  // url → last attempt, so a failing download backs off instead of retrying every poll.
  const attemptedAt = useRef<Record<string, number>>({});
  // Object URLs we created, so they can be revoked. An un-revoked blob URL pins its
  // whole file in memory, and this page runs for weeks.
  const created = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  // A primitive dependency rather than the array: a fresh array literal every render
  // would restart the sync on every tick of the shared clock.
  const manifestKey = films.join("|");

  const sync = useCallback(async () => {
    if (!enabled) return;
    const manifest = manifestKey ? manifestKey.split("|") : [];
    if (manifest.length === 0) return;

    await requestPersistence();

    const { fetch: toFetch } = planCacheOps(await cachedUrls(WALL_CACHE), manifest);

    // Adoption is a disk read, not a download — it always runs, so a player that boots
    // with its reels already cached plays them locally on the first frame instead of
    // streaming bytes it is sitting on.
    for (const url of manifest) {
      if (toFetch.includes(url)) continue;
      await adopt(url);
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const now = Date.now();
    const due = toFetch.filter((url) => now - (attemptedAt.current[url] ?? 0) >= RETRY_FLOOR_MS);

    for (const url of due) {
      attemptedAt.current[url] = Date.now();
      // Sequential on purpose. Two large downloads racing each other on venue internet
      // both finish later than one after the other, and the first one finishing is what
      // gets the panel a film.
      if (controller.signal.aborted) break;
      if (await ensureCached(url, controller.signal, WALL_CACHE)) await adopt(url);
    }

    // Prune only AFTER the new files are safely down, so a replaced reel keeps playing
    // until its successor is completely on disk.
    await pruneCache(manifest, WALL_CACHE);

    async function adopt(url: string) {
      // Re-adopting would leak an object URL per poll.
      if (created.current.has(url)) return;
      const objectUrl = await cachedObjectUrl(url, WALL_CACHE);
      if (!objectUrl) return;
      created.current.add(url);
      setLocal((prev) => ({ ...prev, [url]: objectUrl }));
    }
  }, [enabled, manifestKey]);

  useEffect(() => {
    void sync();
  }, [sync]);

  // Nothing half-downloaded should outlive the screen.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Revoke on unmount only. Revoking when a URL leaves the manifest would pull a film
  // out from under a reel that is mid-play.
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

  return useMemo(
    () => ({
      // Local copy first; otherwise stream from the store while it downloads.
      srcFor: (url) => (url ? (local[url] ?? url) : null),
      isLocal: (url) => !!url && !!local[url],
    }),
    [local],
  );
}
