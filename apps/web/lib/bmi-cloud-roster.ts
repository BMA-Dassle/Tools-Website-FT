/**
 * The DECISION half of the cloud-roster guard — pure, and deliberately with NO
 * imports of its own.
 *
 * Why a module of its own rather than living next to `projectRosterCloudBarrier`
 * (which produces the set it consumes) or in `race-session-assign`: both of its
 * callers are import-sensitive. `schedule-racers.ts` is kept clear of the
 * booking service on purpose ("so the multi-writer booking service is
 * untouched"), and pulling in `bmi-sync-barriers` would drag
 * `bmi-office-actions` behind it — which broke `schedule-sweep.test.ts`, whose
 * partial `vi.mock` of that module cannot satisfy exports it never listed. A
 * leaf module with zero imports can be depended on from anywhere without moving
 * anyone's mock surface.
 *
 * Context for the guard itself (2026-08-16 WSync FK jam, T_PARTICIPANT
 * 58922217) is documented on `projectRosterCloudBarrier`.
 */

/**
 * Split racers by whether the CLOUD roster still carries them.
 *
 * A racer counts as on-roster if ANY id it carries is in the set — the same
 * human appears as a short Pandora id or a 17-digit Office id depending on which
 * rail minted them, and the roster may carry either. Matching liberally errs
 * toward scheduling, which is the safe direction: `offRoster` racers are held
 * back, and holding back a racer who should have raced is a worse failure than
 * the jam if it were ever terminal — which is why the caller must classify them
 * retryable, never failed.
 */
export function partitionByCloudRoster<T>(
  racers: readonly T[],
  roster: ReadonlySet<string>,
  idsOf: (r: T) => ReadonlyArray<string | null | undefined>,
): { onRoster: T[]; offRoster: T[] } {
  const onRoster: T[] = [];
  const offRoster: T[] = [];
  for (const r of racers) {
    const ids = idsOf(r)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.trim());
    // A racer we cannot identify at all is NOT held back: we have no evidence
    // they were removed, and inventing one would strand them.
    (ids.length === 0 || ids.some((id) => roster.has(id)) ? onRoster : offRoster).push(r);
  }
  return { onRoster, offRoster };
}
