"use client";

import { useEffect } from "react";

/** Iframe floor — short content (a two-event day) must not collapse the
 *  portal iframe into a sliver (owner 2026-07-13). */
const MIN_HEIGHT = 700;
/** Viewport-ish cap while a modal is open — a full-height modal floating in
 *  a 2500px-tall iframe is unusable; the natural height re-posts on close. */
const MODAL_CAP = 940;

/**
 * Portal-embed auto-height: posts the content height to the parent so the
 * portal sizes the iframe to it — the embed's own body never scrolls and
 * the portal page scroll handles everything (no more double scrollbars
 * when a day carries lots of events).
 *
 * Message: postMessage({ type, height }) — the portal listens per tool
 * ("daily-events-resize", "bowling-resize", "e-tickets-resize",
 * "videos-resize").
 *
 * Only active when `enabled` AND actually inside an iframe, so shared
 * clients behave identically on their tokened pages. IMPORTANT: the
 * caller's root must NOT be min-height:100vh when embedded — vh feeds back
 * through the iframe height and can only ever grow; use the MIN_HEIGHT
 * floor here instead.
 */
export function usePortalAutoHeight(type: string, enabled: boolean, modalOpen: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || window.parent === window) return;
    const post = () => {
      const natural = Math.max(document.documentElement.scrollHeight, MIN_HEIGHT);
      const height = modalOpen ? Math.min(natural, MODAL_CAP) : natural;
      window.parent.postMessage({ type, height }, "*");
    };
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [type, enabled, modalOpen]);
}
