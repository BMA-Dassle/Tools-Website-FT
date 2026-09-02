/**
 * One cooldown shared by every kiosk surface that consumes a scan.
 *
 * A hardware scanner in auto-sense mode re-reads whatever is still in front of
 * it, several times a second. The guest experience of that is a screen that
 * jumps twice, a toast that fires twice, or a card looked up again the instant
 * its result appears — and on the way IN it is worse than per-screen state can
 * fix, because the scan that routes a guest from the chooser into Game Zone
 * unmounts one listener and mounts another: the second read of the same card
 * arrives at a brand-new component with brand-new state, which happily accepts
 * it (owner ask 2026-09-02: "after any scan … delay 3-4 seconds before
 * accepting another scan").
 *
 * So the gate is MODULE-level, not per-hook: it is the kiosk's one "a scan was
 * just accepted" fact, and it outlives the component that took it.
 *
 * Deliberately NOT in `useQrScanner` / `useWedgeScan`. Those transports also
 * carry the driver's-licence read, which arrives as a ~35-line burst — one
 * `onScan` per line — and a per-line cooldown would destroy it. Framing is the
 * transport's job; "we already took one of these" is the consumer's.
 *
 * A blocked scan is dropped in silence. There is nothing useful to say: either
 * the screen just changed (its own feedback) or the guest is holding the same
 * code under the reader that we already acted on.
 */

/** The owner asked for 3-4s; the middle of that is a burst-proof gap that
 *  still lets a guest deliberately present a second card without waiting. */
export const SCAN_COOLDOWN_MS = 3_500;

/** Timestamp (ms) before which no scan is accepted. */
let blockedUntil = 0;

/**
 * Claim the gate for one scan. Returns true when the caller may act on the
 * payload — and, having said yes, immediately closes the gate for the cooldown.
 * Call it BEFORE any await, so two bursts can never both get a yes.
 */
export function takeScanGate(cooldownMs: number = SCAN_COOLDOWN_MS, now: number = Date.now()) {
  if (now < blockedUntil) return false;
  blockedUntil = now + cooldownMs;
  return true;
}

/**
 * Close the gate without consuming a scan — for a surface that has just acted
 * on a payload it received some other way (a hand-off stashed by the previous
 * screen), so the reader's repeat read of the same card is ignored on arrival.
 */
export function holdScanGate(cooldownMs: number = SCAN_COOLDOWN_MS, now: number = Date.now()) {
  blockedUntil = Math.max(blockedUntil, now + cooldownMs);
}

/** Tests only — module state does not reset between them. */
export function resetScanGate() {
  blockedUntil = 0;
}
