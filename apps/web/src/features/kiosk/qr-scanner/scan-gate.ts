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
 * A blocked scan is not silent. Saying nothing was indistinguishable from a
 * beam that missed, so the guest scanned harder (owner 2026-09-02: "if scans
 * happen within it should do negative noise"). The one exception is the
 * reader's own echo of a code nobody moved — see `SCAN_ECHO_MS`.
 *
 * EVERY consumer must ask. A gate applied to some scan surfaces and not others
 * is worse than none: the first scan routes to a screen whose listener never
 * asked, and the second scan lands there and acts, which is exactly how this
 * read as "doesn't work". The consumers are the entry router, Game Zone, the
 * coupon screen, check-in and the split-tender gift-card listener. Two are
 * deliberately exempt: `useLicenseScan` (a licence is one ~35-line burst) and
 * `KioskAdminQrScanner` (staff testing hardware need to see every read).
 */

/** The owner asked for 3-4s; the middle of that is a burst-proof gap that
 *  still lets a guest deliberately present a second card without waiting. */
export const SCAN_COOLDOWN_MS = 3_500;

/**
 * How long after an accepted scan a REPEAT of the same payload is treated as
 * the reader's own echo rather than the guest scanning again.
 *
 * An auto-sense reader re-fires within a couple of hundred milliseconds, and
 * the routed screen change lands inside that. A person moving a card away and
 * presenting it again cannot do it in under about a second. So the window —
 * not the payload alone — is what separates them: inside it, silence; outside
 * it, the guest is deliberately scanning again and gets told to wait.
 *
 * Payload-only matching was the first attempt and it was wrong: it made every
 * re-scan of the SAME code silent for the whole 3.5s, which is precisely how
 * anyone tests this ("scan the same card twice") — so the gate read as broken
 * (owner 2026-09-02).
 */
export const SCAN_ECHO_MS = 800;

/**
 * Why a scan was refused, because the two reasons deserve different feedback.
 *
 *   ok        act on it; the gate is now shut for the cooldown
 *   repeat    the SAME payload again — an auto-sense reader looking at a code
 *             nobody moved. Drop it in SILENCE: this is not the guest scanning
 *             again, and sounding it would turn one physical scan into an
 *             accept tone followed by a reject tone (loudest right after a
 *             scan routes to a new screen, where the reader's second look
 *             lands on the freshly-mounted listener).
 *   cooldown  a DIFFERENT code inside the window — the guest really is
 *             presenting something new too soon. Sound the negative tone so
 *             they know they were heard and asked to wait (owner 2026-09-02).
 */
export type ScanGateVerdict = "ok" | "repeat" | "cooldown";

/** Timestamp (ms) before which no scan is accepted. */
let blockedUntil = 0;
/** The payload of the last ACCEPTED scan — what tells a reader's repeat read
 *  apart from a guest scanning a second code. Never logged: a scan is a bearer
 *  credential (house rule shared with wedge.ts and gift-card-qr.ts). */
let lastAccepted: string | null = null;
/** When that payload was last SEEN (accepted, or echoed since). The echo
 *  window is measured from here, not from the accept, so it SLIDES. */
let lastSeenAt = 0;

/**
 * Why a scan arriving right now would be refused. Shared by both entry points
 * so they can never disagree about what the guest should hear.
 *
 * The window slides deliberately. A guest who holds a card under the beam
 * produces an unbroken stream of the same payload with small gaps, and every
 * one of those is the same physical act — so each sighting pushes the window
 * out and the whole stream stays silent, however long they hold it. Moving the
 * card away and presenting it again leaves a gap wider than the window, which
 * is a second act and earns the negative tone. Measuring from the ACCEPT
 * instead would start buzzing at someone who simply held still.
 */
function refusalFor(payload: string | null | undefined, now: number): ScanGateVerdict {
  if (payload != null && payload === lastAccepted && now - lastSeenAt < SCAN_ECHO_MS) {
    lastSeenAt = now;
    return "repeat";
  }
  return "cooldown";
}

/**
 * Claim the gate for one scan. `ok` means the caller may act on the payload —
 * and, having said yes, the gate is immediately shut for the cooldown. Call it
 * BEFORE any await, so two bursts can never both get an `ok`.
 *
 * Pass the raw payload whenever you have it; without it a refusal cannot be
 * told apart from a reader repeat and is reported as `cooldown`.
 */
export function takeScanGate(
  payload?: string | null,
  cooldownMs: number = SCAN_COOLDOWN_MS,
  now: number = Date.now(),
): ScanGateVerdict {
  if (now < blockedUntil) return refusalFor(payload, now);
  blockedUntil = now + cooldownMs;
  lastAccepted = payload ?? null;
  lastSeenAt = now;
  return "ok";
}

/**
 * The verdict a scan WOULD get, without consuming the gate.
 *
 * For a caller that has already decided to drop this scan for its own reason
 * but still owes the guest a sound. The entry router is the case: while it is
 * routing the previous scan it refuses re-entry outright, and a card scan
 * spends two network round trips in there — so for a second or three every
 * further scan was dropped in SILENCE, before the gate was ever consulted.
 * That is most of why the cooldown looked like it did nothing on the
 * attraction screens (owner 2026-09-02).
 */
export function peekScanGate(payload?: string | null, now: number = Date.now()): ScanGateVerdict {
  return now < blockedUntil ? refusalFor(payload, now) : "ok";
}

/**
 * Close the gate without consuming a scan — for a surface that has just acted
 * on a payload it received some other way (a hand-off stashed by the previous
 * screen), so the reader's repeat read of the same card is ignored on arrival.
 *
 * Deliberately leaves `lastAccepted` alone. The screen that stashed the
 * hand-off took the gate with the RAW payload moments ago, so keeping it is
 * exactly what lets the reader's repeat read come back `repeat` (silent)
 * rather than `cooldown` (a reject tone for a card the guest scanned once).
 */
export function holdScanGate(cooldownMs: number = SCAN_COOLDOWN_MS, now: number = Date.now()) {
  blockedUntil = Math.max(blockedUntil, now + cooldownMs);
}

/** Tests only — module state does not reset between them. */
export function resetScanGate() {
  blockedUntil = 0;
  lastAccepted = null;
  lastSeenAt = 0;
}
