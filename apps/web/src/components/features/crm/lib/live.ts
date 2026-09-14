/**
 * "Live" for a CRM screen, defined once.
 *
 * Owner, 2026-09-14: "Lead board and other pages should update live." They
 * were not wrong — a lead arrived while the queue was open and the board did
 * not move for half a minute, and the Contracts screen did not refresh at all.
 *
 * Two things were missing:
 *
 *   1. `refetchOnWindowFocus` is FALSE for the whole app
 *      (`src/context/QueryProvider.tsx`), which is right for the booking flow
 *      it was written for — an admin page refetching on every tab switch felt
 *      noisy — and wrong for a board somebody is watching. That provider's own
 *      comment says to opt in per query, so this is the CRM opting in rather
 *      than a global default being changed out from under booking.
 *   2. Several screens had no interval at all.
 *
 * `staleTime` is half the interval, so a refocus inside one tick serves cache
 * and a refocus after it refetches — the board is current without the screen
 * hammering Neon every time somebody alt-tabs.
 *
 * `refetchIntervalInBackground` stays FALSE everywhere. A hidden tab polling
 * all night is how a "live" board becomes a database bill.
 */

/** A board a person actively watches: the lead queue, the pipeline. */
export const LIVE_BOARD_MS = 15_000;
/** A working list that changes with somebody's day: contracts, my day. */
export const LIVE_LIST_MS = 30_000;
/** An open record: the deal drawer, where a stale total misleads. */
export const LIVE_RECORD_MS = 30_000;

export interface LiveOptions {
  refetchInterval: number;
  refetchIntervalInBackground: false;
  refetchOnWindowFocus: true;
  staleTime: number;
}

export function live(intervalMs: number): LiveOptions {
  return {
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: Math.floor(intervalMs / 2),
  };
}
