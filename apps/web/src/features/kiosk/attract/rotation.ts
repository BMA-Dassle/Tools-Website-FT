/**
 * Attract rotation — video/still alternation (headline layout).
 *
 * Pure so the parity rule can be pinned by tests: it is small, easy to get
 * subtly wrong, and wrong in a way nobody notices for a whole lap.
 */

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
