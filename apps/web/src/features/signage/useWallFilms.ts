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

/** Re-check after a failed download. Long enough not to chew venue internet, short
 *  enough to recover within an evening. */
const RETRY_FLOOR_MS = 60_000;

/**
 * WHAT THIS PLAYER HAS ALREADY TRIED, AND WHAT IS STILL IN FLIGHT — at MODULE scope,
 * deliberately, and both of these are bug fixes rather than tidiness.
 *
 * This scene unmounts every two minutes when the VIP artwork takes the wall, so a ref
 * would be reborn empty ~700 times a day and neither of these would ever hold:
 *
 *   - The retry floor was inert. Every mount started with an empty ledger, so a reel
 *     that 404s or is CORS-blocked was re-fetched on every single mount, forever, rather
 *     than backing off for a minute.
 *   - Worse, a download could never FINISH. The old code aborted the fetch on unmount,
 *     and a mount lasts about 101 seconds — so any reel that takes longer than that on
 *     venue wifi was cancelled, committed nothing, and restarted from byte zero two
 *     minutes later, forever. The FastTrax hero is 30 MB, which is exactly the size that
 *     loses that race, and exactly the size the HTTP cache refuses to keep.
 *
 * Keyed by URL and shared across mounts of this page, which is the right lifetime: it
 * describes what this BROWSER has done, not what this component instance has.
 */
const attemptedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<boolean>>();

/** Download once per URL per page, however many mounts ask for it. */
function ensureOnce(url: string): Promise<boolean> {
  const running = inFlight.get(url);
  if (running) return running;
  attemptedAt.set(url, Date.now());
  // NO AbortSignal: a cache write that completes after this mount is gone is pure
  // profit — the next turn plays it locally. `cache.put` only ever commits a whole
  // response, so an interrupted one leaves nothing to clean up.
  const p = ensureCached(url, undefined, WALL_CACHE).finally(() => inFlight.delete(url));
  inFlight.set(url, p);
  return p;
}

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
  /**
   * THE LIVE LEDGER of what THIS mount adopted: source url → object url.
   *
   * A ref and not the `local` state, and that distinction is the whole bug the briefing
   * hook wrote down (useBriefingAssets.ts): a `[]`-dep cleanup closes over the FIRST
   * render's state, which is `{}`, so revoking from it revokes nothing. This scene
   * unmounts every two minutes when the VIP artwork takes the wall, and each remount
   * adopts afresh — so a leak here is not slow, it is a few hundred pinned reels a day
   * on a player that runs for weeks.
   */
  const adoptedRef = useRef<Map<string, string>>(new Map());
  /** False once this mount is gone, so an in-flight disk read cannot pin a film that
   *  the cleanup has already swept past. */
  const aliveRef = useRef(true);

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

    const now = Date.now();
    const due = toFetch.filter(
      (url) => !inFlight.has(url) && now - (attemptedAt.get(url) ?? 0) >= RETRY_FLOOR_MS,
    );

    for (const url of due) {
      // Sequential on purpose. Two large downloads racing each other on venue internet
      // both finish later than one after the other, and the first one finishing is what
      // gets the panel a film. `ensureOnce` is what makes a download outlive the mount
      // that started it, and what stops two mounts fetching the same file at once.
      if (await ensureOnce(url)) await adopt(url);
    }

    // Prune only AFTER the new files are safely down, so a replaced reel keeps playing
    // until its successor is completely on disk.
    await pruneCache(manifest, WALL_CACHE);

    async function adopt(url: string) {
      // Re-adopting would leak an object URL per poll.
      if (adoptedRef.current.has(url)) return;
      const objectUrl = await cachedObjectUrl(url, WALL_CACHE);
      if (!objectUrl) return;
      if (!aliveRef.current) {
        // The panel unmounted while the disk read was in flight. The ledger has already
        // been swept, so writing to it now would pin this reel with nothing left to
        // release it.
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* nothing to do */
        }
        return;
      }
      adoptedRef.current.set(url, objectUrl);
      setLocal((prev) => ({ ...prev, [url]: objectUrl }));
    }
  }, [enabled, manifestKey]);

  /**
   * Sync on mount, and again on a slow beat while anything is still missing.
   *
   * The interval is what makes a failure recoverable. `sync` runs once per mount, and
   * the ONLY thing that remounts this hook is the VIP artwork taking the wall — so on a
   * panel whose reel failed to download, a boot-time wifi blip would otherwise be
   * permanent for the life of the page, which is weeks. The module-level retry floor
   * keeps this cheap: a tick with everything cached does one disk read and stops.
   */
  useEffect(() => {
    void sync();
    const iv = setInterval(() => void sync(), RETRY_FLOOR_MS);
    return () => clearInterval(iv);
  }, [sync]);

  // Revoke on unmount only, FROM THE REF — see `adoptedRef`. Revoking when a URL leaves
  // the manifest would instead pull a reel out from under a panel that is mid-play.
  useEffect(() => {
    const adopted = adoptedRef.current;
    // Re-arm on (re)mount: StrictMode's dev double-mount runs this cleanup and then the
    // effect again on the same instance, and without the reset `adopt` would refuse to
    // work for the whole second life.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      for (const objectUrl of adopted.values()) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* nothing to do */
        }
      }
      adopted.clear();
    };
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
