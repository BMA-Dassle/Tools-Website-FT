/**
 * Alert kinds the guest never sees — ONE switch, honoured everywhere.
 *
 * YELLOW IS MUTED (owner 2026-09-05, "62 is still way too many. Let's mute
 * yellow flags from the racers view and the history for now. We'll need to work
 * on this.")
 *
 * WHY, HONESTLY: collapsing a crash into one incident took the worst heat from
 * 2,593 rows to 62, and 62 is still not a race history anyone would read. The
 * problem is not the de-duplication — that works — it is that on a Starter grid
 * a caution is not rare. Karts spin constantly, so "someone on your track spun"
 * fires dozens of times an hour and carries almost no information by the tenth
 * time a driver sees it. A flag that is always up is not a flag.
 *
 * WHAT IS NOT MUTED: the driver's OWN kart being slowed. `crash` still takes
 * their screen and still records, because that one is about them and has
 * something to do. This mute only drops the bystander yellow.
 *
 * NOTHING IS LOST FOR THE REDESIGN. The incident is still tracked in Redis and
 * the per-kart `crash` rows still land in Neon, so every caution we would have
 * raised is reconstructable from what is stored. The 598 caution rows already
 * in the table are left alone deliberately — invisible while this set holds
 * them, and there to study when we come back to it.
 *
 * TO BRING IT BACK: empty this set. Everything downstream re-reads it —
 * `ingest.server.ts` stops emitting, `standing.ts` stops surfacing anything
 * still sitting in a live feed, and `report.ts` stops rendering it.
 */
import type { AlertKind } from "./types";

export const MUTED_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>(["caution"]);

export function isMuted(kind: AlertKind | string): boolean {
  return MUTED_KINDS.has(kind as AlertKind);
}
