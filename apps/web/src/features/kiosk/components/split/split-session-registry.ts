/**
 * Module-level registry of the ONE in-flight kiosk money session, so every
 * exit path can release its holds without threading props through the tree.
 *
 * Why not React unmount cleanup alone: handleStartOver's kiosk-update branch
 * hard-reloads via window.location (version.ts resetToKiosk), which never runs
 * effect cleanups — the one exit KioskGiftCardFlow's unmount-abandon pattern
 * could not cover. handleStartOver calls abandonActiveSplit() explicitly
 * BEFORE navigating; the keepalive fetch survives the teardown. A pagehide
 * listener backstops tab-close/crash-adjacent exits; the server sweep is the
 * last resort behind both.
 *
 * Lifecycle: the checkout gate registers on a successful prepare, marks
 * captured the moment the payment set is captured (holds are then real money
 * — never voided from the client), and clears on a clean exit. Abandon is
 * idempotent server-side, so double-fires are harmless.
 */
import { abandonSplit } from "./client";

let active: { seed: string; splitToken: string; captured: boolean } | null = null;
let pagehideWired = false;

export function registerSplitSession(s: { seed: string; splitToken: string }): void {
  active = { ...s, captured: false };
  if (!pagehideWired && typeof window !== "undefined") {
    pagehideWired = true;
    window.addEventListener("pagehide", () => abandonActiveSplit());
  }
}

/** Capture succeeded — the holds are money now; abandon must never fire. */
export function markSplitCaptured(): void {
  if (active) active.captured = true;
}

export function clearSplitSession(): void {
  active = null;
}

/** Fire-and-forget release of every un-captured hold (keepalive fetch). */
export function abandonActiveSplit(): void {
  if (!active || active.captured) return;
  const { seed, splitToken } = active;
  active = null;
  abandonSplit({ seed, splitToken });
}
