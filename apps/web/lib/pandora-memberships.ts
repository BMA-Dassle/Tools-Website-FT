/**
 * Pandora MEMBERSHIP helpers — the license twin of pandora-deposits.ts.
 *
 * Race-pack credits load via Pandora `addDeposit` (POST /v2/bmi/deposit) with NO
 * BMI cloud bill. A standalone FastTrax LICENSE gets the same treatment: write the
 * "License Fee" membership straight into Firebird via Pandora so the racer is
 * licensed — no BMI booking/sell → payment/confirm dance (which we proved leaves an
 * unpaid bill and attaches NO membership; GET /membership is empty for FastTrax).
 *
 * Endpoints (parallel to the deposit endpoints; Pandora building 2026-07-25):
 *   POST /v2/bmi/membership
 *        { locationID, personID, membershipKindID, activates?, expires } → membershipID
 *   GET  /v2/bmi/memberships/{locationID}/{personID}
 *        → the person's memberships (kind id + name + expiry)
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

export interface MembershipRow {
  /** F_MSK_ID — membership kind id. */
  kindId: string;
  /** Human-readable name ("License Fee", "Intermediate", ...). */
  name: string;
  /** ISO expiry (null / far-future = never). */
  expires: string | null;
  /** Derived: not expired. */
  active: boolean;
}

/** Read a person's memberships from Firebird via Pandora. Field-spelling tolerant
 *  until the exact response shape is confirmed against the live endpoint. */
export async function getMemberships(
  personId: string | number,
  locationId: string = FASTTRAX_LOCATION_ID,
): Promise<MembershipRow[]> {
  const url = `${PANDORA_BASE}/v2/bmi/memberships/${encodeURIComponent(locationId)}/${encodeURIComponent(String(personId))}`;
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Pandora memberships ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { success?: boolean; data?: unknown };
  const rows = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  const now = Date.now();
  return (rows as Array<Record<string, unknown>>).map((r) => {
    const expires =
      (r.OUT_MSK_EXPIRES as string) ?? (r.expires as string) ?? (r.stops as string) ?? null;
    return {
      kindId: String(r.OUT_MSK_ID ?? r.membershipKindID ?? r.kindId ?? ""),
      name: String(r.OUT_MSK_NAME ?? r.name ?? ""),
      expires,
      active: !expires || new Date(expires).getTime() > now,
    };
  });
}

/** True when the person holds an ACTIVE membership marking a license (name match,
 *  or the configured license kind id). */
export async function hasActiveLicenseMembership(
  personId: string | number,
  locationId: string = FASTTRAX_LOCATION_ID,
): Promise<boolean> {
  const rows = await getMemberships(personId, locationId);
  return rows.some(
    (m) =>
      m.active &&
      (m.name.toLowerCase().includes("license") ||
        (!!LICENSE_MEMBERSHIP_KIND_ID && m.kindId === LICENSE_MEMBERSHIP_KIND_ID)),
  );
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
  let json: { success?: boolean; message?: string; data?: { membershipID?: string } } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  const id = json?.data?.membershipID;
  if (!res.ok || !json?.success || !id) {
    throw new Error(
      `Pandora addMembership failed: ${json?.message || text.slice(0, 200) || `HTTP ${res.status}`}`,
    );
  }
  return String(id);
}
