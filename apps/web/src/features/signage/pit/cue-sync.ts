import type { TrackKey } from "../track";

/**
 * TWO PITS PRESSED TOGETHER PLAY ONE ANNOUNCEMENT. PURE.
 *
 * THE RULE (owner 2026-09-10: "a 5 seconds cooldown that if they play pre on
 * both tracks within 5 seconds it will sync them and play both at same time.
 * Same with post, you should be able to just use the 'both' zones in that
 * case").
 *
 * The two pits share a fence. Two copies of the same announcement starting a
 * few seconds apart on adjacent speakers is an echo nobody can follow — the
 * same reason the stay-seated loop already plays every lane on one venue-wide
 * beat. So on a split night a pre (or post) press whose OTHER track is also
 * armed for the same cue WAITS up to CUE_SYNC_WINDOW_MS for that track's
 * press. If it comes, one play goes out on the `mega` zone — which IS both
 * pits' speakers — and both groups are stamped, recorded and moved exactly as
 * two separate plays would have. If it does not, the press plays on its own
 * zone as it always has, a window later.
 *
 * THE WAIT ONLY HAPPENS WHEN A SYNC IS POSSIBLE. The partner track has to be
 * armed for the same cue right now (a group staged and owing a pre; a race in
 * the pit owing a post, with its room clear). A lone armed track plays
 * instantly — the window is not a tax on every press.
 *
 * Mega days have one card and one zone: nothing to sync with.
 */

/** How long the first press holds for the second. */
export const CUE_SYNC_WINDOW_MS = 5_000;

/** How often the holding press looks for its partner. */
export const CUE_SYNC_POLL_MS = 200;

/**
 * How long the SECOND press waits for the first one's outcome: the window it
 * may still be inside, plus the play's own budget (the /play reply is held
 * ~0.6s by the Core and has an 8s ceiling). Past this the leader is presumed
 * dead and the joiner plays for itself.
 */
export const CUE_SYNC_RESULT_WAIT_MS = CUE_SYNC_WINDOW_MS + 10_000;

/** The other pit — null on Mega, which has no other pit. */
export function syncPartner(track: TrackKey): TrackKey | null {
  if (track === "blue") return "red";
  if (track === "red") return "blue";
  return null;
}

/**
 * Which zone one play should go out on for the tracks whose one-shot claims
 * succeeded: both → `mega` (both pits at once), exactly one → its own zone,
 * none → nothing to play.
 */
export function syncedZoneFor(claimed: readonly TrackKey[]): TrackKey | null {
  const set = new Set(claimed);
  if (set.has("blue") && set.has("red")) return "mega";
  if (set.size === 1) return [...set][0] ?? null;
  return null;
}
