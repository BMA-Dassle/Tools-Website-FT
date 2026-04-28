"use client";

import { useEffect, useState } from "react";

/**
 * Chat-availability hook — used by Footer, ChatWidgetManager,
 * DesktopChatButton, and MobileBookBar to decide whether to render
 * the chat affordance.
 *
 * Two improvements vs. the prior version:
 *
 * 1. SHARED POLLER. Was a per-instance `setInterval` inside the
 *    hook — every consumer mounted spawned its own 30s timer +
 *    fetch. The e-ticket page mounts 3-4 of them simultaneously,
 *    quadrupling /api/chat-status requests for no reason. Now one
 *    module-level poller refcounts subscribers and runs a single
 *    timer regardless of how many components subscribe.
 *
 * 2. VISIBILITY-AWARE. Was firing every 30s even when the tab was
 *    hidden — long-lived background ticket pages accumulated
 *    pending fetches. Now the poller pauses on `document.hidden`
 *    and resumes (with an immediate refresh) on visibility change.
 *    Aborts in-flight fetches on hide so they don't leak.
 *
 * The exported `useChatAvailable` API is unchanged — drop-in.
 */

const POLL_INTERVAL = 30_000;

let cachedAvailable = false;
const subscribers = new Set<(v: boolean) => void>();
let timerId: ReturnType<typeof setTimeout> | null = null;
let activeController: AbortController | null = null;
let visibilityHandler: (() => void) | null = null;

function clearTimer() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
  }
}

function abortInFlight() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

async function tick() {
  if (subscribers.size === 0) return;
  if (typeof document !== "undefined" && document.hidden) return;
  abortInFlight();
  const ctrl = new AbortController();
  activeController = ctrl;
  try {
    const res = await fetch("/api/chat-status", { cache: "no-store", signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    if (res.ok) {
      const data = await res.json();
      const next = data.available === true;
      cachedAvailable = next;
      for (const fn of subscribers) fn(next);
    }
  } catch {
    /* keep last known state — silent on aborts and transient errors */
  }
  activeController = null;
  if (subscribers.size === 0) return;
  if (typeof document !== "undefined" && document.hidden) return;
  // Schedule the next tick AFTER the current one settles — no
  // overlap if /api/chat-status is slow.
  timerId = setTimeout(tick, POLL_INTERVAL);
}

function onVisibility() {
  if (typeof document === "undefined") return;
  if (document.hidden) {
    clearTimer();
    abortInFlight();
  } else {
    // Refocus → immediate refresh, then resume cadence.
    clearTimer();
    tick();
  }
}

function startPolling() {
  if (typeof document === "undefined") return;
  if (visibilityHandler) return; // already running
  visibilityHandler = onVisibility;
  document.addEventListener("visibilitychange", visibilityHandler);
  if (!document.hidden) tick();
}

function stopPolling() {
  if (typeof document === "undefined") return;
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  clearTimer();
  abortInFlight();
}

export function useChatAvailable() {
  const [available, setAvailable] = useState(cachedAvailable);

  useEffect(() => {
    subscribers.add(setAvailable);
    if (subscribers.size === 1) startPolling();
    // Sync to whatever we already cached if a sibling subscriber
    // already triggered a fetch.
    setAvailable(cachedAvailable);
    return () => {
      subscribers.delete(setAvailable);
      if (subscribers.size === 0) stopPolling();
    };
  }, []);

  return available;
}

export function openChat() {
  const el = document.querySelector("call-us-selector") as HTMLElement | null;
  if (!el) return;
  el.style.setProperty("display", "block", "important");

  // 3CX nests: call-us-selector > shadow > call-us > shadow > #wplc-chat-button
  const outerShadow = el.shadowRoot;
  if (!outerShadow) return;

  const innerEl = outerShadow.querySelector("call-us") as HTMLElement | null;
  const innerShadow = innerEl?.shadowRoot;
  if (innerShadow) {
    const btn = innerShadow.querySelector("#wplc-chat-button, button, a") as HTMLElement | null;
    if (btn) { btn.click(); return; }
  }

  // Fallback: try the outer shadow
  const btn = outerShadow.querySelector("a, button") as HTMLElement | null;
  if (btn) btn.click();
  else el.click();
}
