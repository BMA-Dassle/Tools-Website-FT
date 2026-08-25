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
 *
 * ── AN ID WE ALREADY HOLD ALWAYS WINS (2026-08-24) ─────────────────────────
 * The first version of this guard still minted whenever it COULD land a readable
 * record, even for a guest whose id we were already holding. That preserved the
 * original reason these rails minted at all: they were resolving a 17-digit
 * Office id into a "short" Pandora id, because waiver sign was believed to need
 * one (2026-07-18).
 *
 * That belief is now measurably false. Since the cloud-first mint went live on
 * 2026-08-12, `waiver_signatures` holds 3,198 waivers SIGNED against 17-digit
 * ids against 5 failures — and every one of those five is a person whose record
 * lives at another center, which no amount of minting here would fix. A 17-digit
 * id signs. The short-id resolution was buying nothing.
 *
 * What it COST is the duplicate loop: measured over 2026-08-12→24, 194 guests
 * ended up with more than one record, 256 records in all, and 166 waiver
 * signatures landed on a record that is not the guest's main one. The shape is
 * always the same — an adult is looked up (so we hold their id), the rail mints
 * anyway, their existing waiver is invisible on the new record, so they sign
 * again; tap the next child and it happens again. Christopher Amodeo: 6 records
 * and 3 self-signed adult waivers in 13 minutes.
 *
 * So the order is now: USE what we hold, and mint only for a guest we hold
 * nothing for. This is not a dedupe — it never searches BMI and never picks a
 * record we did not already have in hand, so the owner's rule that duplicates
 * stay VISIBLE (via `matchGateVerdict` + LicenseMatchPicker, upstream) is
 * untouched. It simply stops us creating a second record for a guest we have
 * already identified.
 */

/** BMI wants `YYYY-MM-DD`; anything else can never produce a readable record. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type MintForSigningVerdict =
  /** Mint — we hold no id for this guest, but we can land a READABLE record. */
  | { kind: "mint"; birthdate: string }
  /** Sign with the id we already hold. Minting would only add a twin. */
  | { kind: "use"; personId: string }
  /** Nothing to sign with and nothing safe to create. */
  | { kind: "blocked"; reason: "no-birthdate" | "no-identity" };

export interface MintForSigningInput {
  /**
   * The id we ALREADY hold for this guest — from an account lookup, an OTP
   * sign-in, or a mint earlier in this session. When present it wins: a
   * 17-digit Office id is accepted by the waiver rails (proved live 2026-08-19,
   * waiver 59136537 against 63000000008851591, and 3,198 times since).
   *
   * Named `fallbackId` when it was only a last resort; kept for its callers.
   */
  fallbackId?: string | null;
  /** ISO `YYYY-MM-DD`. Absent = we have no readable record to offer BMI. */
  dobIso?: string | null;
  email?: string | null;
  phone?: string | null;
}

export function mintForSigningVerdict(input: MintForSigningInput): MintForSigningVerdict {
  const held = input.fallbackId?.trim() || null;
  const hasIdentity = !!(input.email?.trim() || input.phone?.trim());
  const dob = input.dobIso?.trim() || "";

  // An id in hand always wins — see "AN ID WE ALREADY HOLD ALWAYS WINS" above.
  // This is the line that ends the duplicate loop.
  if (held) return { kind: "use", personId: held };
  if (hasIdentity && ISO_DATE.test(dob)) return { kind: "mint", birthdate: dob };
  return { kind: "blocked", reason: hasIdentity ? "no-birthdate" : "no-identity" };
}
