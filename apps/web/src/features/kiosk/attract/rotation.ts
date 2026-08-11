/**
 * Attract rotation — slide cadence, video/still alternation, vehicle relay.
 *
 * Pure so the rules can be pinned by tests: they are small, easy to get subtly
 * wrong, and wrong in ways nobody notices for a whole lap.
 */

/** How long each attract slide holds. The CSS crossing/rumble keyframes and
 *  KIOSK_GLOW_PERIODS_MS are locked to this — change all three together. */
export const AD_ROTATE_MS = 8000;

/** Fraction of the cycle the vehicle is actually on screen — the
 *  kiosk-racecar / kiosk-bowlball keyframes run the crossing over the LAST
 *  quarter (75% → 100%) of the cycle. Locked to kiosk.css like AD_ROTATE_MS. */
export const VEHICLE_CROSS_FRACTION = 0.25;

/**
 * Phase offset for THIS screen's vehicle crossing, so the bank hands the car
 * (or ball) along the row instead of every screen firing at once.
 *
 * Spread across the ACTUAL bank size rather than a fixed 4 slots. The old
 * `(position % 4) * 2000` predates FastTrax having seven kiosks: with 7
 * screens it hands out only 4 distinct phases, so kiosks 1&5, 2&6 and 3&7
 * crossed simultaneously — which reads as "they all roll at the same time"
 * (owner 2026-07-28).
 *
 * The relay must also FIT the cycle. Starts are spread across the cycle MINUS
 * the crossing itself — `slot × (0.75·cycle)/(count−1)` — so the leftmost
 * screen's crossing ends exactly at the cycle boundary, right as the
 * rightmost begins its next lap. The earlier `slot × cycle/count` spread
 * overshot on any bank bigger than four: FastTrax's seventh screen was still
 * mid-crossing 857ms into the next lap, so two vehicles were on the row at
 * once (owner 2026-08-10: "starting before it ends on the last kiosk").
 * 7 screens → 1000ms apart, 5 → 1500ms, 4 → 2000ms.
 *
 * A larger phase is FURTHER ALONG the shared cycle, so it fires EARLIER
 * (syncGlowPhase seeks to `(now + phase) % period`). Position 0 is the
 * leftmost screen and gets no offset, so the rightmost fires first and the
 * wave travels right-to-left — matching the car art, which faces left.
 *
 * The crossing lasts a quarter of the cycle (2s of 8s), which is longer than
 * one slot on a big bank, so neighbouring screens overlap slightly. That is
 * deliberate: an overlap reads as one vehicle travelling the row, where a gap
 * reads as separate screens taking turns.
 *
 * `position` is the PHYSICAL bank index (HPFM stands 3·2·6·1·4, so kiosk
 * number is not position). null = this kiosk is not in the bank map; it falls
 * back to its number so it still animates, just outside the choreography.
 */
export function vehiclePhaseMs(
  position: number | null,
  bankCount: number,
  kioskNumber: number,
  cycleMs: number = AD_ROTATE_MS,
): number {
  const count = Math.max(1, bankCount);
  const raw = position ?? kioskNumber - 1;
  const slot = (((raw % count) + count) % count) | 0; // negatives → in range
  if (count === 1) return 0;
  const spreadMs = cycleMs * (1 - VEHICLE_CROSS_FRACTION);
  return Math.round(slot * (spreadMs / (count - 1)));
}

/**
 * Does the slide at `index` run its clip on lap `cycle`?
 *
 * Four clips back-to-back was too much motion (owner 2026-07-28), so a slide
 * alternates: video one time round, its still photo the next.
 *
 * Parity is (cycle + index), and both terms are load-bearing:
 *  - cycle alone, with an EVEN slide count, freezes every activity on one side
 *    forever — bowling always video, gel always still.
 *  - index alone never changes at all, lap to lap.
 * Summing them gives both properties at once: no two consecutive slides move,
 * and every activity flips each lap.
 *
 * `cycle` is derived from the shared wall clock, so the whole bank agrees on
 * which slides are moving at any instant.
 */
export function slidePlaysVideo(cycle: number, index: number, hasVideo: boolean): boolean {
  if (!hasVideo) return false;
  // Guard negatives: JS % keeps the sign, and a clock offset can make the
  // derived cycle negative right after boot on a badly-set device clock.
  return (((cycle + index) % 2) + 2) % 2 === 0;
}
