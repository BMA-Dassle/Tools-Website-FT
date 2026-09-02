/**
 * Attract rotation — slide cadence, video/still alternation, vehicle relay.
 *
 * Pure so the rules can be pinned by tests: they are small, easy to get subtly
 * wrong, and wrong in ways nobody notices for a whole lap.
 */
import { MAX_BANK_SIZE } from "./billboard";

/** How long each attract slide holds. The CSS crossing/rumble keyframes and
 *  KIOSK_GLOW_PERIODS_MS are locked to this — change all three together. */
export const AD_ROTATE_MS = 8000;

/**
 * Fraction of the cycle the vehicle is actually on screen — the kiosk-racecar /
 * kiosk-bowlball keyframes park it offscreen until (1 − this) of the way
 * through the cycle, then run the crossing to the end.
 *
 * ONE SLOT OF THE BIGGEST BANK, not of the local one. The crossing has to fit a
 * slot on the longest row or that row cannot hand the vehicle off cleanly (see
 * vehiclePhaseMs), and sizing it per-venue would mean per-venue keyframes: the
 * crossing window is a keyframe PERCENTAGE, and so is the kiosk-ad-rumble
 * rattle tuned to sit inside it. One fraction keeps both static, and gives
 * every venue the same road speed. A shorter row simply finishes its pass and
 * rests until the next lap.
 *
 * Locked to kiosk.css like AD_ROTATE_MS — the relay tests read the stylesheet
 * and fail if the two drift apart.
 */
export const VEHICLE_CROSS_FRACTION = 1 / MAX_BANK_SIZE;

/** How long one screen's crossing lasts — the vehicle's whole visible life on
 *  this screen, and therefore the gap between neighbouring screens' starts. */
export function vehicleCrossMs(cycleMs: number = AD_ROTATE_MS): number {
  return cycleMs * VEHICLE_CROSS_FRACTION;
}

/**
 * Phase offset for THIS screen's vehicle crossing, so the bank hands the car
 * (or ball) along the row instead of every screen firing at once.
 *
 * ONE CROSSING APART, exactly. A screen begins its crossing on the same frame
 * its right-hand neighbour ends one: the vehicle's tail leaves that screen as
 * its nose enters this one, so the row only ever shows ONE car (or ball),
 * walking itself right-to-left.
 *
 * Three spreads have now been tried and the first two failed the same way —
 * they spaced the STARTS without matching the crossing's LENGTH, which is the
 * only number a handoff actually depends on:
 *  - `(position % 4) * 2000` predated FastTrax's seventh kiosk: seven screens,
 *    four phases, so 1&5, 2&6 and 3&7 fired together — "they all roll at the
 *    same time" (owner 2026-07-28).
 *  - `slot × (0.75·cycle)/(count−1)` fitted the whole relay inside one cycle,
 *    but squeezed the starts to 1000ms on seven screens against a crossing that
 *    still lasted 2000ms. Every screen lit its vehicle while its neighbour was
 *    only half-way across: two cars on the row, one lagging the other by half a
 *    screen (owner 2026-09-02, FastTrax and HeadPinz Fort Myers both: "the race
 *    car … is starting on next screen before it finishes the previous").
 *    The overlap was the crossing minus the spacing, so it scaled with the row:
 *    1000ms on FastTrax's seven, 500ms on Fort Myers' five, and none at all on
 *    Naples' four, where 6000/3 happened to land exactly on the crossing.
 *
 * So the crossing is what moved: it now lasts one slot of the longest row
 * (VEHICLE_CROSS_FRACTION) and the starts are spaced by exactly that. Seven
 * screens fill the cycle end to end; a shorter row completes its pass and the
 * whole bank rests until the next lap — a beat, not a stutter, and never two
 * vehicles at once.
 *
 * A larger phase is FURTHER ALONG the shared cycle, so it fires EARLIER
 * (syncGlowPhase seeks to `(now + phase) % period`). Position 0 is the
 * leftmost screen and gets no offset, so the rightmost fires first and the
 * wave travels right-to-left — matching the car art, which faces left.
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
  return Math.round(slot * vehicleCrossMs(cycleMs));
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
