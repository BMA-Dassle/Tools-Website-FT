"use client";

/**
 * Keep this player's copy of the briefing films up to date, and hand the scene a
 * URL it can play.
 *
 * THE CONTRACT WITH THE SCENE: `srcFor(tier)` always returns something playable
 * the moment a briefing starts. If the film is on disk it is a local object URL
 * and playback is instant with no network at all; if it is not, it is the blob
 * URL and Edge streams it while the download continues in the background. That
 * ordering is deliberate — a cold cache must never be the reason a room full of
 * people waits.
 *
 * BACKGROUND DOWNLOAD, THEN SWAP. A new upload is a new URL (uploads carry a
 * random suffix), so a changed film is simply a URL we have not cached. The old
 * one keeps serving until the new one is completely on disk — `cache.put()`
 * rejects on a mid-stream failure, so there is no partial state to guard against
 * — and only then is it pruned.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cachedObjectUrl,
  cachedUrls,
  ensureCached,
  planCacheOps,
  pruneCache,
  requestPersistence,
} from "../video-cache";
import type { BriefingTier } from "./types";
import type { TvFeed } from "../types";

/** Re-check after a failed download. Long enough not to hammer venue internet
 *  while a briefing is playing, short enough to recover within a heat. */
const RETRY_FLOOR_MS = 60_000;

export interface BriefingAssetSources {
  /** A playable URL for this tier's film, or null when nothing is uploaded. */
  srcFor: (tier: BriefingTier) => string | null;
  /** True when that URL is a local cache copy rather than a network stream. */
  isLocal: (tier: BriefingTier) => boolean;
  /** The helmet poster, cached the same way (it is small — this is free). */
  posterSrc: string | null;
  /** For the ?debug=1 overlay. */
  status: { cachedCount: number; pending: number };
}

