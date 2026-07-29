"use client";

import { useEffect, useState } from "react";

const MAX_RETRIES = 6; // per burst; a burst also restarts on reconnect/refocus
const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 15_000;

/**
 * Resilient remote-image loader for kiosk photos.
 *
 * The kiosk runs unattended for hours on flaky venue WiFi, and tile photos are
 * painted as CSS background-images (see `.k-ph` in app/kiosk/kiosk.css). A CSS
 * background has NO error event and NO retry: once the browser's first fetch of
 * a URL fails it caches that failure and never re-requests the byte-identical
 * URL, so the tile stays blank until a full page reload. (Owner report
 * 2026-07-23: "the photos of the buttons never reload after failing to load the
 * first time.") Plain `<img>` tiles here have the same problem — no onError.
 *
 * This engine preloads each source with an off-DOM `Image()`. On failure it
 * retries with exponential backoff AND an ever-incrementing cache-busting query
 * param, so every retry is a fresh request the browser can't satisfy from its
 * cached failure. When a load finally succeeds the resolved URL changes (new
 * `?rl=` value) — feeding that back into `--k-img` / `<img src>` forces the
 * background/element to re-fetch and the tile self-heals with NO page reload.
 *
 * A burst gives up after MAX_RETRIES, but `online` and `visibilitychange`
 * (tab back to visible) each kick off a fresh burst with a new cache-bust, so a
 * photo that never made it in during an outage still recovers once the network
 * or the tab comes back.
 *
 * Sources resolve OPTIMISTICALLY to their original URL, so a healthy image
 * paints immediately with no flash; the value only diverges once a retry had to
 * cache-bust to succeed. Falsy sources pass through unchanged.
 */
function bust(src: string, n: number): string {
  if (n === 0) return src; // first attempt uses the clean canonical URL
  return `${src}${src.includes("?") ? "&" : "?"}rl=${n}`;
}

/**
 * Heal a set of image URLs at once. Returns a resolver `(src) => healedSrc` for
 * call sites that can't call a hook per image (lists rendered via a render
 * closure rather than a child component, e.g. KioskBowlingOfferStep's `hero`).
 * The resolver returns the original `src` until/unless a cache-busted retry
 * succeeds for it.
 */
export function useResilientImages(
  srcs: ReadonlyArray<string | undefined>,
): (src: string | undefined) => string | undefined {
  // Map of original src -> currently-good URL (may carry a cache-bust suffix).
  const [resolved, setResolved] = useState<Record<string, string>>({});
  // Stable key so the effect only re-runs when the DISTINCT source set changes,
  // not on every render (srcs is a fresh array literal each time).
  const key = Array.from(new Set(srcs.filter((s): s is string => !!s)))
    .sort()
    .join("\n");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const unique = key ? key.split("\n") : [];
    if (unique.length === 0) return;

    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    // Per-src bookkeeping: whether it has loaded, its next cache-bust counter,
    // and its consecutive-failure count (drives the backoff delay).
    const state = new Map(unique.map((s) => [s, { done: false, n: 0, fails: 0 }]));

    const load = (src: string) => {
      const st = state.get(src);
      if (cancelled || !st || st.done) return;
      const url = bust(src, st.n);
      const img = new Image();
      img.onload = () => {
        if (cancelled || st.done) return;
        st.done = true;
        setResolved((prev) => (prev[src] === url ? prev : { ...prev, [src]: url }));
      };
      img.onerror = () => {
        if (cancelled || st.done || st.fails >= MAX_RETRIES) return;
        st.fails += 1;
        st.n += 1;
        const delay = Math.min(BASE_DELAY_MS * 2 ** (st.fails - 1), MAX_DELAY_MS);
        const t = setTimeout(() => load(src), delay);
        timers.add(t);
      };
      img.src = url;
    };

    // A load may have exhausted its burst while the network was down. Give every
    // not-yet-loaded src a fresh burst (new cache-bust) on reconnect / refocus.
    const revive = () => {
      if (cancelled) return;
      for (const [src, st] of state) {
        if (st.done) continue;
        st.fails = 0;
        st.n += 1; // never reuse a URL the browser already failed on
        load(src);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") revive();
    };

    for (const src of unique) load(src);
    window.addEventListener("online", revive);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      window.removeEventListener("online", revive);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);

  // Close over the latest resolved map — the component re-renders whenever a
  // photo heals, so each render hands back a resolver reading fresh values.
  return (src) => (src ? (resolved[src] ?? src) : src);
}

/**
 * Single-image variant for component instances (each kiosk tile is its own
 * component, so this is safe inside a mapped list). Returns `src` optimistically
 * and swaps to a healed URL if a retry had to cache-bust to succeed.
 */
export function useResilientImage(src: string | undefined): string | undefined {
  const resolve = useResilientImages(src ? [src] : []);
  return resolve(src);
}
