"use client";

/**
 * Briefing videos on the player's own disk — the Cache Storage API, deliberately.
 *
 * WHY NOT THE ORDINARY HTTP CACHE. We already learned this the expensive way on
 * the kiosks (features/kiosk/assets.ts:105): Chromium caps a single HTTP cache
 * entry at roughly an eighth of the disk cache — about 30-40 MB on these
 * machines — and anything larger is evicted the moment it lands. Every attract
 * loop re-downloaded its clip. A briefing video is hundreds of megabytes, so the
 * HTTP cache would never hold one, and a room full of people would watch a
 * progress spinner on venue internet.
 *
 * Cache Storage has no per-entry ceiling. It draws on the origin's storage quota
 * (Chromium offers up to ~60% of free disk), survives the player's relaunch loop
 * because the .bat runs a persistent --user-data-dir profile, and — the part that
 * matters most — `cache.put()` REJECTS if the body fails mid-stream. A half-
 * downloaded film can therefore never become a cache entry, which is what makes
 * the swap safe: the old video keeps playing until the new one is completely
 * there.
 *
 * NOTHING HERE THROWS. Every export resolves. A player with storage disabled, a
 * quota refusal, a flaky download — all of them degrade to "stream from the blob
 * URL instead", which is slower but correct. A briefing must never be blocked by
 * a cache.
 */

/**
 * WHICH STORE. Named per FEATURE, not shared, and that is load-bearing rather
 * than tidy: `pruneCache` drops everything the caller's manifest does not
 * mention, so two features sharing one store would delete each other's films on
 * alternate polls. The briefing rooms and the arena boards run on different
 * machines in different buildings today — this makes it safe if they ever do
 * not.
 */
export const BRIEFING_CACHE = "briefing-videos-v1";
export const ARENA_CACHE = "arena-videos-v1";

/** Default for every existing caller, so the briefing path is byte-identical. */
const CACHE_NAME = BRIEFING_CACHE;

/** Cache Storage is unavailable on insecure origins and in some locked-down
 *  profiles. Feature-detected rather than assumed, because the failure mode is
 *  a wall, not a developer's console. */
function cacheSupported(): boolean {
  return typeof window !== "undefined" && typeof caches !== "undefined";
}

async function openCache(cacheName: string = CACHE_NAME): Promise<Cache | null> {
  if (!cacheSupported()) return null;
  try {
    return await caches.open(cacheName);
  } catch {
    return null;
  }
}

/**
 * Ask the browser not to evict us.
 *
 * Best-effort by design: `persist()` can return false without user engagement,
 * and that is fine — an evicted video simply re-downloads on the next feed poll.
 * Called once per player boot.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Rough disk picture, for the on-screen diagnostics. Null when unavailable. */
export async function storageEstimate(): Promise<{ usageMb: number; quotaMb: number } | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    if (usage == null || quota == null) return null;
    return { usageMb: Math.round(usage / 1_048_576), quotaMb: Math.round(quota / 1_048_576) };
  } catch {
    return null;
  }
}

/** Is this URL already on disk, complete? */
export async function isCached(url: string, cacheName?: string): Promise<boolean> {
  const cache = await openCache(cacheName);
  if (!cache) return false;
  try {
    return !!(await cache.match(url));
  } catch {
    return false;
  }
}

/**
 * Download a URL into the cache if it is not already there.
 *
 * Returns true when the file is on disk afterwards. The `put` is the whole trick:
 * it consumes the response body, and if the connection drops partway it throws
 * and writes NOTHING — so there is no such thing as a partially cached video that
 * could be played. That is why the caller can treat "cached" as "safe to play
 * from disk" with no further checks.
 */