export function useBriefingAssets(
  briefing: TvFeed["briefing"],
  enabled: boolean,
  /**
   * PAUSE THE PREFETCH WHILE A FILM IS PLAYING.
   *
   * The bug this exists for: the prefetch pulled the whole 218 MB film at the very
   * moment the <video> element was streaming THAT SAME FILE, and on venue internet
   * the download starved the player — 55 seconds of saturated link, no frame ever
   * decoded, and the scene gave up and fell back to the helmet board. From a HAR:
   * a 200 for the full file taking 55.7s alongside the element's own 206 range
   * requests (owner 2026-08-11: "briefing starting then it blacks out", and the
   * same URL playing perfectly on its own).
   *
   * A room is idle far more of the time than it is playing, so caching loses
   * nothing by waiting — and playback is the thing with people watching it.
   */
  paused = false,
): BriefingAssetSources {
  // url → object URL, for everything we have confirmed on disk.
  const [local, setLocal] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(0);
  // url → last attempt, so a failing download backs off instead of retrying on
  // every 15-second poll.
  const attemptedAt = useRef<Record<string, number>>({});
  // url → object URL for everything we created: the dedupe AND the revoke
  // ledger, in one place. A blob URL left un-revoked pins its whole file in
  // memory, and this page runs for weeks. A ref, deliberately — the unmount
  // cleanup must see what was ACTUALLY adopted, not a state snapshot captured
  // on the first render (the old Set+state pair revoked nothing, ever: the
  // []-dep cleanup closed over the initial empty map).
  const adoptedRef = useRef<Map<string, string>>(new Map());
  // False from the unmount cleanup onward, so an adopt() whose disk read
  // resolves AFTER unmount revokes its freshly-minted URL instead of writing
  // it into a ledger the cleanup has already emptied — where nothing would
  // ever revoke it.
  const aliveRef = useRef(true);
  /** The in-flight prefetch, so it can be cut off the moment a film plays. */
  const abortRef = useRef<AbortController | null>(null);

  const starterUrl = briefing?.videos.starter?.url ?? null;
  const intermediateUrl = briefing?.videos.intermediate?.url ?? null;
  const proUrl = briefing?.videos.pro?.url ?? null;
  const posterUrl = briefing?.helmetPosterUrl ?? null;

  // Primitive dependency rather than the object: the feed is a new object every
  // poll, and depending on it would restart the sync every 15 seconds.
  const manifestKey = `${starterUrl ?? ""}|${intermediateUrl ?? ""}|${proUrl ?? ""}|${posterUrl ?? ""}`;

  const sync = useCallback(async () => {
    if (!enabled) return;
    const manifest = [starterUrl, intermediateUrl, proUrl, posterUrl];
    if (manifest.every((u) => !u)) return;

    await requestPersistence();

    const { fetch: toFetch } = planCacheOps(await cachedUrls(), manifest);

    // ADOPTION ALWAYS RUNS, paused or not — it is a disk read, not a download.
    // Gating it behind `paused` meant a page that booted while a briefing was
    // already running (a self-update mid-film, exactly when reloads resume)
    // never looked in its own cache: srcFor handed back the network URL and the
    // player streamed 220 MB over venue wifi while the same bytes sat on disk.
    for (const url of manifest) {
      if (!url || toFetch.includes(url)) continue;
      await adopt(url);
    }

    // DOWNLOADS pause while a room is playing or about to play — see `paused`.
    if (paused) return;
    // One controller per run, so the effect below can cut a download off the
    // instant a film starts.
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const now = Date.now();
    const due = toFetch.filter((url) => {
      const last = attemptedAt.current[url] ?? 0;
      return now - last >= RETRY_FLOOR_MS;
    });

    if (due.length > 0) {
      setPending(due.length);
      for (const url of due) {
        attemptedAt.current[url] = Date.now();
        // Sequential on purpose. Two hundred-megabyte downloads racing each
        // other on venue internet finish later than one after the other, and
        // the first one finishing is what gets a room its video.
        if (controller.signal.aborted) break;
        if (await ensureCached(url, controller.signal)) await adopt(url);
        setPending((n) => Math.max(0, n - 1));
      }
    }

    // Prune only AFTER the new files are safely down — see the header.
    await pruneCache(manifest);

    // RELEASE SUPERSEDED OBJECT URLS — but only here, on an idle sync. This
    // line is unreachable while `paused` (the return above), so a URL a playing
    // briefing holds is never pulled out from under it; a re-upload mid-film
    // keeps the old blob alive until the room goes idle, and the next idle poll
    // releases it. Same planCacheOps policy that prunes the disk cache.
    const { drop } = planCacheOps(Array.from(adoptedRef.current.keys()), manifest);
    if (drop.length > 0) {
      for (const url of drop) {
        const objectUrl = adoptedRef.current.get(url);
        adoptedRef.current.delete(url);
        if (!objectUrl) continue;
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* nothing to do */
        }
      }
      setLocal((prev) => {
        const next = { ...prev };
        for (const url of drop) delete next[url];
        return next;
      });
    }

    async function adopt(url: string) {
      // Already adopted this exact URL — nothing to do, and re-adopting would
      // leak an object URL per poll.
      if (adoptedRef.current.has(url)) return;
      const objectUrl = await cachedObjectUrl(url);
      if (!objectUrl) return;
      if (!aliveRef.current) {
        // The screen unmounted while the disk read was in flight. The ledger
        // has already been swept — writing to it now would pin this film with
        // nothing left to release it.
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
  }, [enabled, paused, starterUrl, intermediateUrl, proUrl, posterUrl]);

  useEffect(() => {
    void sync();
  }, [sync, manifestKey]);

  /**
   * CUT OFF AN IN-FLIGHT DOWNLOAD WHEN A FILM STARTS.
   *
   * Pausing `sync` only stopped NEW downloads. A prefetch begun while the room was
   * holding its take-a-seat board carried straight on into playback and fought the
   * player for the link — the same starvation that blacked a room out, just with a
   * different trigger. Aborting mid-body loses nothing: cache.put() only ever
   * commits a complete response, so there is no partial entry to clean up, and the
   * next idle poll starts it again.
   */
  useEffect(() => {
    if (paused) abortRef.current?.abort();
  }, [paused]);

  // Nothing half-downloaded should outlive the screen either.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Revoke everything on unmount — from the REF, which is the live ledger of
  // what this mount actually adopted. (Reading state here was the leak: the
  // []-dep cleanup captured the first render's empty map and revoked nothing,
  // so every film this page ever adopted stayed pinned for the life of the
  // tab — and every scene remount adopted, and pinned, a fresh set.)
  useEffect(() => {
    const adopted = adoptedRef.current;
    // Re-arm on (re)mount — StrictMode's dev double-mount runs this cleanup
    // and then the effect again on the same instance; without the reset,
    // adopt() would refuse to work for the whole second life.
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

  return useMemo(() => {
    const urlFor = (tier: BriefingTier) =>
      tier === "starter" ? starterUrl : tier === "pro" ? proUrl : intermediateUrl;
    return {
      srcFor: (tier: BriefingTier) => {
        const url = urlFor(tier);
        if (!url) return null;
        // Local copy first; otherwise stream from the store while it downloads.
        return local[url] ?? url;
      },
      isLocal: (tier: BriefingTier) => {
        const url = urlFor(tier);
        return !!url && !!local[url];
      },
      posterSrc: posterUrl ? (local[posterUrl] ?? posterUrl) : null,
      status: { cachedCount: Object.keys(local).length, pending },
    };
  }, [local, pending, starterUrl, intermediateUrl, proUrl, posterUrl]);
}
