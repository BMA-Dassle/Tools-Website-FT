/**
 * Does this racer owe a FastTrax licence?
 *
 * The licence drives TWO things that must never disagree: the $4.99 Square line
 * and which $0 BMI build product a heat books (`withLicense` — "… New Web" —
 * versus `raceOnly` — "New Web NL"), which is how BMI records the licence at
 * all. Both used to key off `isNewRacer`, a CLIENT flag set by how the person
 * was added to the roster. That let a returning racer whose annual licence had
 * LAPSED race with no licence charged and none recorded (owner 2026-08-04: "two
 * people are new racers and one isn't but it's allowing me to skip by
 * licensing").
 *
 * The signal is `licenseActive`, computed SERVER-side from the Office person's
 * memberships (a membership whose name contains "license" and whose `stops` is in
 * the future) and carried onto the party member. It is deliberately explicit
 * rather than inferred from the `memberships` string list: that list is filtered
 * to "relevant" names by several different callers, and a caller that populated
 * it narrowly would make a licensed racer look unlicensed — a surprise $4.99 at a
 * kiosk. Absent flag = nothing was verified, so we fall back to the client's
 * new-racer hint.
 *
 *   licenseActive === true  → verified licensed        → never charge
 *   licenseActive === false → verified NOT licensed    → charge (the lapsed case)
 *   undefined               → unknown                  → trust isNewRacer
 *
 * Same money-safe ladder as `personNeedsLicense` (the server-side pack-rail
 * check), expressed over session data so the estimate, the charge and the BMI
 * build product all read one source.
 */

export type LicenseState = "active" | "none" | "unknown";

export interface LicenseCandidate {
  isNewRacer?: boolean;
  /** Verified against BMI: does an UNEXPIRED licence membership exist? Set by the
   *  qualification refresh / returning-racer sign-in; undefined = never read. */
  licenseActive?: boolean;
  /** Bought + registered on the race-pack "Race today" hand-off — never charge twice. */
  licensePrepaid?: boolean;
}

/** What we actually know about this racer's licence. */
export function racerLicenseState(m: LicenseCandidate): LicenseState {
  if (m.licensePrepaid) return "active";
  if (typeof m.licenseActive !== "boolean") return "unknown";
  return m.licenseActive ? "active" : "none";
}

/**
 * Should this racer be sold (and registered for) a licence?
 *   active  → no. Never charge a racer who holds one.
 *   none    → yes. Includes the returning racer whose licence lapsed.
 *   unknown → trust the client's new-racer flag: a freshly created racer still
 *             gets licensed, and an unread returning racer isn't surprise-charged.
 *
 * Callers still apply their own scope gates (has a booked heat, not covered by a
 * package whose price includes the licence).
 */
export function racerNeedsLicense(m: LicenseCandidate): boolean {
  const state = racerLicenseState(m);
  if (state === "active") return false;
  if (state === "none") return true;
  return !!m.isNewRacer;
}

/** Racers on this party who owe a licence — display and charge read the same list. */
export function racersNeedingLicense<T extends LicenseCandidate>(party: T[]): T[] {
  return party.filter((m) => racerNeedsLicense(m));
}
