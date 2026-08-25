/**
 * Has this followup's MOMENT passed?
 *
 * The queue's two endings used to be "it landed" and "we gave up, a human is
 * needed". Some work has a third: it stopped mattering. A check-in stamp is only
 * meaningful while the party is here — once their last heat has run, landing it
 * claims something about a shift that is over.
 *
 * Keeping that as a park was expensive in the only currency an operations board
 * has: 16 of the 57 stamp rows since 2026-08-16 parked as "needs a human" when
 * every one of those parties had raced — they were simply moved to another heat,
 * or had raced under a duplicate person record. More than one check-in in four.
 * A board that cries wolf that often is a board staff learn to close.
 *
 * Pure and tested, deliberately: the rails just apply the verdict. `now` is a
 * parameter so a test can put the clock anywhere without freezing global time.
 */
import type { SyncQueueRow } from "@/lib/bmi-sync-queue";

/**
 * Grace after the last bound heat before a stamp is written off.
 *
 * An hour is comfortably longer than any single heat plus its podium and photos,
 * so a racer seated late still gets the stamp; and it is short enough that the
 * row closes on the same shift that created it, which is the point.
 */
export const STAMP_LAPSE_GRACE_MIN = 60;

/**
 * A naive center-local `YYYY-MM-DDTHH:MM[:SS]` as a real instant.
 *
 * Read the naive string as if it were UTC, ask what wall clock Eastern shows at
 * that instant, and add back the gap. The offset is looked up FOR THAT DATE, so
 * March and November are right — a hardcoded -4/-5 is wrong for half the year,
 * and this repo has already paid for a timezone shortcut more than once.
 *
 * The `sv-SE` locale is used because it formats as `YYYY-MM-DD HH:MM:SS`, which
 * is parseable; `en-US` gives `8/23/2026, 3:12:00 PM`, and feeding THAT back to
 * `new Date()` parses it in the machine's own zone, which silently yields a zero
 * offset on a machine that happens to be in Eastern. (It did: this function's
 * first version, caught by the test below reporting a heat 8h ago instead of 4h.)
 */
function nyNaiveToUtcMs(naive: string): number | null {
  const asUtc = Date.parse(`${naive.slice(0, 19)}Z`);
  if (!Number.isFinite(asUtc)) return null;
  const shownInEt = new Date(asUtc)
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(" ", "T");
  const shownAsUtc = Date.parse(`${shownInEt}Z`);
  if (!Number.isFinite(shownAsUtc)) return null;
  // Eastern is behind UTC, so the clock it shows is earlier; that gap IS the offset.
  return asUtc + (asUtc - shownAsUtc);
}

/**
 * The last heat this check-in bound, as epoch ms — or null when the row names no
 * heats at all (bowling-only, or a payload from before seats existed).
 */
export function lastHeatMs(row: SyncQueueRow): number | null {
  const seats = Array.isArray(row.payload.seats) ? (row.payload.seats as unknown[]) : [];
  let latest: number | null = null;
  for (const s of seats) {
    const heatStart = (s as { heatStart?: unknown })?.heatStart;
    if (typeof heatStart !== "string") continue;
    const ms = nyNaiveToUtcMs(heatStart);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/**
 * Should this row be written off rather than kept waiting?
 *
 * Only `stamp-confirmation-state` can lapse today. Everything else in the queue
 * is still worth landing whenever it lands — a waiver, a licence, a repaired
 * birthdate are all as valuable tomorrow as now, and quietly writing one of
 * those off would lose real guest work.
 *
 * Returns the operator-facing reason, or null to keep waiting.
 */
export function lapseVerdict(row: SyncQueueRow, now = Date.now()): string | null {
  if (row.kind !== "stamp-confirmation-state") return null;
  if (row.status !== "pending") return null;

  const last = lastHeatMs(row);
  // No heats named = nothing that can expire. Such a row is gated on the party
  // being ready, not on a moment, so let it run its normal course.
  if (last === null) return null;

  const deadline = last + STAMP_LAPSE_GRACE_MIN * 60_000;
  if (now < deadline) return null;

  const hrs = Math.round((now - last) / 3_600_000);
  return (
    `last heat was ${hrs}h ago — the check-in stamp has nothing left to say, ` +
    `so it was written off rather than left as a job for someone`
  );
}
