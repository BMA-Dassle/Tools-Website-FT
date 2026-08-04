/**
 * Wire types for the kiosk license lookup — shared by the server service
 * (license-lookup.server.ts), the API route, and the client fetch. Kept free
 * of server imports so client components can use them.
 */

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
