/**
 * Race class (junior / adult) resolution for kiosk check-in assignment.
 *
 * The booking flow's rule (mirrors KioskPeopleStep): a racer is JUNIOR when age
 * < 13, else ADULT — NOT the under-18 `isMinor` line (a 13–17-year-old is adult
 * class). We resolve from the member's explicit `category` first, then compute
 * from `dobIso`; `null` when neither is known (rare — a returning racer whose
 * lookup returned no birthdate), so the caller can avoid a wrong hard-block.
 *
 * Pure (no I/O) so it runs identically on the client picker and the server
 * enforcement, and is unit-testable.
 */
export type RaceClass = "adult" | "junior";

/** Junior when strictly under this age (booking-flow rule). */
export const JUNIOR_MAX_AGE = 13;

/** Whole years from an ISO date (YYYY-MM-DD…), or null if unparseable. */
export function ageFromDobIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() < mo || (now.getMonth() === mo && now.getDate() < d)) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** The racer's class, or null when it genuinely can't be determined. */
export function resolveRaceClass(m: {
  category?: string | null;
  dobIso?: string | null;
}): RaceClass | null {
  if (m.category === "junior" || m.category === "adult") return m.category;
  const age = ageFromDobIso(m.dobIso ?? null);
  if (age === null) return null;
  return age < JUNIOR_MAX_AGE ? "junior" : "adult";
}
