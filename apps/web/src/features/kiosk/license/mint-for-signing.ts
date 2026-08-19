/**
 * May we MINT a BMI person just to get an id to sign a waiver with?
 *
 * The sibling of `matchGateVerdict` (search-before-create): that one decides
 * whether a typed-in guest is somebody we already have, this one decides
 * whether a guest we are about to SIGN may have a record created for them.
 * Pure and tested — the components only map the verdict to actions.
 *
 * ── WHY A GUARD EXISTS AT ALL ──────────────────────────────────────────────
 * `pandoraCreatePerson` is a CREATE, not an upsert (see the honest-risk note in
 * lib/pandora.ts), so every call mints a record. The guardian rails call it to
 * resolve a signable id, and they were passing whatever birthdate they happened
 * to hold — which for an adult resolved by account lookup is very often NOTHING,
 * because a legacy Office record carries no birthDate.
 *
 * A BMI person with a null birthdate makes Pandora answer EVERY read of them
 * with 500 "Response Validator Error". Every consumer reads that as "no waiver",
 * so the guest cannot be scheduled — and because we then sign their waiver
 * against that very record, the signature lands somewhere nobody can read.
 * The record is born unreadable and only a human typing a DOB into BMI Office
 * can fix it (`repair-person-details` parks with exactly that sentence).
 *
 * Live on 2026-08-19: Amy Marhevka got three FM records in seven minutes — one
 * from the form path WITH a DOB, then two from the guardian rails WITHOUT one —
 * and her waiver landed on the third, so the board reported her as unwaivered
 * while BMI held a perfectly good signature. Same shape 2026-08-18 (James
 * Hortop) and 2026-08-19 11:17 (Christine Kasper).
 *
 * So: a mint with no birthdate is never a repair, it is a new casualty. When we
 * cannot mint a READABLE record we sign with the id we already hold instead —
 * the fallback `chooseGuardian` has taken in production since 2026-07-30.
 */

/** BMI wants `YYYY-MM-DD`; anything else can never produce a readable record. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type MintForSigningVerdict =
  /** Mint — we hold a dedup identity AND a birthdate, so the record lands readable. */
  | { kind: "mint"; birthdate: string }
  /** Sign with an id we already hold; minting now would only add an unreadable twin. */
  | { kind: "use"; personId: string }
  /** Nothing to sign with and nothing safe to create. */
  | { kind: "blocked"; reason: "no-birthdate" | "no-identity" };

export interface MintForSigningInput {
  /**
   * The id to sign with when we may not mint. Callers that have already
   * exhausted their own id (`guardianSignableId`) pass their last resort here —
   * a 17-digit Office id is accepted by the waiver rails (proved live
   * 2026-08-19: waiver 59136537 signed against 63000000008851591).
   */
  fallbackId?: string | null;
  /** ISO `YYYY-MM-DD`. Absent = we have no readable record to offer BMI. */
  dobIso?: string | null;
  email?: string | null;
  phone?: string | null;
}

export function mintForSigningVerdict(input: MintForSigningInput): MintForSigningVerdict {
  const fallback = input.fallbackId?.trim() || null;
  const hasIdentity = !!(input.email?.trim() || input.phone?.trim());
  const dob = input.dobIso?.trim() || "";

  if (hasIdentity && ISO_DATE.test(dob)) return { kind: "mint", birthdate: dob };
  if (fallback) return { kind: "use", personId: fallback };
  return { kind: "blocked", reason: hasIdentity ? "no-birthdate" : "no-identity" };
}
