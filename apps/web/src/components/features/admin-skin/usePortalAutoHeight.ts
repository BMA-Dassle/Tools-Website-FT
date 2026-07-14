"use client";

import { useEffect } from "react";

/** Iframe height while a modal is open: modals are position:fixed (they
 *  don't contribute to scrollHeight), so the natural height would collapse
 *  under them on short boards — post a viewport-ish box instead and let
 *  the modal fill it. The portal's <tool>-modal handler may override. */
const MODAL_HEIGHT = 940;

/**
 * Portal-embed auto-height: posts the ACTUAL content height to the parent
 * so the portal sizes the iframe to it — the embed's own body never
 * scrolls and the portal page scroll handles everything. No floor: a
 * short board posts its real ~300px and the portal shows its own
 * background below (2026-07-14 — the old 700px floor left a dead navy
 * band inside the iframe). The embed's html/body go transparent for the
 * same reason: any sizing seam shows PORTAL background, not ours.
 *
 * Message: postMessage({ type, height }) — the portal listens per tool
 * ("daily-events-resize", "bowling-resize", "e-tickets-resize",
 * "videos-resize").
 *
 * Only active when `enabled` AND actually inside an iframe, so shared
 * clients behave identically on their tokened pages. IMPORTANT: the
 * caller's root must NOT be min-height:100vh when embedded — vh feeds
 * back through the iframe height and can only ever grow.
 */
export function usePortalAutoHeight(
  type: string,
  enabled: boolean,
  modalOpen: boolean,
  onPost?: (height: number) => void,
) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || window.parent === window) return;
    const prevBodyBg = document.body.style.background;
    const prevHtmlBg = document.documentElement.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => {
      document.body.style.background = prevBodyBg;
      document.documentElement.style.background = prevHtmlBg;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || window.parent === window) return;
    const post = () => {
      const height = modalOpen ? MODAL_HEIGHT : document.documentElement.scrollHeight;
      window.parent.postMessage({ type, height }, "*");
      onPost?.(height);
    };
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onPost is a logger
  }, [type, enabled, modalOpen]);
}
