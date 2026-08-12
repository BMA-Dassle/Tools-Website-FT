/**
 * Pandora MEMBERSHIP helpers — the license twin of pandora-deposits.ts.
 *
 * Race-pack credits load via Pandora `addDeposit` (POST /v2/bmi/deposit) with NO
 * BMI cloud bill. A standalone FastTrax LICENSE gets the same treatment: write the
 * "License Fee" membership straight into Firebird via Pandora so the racer is
 * licensed — no BMI booking/sell → payment/confirm dance (which we proved leaves an
 * unpaid bill and attaches NO membership; GET /membership is empty for FastTrax).
 *
 * Endpoint (verified live 2026-07-25):
 *   POST /v2/bmi/membership
 *        { locationID, personID, membershipKindID, activates?, expires }
 *        → { success, data: { action, linkID, membershipKindID, activates, expires } }
 *
 * There is NO Pandora membership-READ endpoint (owner: Pandora won't add one) —
 * reads go through the BMI Office record (fetchPersonRaw), which shows the granted
 * membership. So this module is WRITE-only.
 *
 * IMPORTANT: Pandora does NOT default `expires` (owner 2026-07-25) — the caller
 * MUST send it. `activates` defaults to now on Pandora's side.
 *
 * Auth: SWAGGER_ADMIN_KEY (same key pandora-deposits.ts uses).
 */

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

/** Firebird membership-kind id (F_MSK_ID) for the FastTrax racing license — the
 *  "License Fee" membership (owner 2026-07-25, read off a licensed account). NOTE:
 *  the Firebird kind id (11260957) differs from the BMI-side kind=3 product id
 *  (11253570). Env-overridable. Confirm with the live diag smoke. */
export const LICENSE_MEMBERSHIP_KIND_ID = process.env.RACE_LICENSE_MEMBERSHIP_KIND_ID || "11260957";

/**
 * "Customer Registration" — the DEFAULT REGISTRATION every guest should carry,
 * and what the sync queue grants.
 *
 * Owner 2026-08-12: "We need to use default registration for everyone, not
 * license. License is taken care of with the BMI product." So we must NOT grant
 * LICENSE_MEMBERSHIP_KIND_ID ourselves — a purchased licence arrives with the
 * BMI product, and granting it here would entitle someone who may not have paid.
 *
 * ⚠️ MEMBERSHIP KIND IDS ARE CLIENT-KEY SCOPED. There is no global catalogue —
 * each BMI client key has its own `membershipKinds`, and the same membership has
 * a DIFFERENT id per key. Read live off Office `/api/{clientKey}/metadata`
 * 2026-08-12:
 *
 *   headpinzftmyers (FastTrax + HP Fort Myers) — 23 kinds
 *     479317   Customer Registration   ← ours
 *     479319   Default Membership
 *     96353    Default                 (legacy/unused)
 *     11260957 License Fee             (the BMI product buys it)
 *     12213012 Qualified Intermediate  (EARNED on track, never granted)
 *   headpinznaples (HP Naples) — only 4 kinds, ENTIRELY different ids
 *     84079    Customer Registration   ← ours
 *     46696    Waiver Signed
 *     496418   Default
 *     496420   Groupon
 *
 * Sending Fort Myers' 479317 to Naples fails with Pandora
 * "No membership found with that ID" — which is exactly what happened to the
 * 8 Naples grants queued 2026-08-12 14:44–14:48. Hence the per-location map.
 *
 * Keyed by Pandora locationID (what the queue row carries), env-overridable so a
 * catalogue change is a config edit, not a deploy.
 */
export const REGISTRATION_MEMBERSHIP_KIND_BY_LOCATION: Record<string, string> = {
  // FastTrax Fort Myers + HeadPinz Fort Myers — both on `headpinzftmyers`.
  LAB52GY480CJF: process.env.DEFAULT_REGISTRATION_MEMBERSHIP_KIND_ID || "479317",
  TXBSQN0FEKQ11: process.env.DEFAULT_REGISTRATION_MEMBERSHIP_KIND_ID || "479317",
  // HeadPinz Naples — `headpinznaples`, its own catalogue.
  PPTR5G2N0QXF7: process.env.DEFAULT_REGISTRATION_MEMBERSHIP_KIND_ID_NAPLES || "84079",
};

/** Fort Myers' id, kept as the name the rest of the app already imports. */
export const DEFAULT_REGISTRATION_MEMBERSHIP_KIND_ID =
  REGISTRATION_MEMBERSHIP_KIND_BY_LOCATION[FASTTRAX_LOCATION_ID];

/**
 * The registration kind for a center. Returns `null` for an UNKNOWN location
 * rather than falling back to Fort Myers' id — a wrong-center id is not a
 * retryable transport blip, it is a guaranteed Pandora refusal, and silently
 * defaulting is what produced the 8 stuck Naples rows.
 */
export function registrationKindForLocation(locationId: string | null | undefined): string | null {
  if (!locationId) return DEFAULT_REGISTRATION_MEMBERSHIP_KIND_ID;
  return REGISTRATION_MEMBERSHIP_KIND_BY_LOCATION[locationId] ?? null;
}

/** The license term. Pandora won't default `expires`, so we always send now + 1yr. */
export function oneYearFromNow(from: Date = new Date()): string {
  const d = new Date(from);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

function authHeaders(): HeadersInit {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

export interface AddMembershipParams {
  personId: string | number;
  /** Defaults to LICENSE_MEMBERSHIP_KIND_ID. */
  membershipKindId?: string;
  locationId?: string;
  /** ISO — omit to let Pandora default to now. */
  activates?: string;
  /** ISO — defaults to +1 year (Pandora does NOT default this). */
  expires?: string;
}

/**
 * Grant a membership on a person (writes a Firebird membership row via Pandora).
 * Returns the new membership id. Throws on transport / API failure — the caller
 * owns the persist-first ledger + reconcile (same contract as addDeposit).
 */
export async function addMembership(params: AddMembershipParams): Promise<string> {
  const kindId = params.membershipKindId ?? LICENSE_MEMBERSHIP_KIND_ID;
  if (!kindId) {
    throw new Error(
      "addMembership: membership-kind id not set (RACE_LICENSE_MEMBERSHIP_KIND_ID) — need the F_MSK_ID from Pandora/BMI",
    );
  }
  const body: Record<string, unknown> = {
    locationID: params.locationId ?? FASTTRAX_LOCATION_ID,
    personID: String(params.personId),
    membershipKindID: String(kindId),
    // Pandora won't default expires — always send the 1-year term.
    expires: params.expires ?? oneYearFromNow(),
  };
  if (params.activates) body.activates = params.activates;

  const res = await fetch(`${PANDORA_BASE}/v2/bmi/membership`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let json: {
    success?: boolean;
    message?: string;
    data?: { linkID?: string; membershipID?: string };
  } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  // Live response (verified 2026-07-25): { success, data: { action:"inserted",
  // linkID, membershipKindID, activates, expires } }. The grant id is `linkID`.
  const id = json?.data?.linkID ?? json?.data?.membershipID;
  if (!res.ok || !json?.success || !id) {
    throw new Error(
      `Pandora addMembership failed: ${json?.message || text.slice(0, 200) || `HTTP ${res.status}`}`,
    );
  }
  return String(id);
}
