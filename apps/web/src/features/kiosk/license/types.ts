/**
 * Wire types for the kiosk license lookup — shared by the server service
 * (license-lookup.server.ts), the API route, and the client fetch. Kept free
 * of server imports so client components can use them.
 */

/**
 * A BMI login code as accepted from a scan or a wallet-licence barcode —
 * `person.tags[].tag` on the Office record (e.g. `mgrm2g8o42wxc`, `973273`).
 *
 * DELIBERATELY NARROW. The code is handed straight to the Office token search,
 * which will happily answer other token shapes too (`LastName M/D/YYYY` finds
 * people by name and birthday), so an unbounded value would be a person-search
 * oracle on an unauthenticated route. Alphanumeric-only also keeps out the
 * slashes and spaces that make that upstream 500 under undici.
 *
 * Length is bounded, not pinned: tags come in 6, 13 and 36-char shapes
 * (measured across 20 racers), so nothing may key off length.
 */
export const RACER_LOGIN_CODE_RE = /^[A-Za-z0-9]{6,32}$/;

/**
 * One matched account. Mirrors ReturningRacerLookup's FoundAccount (so the
 * existing AccountCard renders it structurally) plus the contact + waiver
 * status the lookup's Pandora probe already established.
 */
export interface LicenseMatch {
  personId: string;
  fullName: string;
  email: string;
  phone: string;
  loginCode: string;
  lastSeen: string;
  lastSeenAt: number;
  races: number;
  memberships: string[];
  /** Verified: an UNEXPIRED licence membership is on file (service/license.ts). */
  licenseActive?: boolean;
  birthDate: string | null;
  /** Always [] since the Office-search rewrite (latency) — the qualification
   *  refresh fills real balances at the people-step exit. */
  creditBalances: Array<{ kind: string; balance: number }>;
  /** Absent by design since the Office-search rewrite (2026-07-23): like the
   *  phone OTP sign-in, waiver status resolves right AFTER sign-in via
   *  importLinked (the roster card shows "Checking waiver…" briefly). */
  waiverValid?: boolean;
}
