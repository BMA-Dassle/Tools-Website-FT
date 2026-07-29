/**
 * Attract rotation — slide cadence, video/still alternation, vehicle relay.
 *
 * Pure so the rules can be pinned by tests: they are small, easy to get subtly
 * wrong, and wrong in ways nobody notices for a whole lap.
 */

/** How long each attract slide holds. The CSS crossing/rumble keyframes and
 *  KIOSK_GLOW_PERIODS_MS are locked to this — change all three together. */
export const AD_ROTATE_MS = 8000;

/**
 * Phase offset for THIS screen's vehicle crossing, so the bank hands the car
 * (or ball) along the row instead of every screen firing at once.
 *
 * Spread across the ACTUAL bank size rather than a fixed 4 slots. The old
 * `(position % 4) * 2000` predates FastTrax having seven kiosks: with 7
 * screens it hands out only 4 distinct phases, so kiosks 1&5, 2&6 and 3&7
 * crossed simultaneously — which reads as "they all roll at the same time"
 * (owner 2026-07-28). Dividing the cycle by the bank size gives every screen
 * its own slot: 7 screens → ~1143ms apart, 5 → 1600ms, 4 → 2000ms.
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
  return Math.round(slot * (cycleMs / count));
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