export async function ensureCached(
  url: string,
  signal?: AbortSignal,
  cacheName?: string,
): Promise<boolean> {
  const cache = await openCache(cacheName);
  if (!cache) return false;
  try {
    if (await cache.match(url)) return true;
    // `cache.add()` would be shorter but gives no control over the request, and
    // we want an explicit cors fetch so a redirect or an error page can be
    // rejected before it is stored.
    //
    // THE SIGNAL IS LOAD-BEARING, not tidiness. These files are hundreds of
    // megabytes and a download in flight when a briefing starts will fight the
    // player for the link — which is exactly what blacked a room out before.
    // Declining to START a new download was not enough; an existing one has to be
    // cut off.
    const res = await fetch(url, { cache: "no-store", mode: "cors", credentials: "omit", signal });
    if (!res.ok) return false;
    await cache.put(url, res);
    return true;
  } catch {
    // Aborted, out of quota, offline mid-download, or the tab went away. Nothing
    // was stored — cache.put() only commits a complete body — so the next poll
    // simply tries again.
    return false;
  }
}

/**
 * RE-TYPE A VIDEO BLOB AS video/mp4 before handing it to <video>.
 *
 * A cached Response keeps the store's Content-Type, and an object URL inherits
 * it from the Blob — so a film stored as `video/quicktime` stayed unplayable
 * even from cache, because Chromium refuses that MIME type as media (owner
 * 2026-08-11: a .mov briefing film played black). The bytes are H.264 in an ISO
 * base-media container, which the MP4 demuxer reads happily once asked.
 *
 * Belt-and-braces with the upload-side contentType: this also rescues anything
 * already sitting in a player's cache from before that fix.
 *
 * `slice()` rather than `new Blob([blob])`: the constructor MATERIALIZES a full
 * copy of the bytes — a second few-hundred-MB buffer per film, resident in the
 * renderer's blob store — where slice returns a typed VIEW of the same backing
 * bytes. Same MIME rescue, no copy.
 */
export function retypeForPlayback(blob: Blob): Blob {
  return blob.type && blob.type !== "video/mp4" && blob.type.startsWith("video/")
    ? blob.slice(0, blob.size, "video/mp4")
    : blob;
}

/**
 * A playable local URL for a cached video, or null if it is not cached.
 *
 * The caller OWNS the returned object URL and must revoke it on unmount —
 * an un-revoked blob URL pins the whole file in memory, and this page runs for
 * weeks at a time.
 */
export async function cachedObjectUrl(url: string, cacheName?: string): Promise<string | null> {
  const cache = await openCache(cacheName);
  if (!cache) return null;
  try {
    const hit = await cache.match(url);
    if (!hit) return null;
    return URL.createObjectURL(retypeForPlayback(await hit.blob()));
  } catch {
    return null;
  }
}

/**
 * Which cached entries to drop and which URLs still need fetching. PURE, so the
 * interesting half of the cache policy is testable without a browser.
 *
 * Everything not in the manifest goes: superseded videos are the bulk of what
 * accumulates here, and each is hundreds of megabytes. Keeping "just in case"
 * would fill a player's disk over a season of re-uploads.
 */
export function planCacheOps(
  cachedUrls: readonly string[],
  manifestUrls: readonly (string | null | undefined)[],
): { fetch: string[]; drop: string[] } {
  const wanted = new Set(manifestUrls.filter((u): u is string => typeof u === "string" && !!u));
  const have = new Set(cachedUrls);
  return {
    fetch: Array.from(wanted).filter((u) => !have.has(u)),
    drop: Array.from(have).filter((u) => !wanted.has(u)),
  };
}

/** Every URL currently held in the named cache (the briefing store by default). */
export async function cachedUrls(cacheName?: string): Promise<string[]> {
  const cache = await openCache(cacheName);
  if (!cache) return [];
  try {
    return (await cache.keys()).map((req) => req.url);
  } catch {
    return [];
  }
}

/** Drop entries the manifest no longer references. */
export async function pruneCache(
  keepUrls: readonly (string | null | undefined)[],
  cacheName?: string,
): Promise<number> {
  const cache = await openCache(cacheName);
  if (!cache) return 0;
  try {
    const { drop } = planCacheOps(await cachedUrls(cacheName), keepUrls);
    let removed = 0;
    for (const url of drop) {
      if (await cache.delete(url)) removed += 1;
    }
    return removed;
  } catch {
    return 0;
  }
}
