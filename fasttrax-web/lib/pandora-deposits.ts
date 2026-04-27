/**
 * Pandora deposit helpers.
 *
 * BMI's race-pack sale flow (booking/sell on a pack productId) has
 * been broken since the April 9 product-ID switchover — credits get
 * applied at the wrong stage. While BMI fixes that, we route around
 * it: charge via Square, then credit the customer's BMI deposit
 * balance directly through the Pandora workaround endpoints.
 *
 * Two endpoints:
 *
 *   GET  /v2/bmi/deposits/{locationID}/{personID}
 *        → all deposit kinds + current balances (calls Firebird
 *          stored proc DPS_OVERVIEW)
 *   POST /v2/bmi/deposit
 *        → insert one row into T_DEPOSIT. Positive amount adds
 *          (action=0); negative removes (action=1). Zero rejected.
 *
 * Auth: SWAGGER_ADMIN_KEY (same key the rest of the Pandora proxy
 * uses — see app/api/pandora/sessions/route.ts).
 *
 * Important: balances are derived from rows. Each call inserts a new
 * row; "undo" means inserting a counter-row, never deleting. Treat
 * the call site as a write log — log every attempt, including
 * failures, so admin can reconcile.
 */

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

/** Deposit-kind catalogue. The IDs come from
 *  GET /v2/bmi/deposits/{loc}/{personId} which lists every kind
 *  with its current balance.  Verified live 2026-04-26. */
export const DEPOSIT_KIND = {
  /** Race credits redeemable Mon-Thu only — used by weekday packs. */
  RACE_WEEKDAY: "12744867",
  /** Race credits redeemable any day — used by anytime packs. */
  RACE_ANYTIME: "12744871",
  /** Comp / give-back credits — staff-issued, not for sale. */
  RACE_COMP: "11260967",
  /** Membership-tied credits. */
  RACE_MEMBERSHIP: "12754483",
  /** License credit (one-time, applied at first race). */
  LICENSE: "32442585",
  /** Test kind — handy for round-trip verification, never charge against this. */
  TEST: "39228454",
} as const;

export type DepositKindId = (typeof DEPOSIT_KIND)[keyof typeof DEPOSIT_KIND] | string;

/** Single deposit row from the DPS_OVERVIEW stored proc. */
export interface DepositOverviewRow {
  /** F_DPK_ID — deposit kind id, matches DEPOSIT_KIND values above. */
  OUT_DPK_ID: number;
  /** Human-readable name ("Credit - Race Anytime", "Employee Pass", ...). */
  OUT_DPK_NAME: string;
  /** Net balance: sum(action=0) - sum(action=1). */
  OUT_DPS_AMOUNT: number;
}

interface DepositsApiResponse {
  success: boolean;
  message?: string;
  data?: DepositOverviewRow[];
  error?: unknown;
}

interface DepositInsertResponse {
  success: boolean;
  message?: string;
  data?: { depositID: string };
  error?: unknown;
}

function authHeaders(): HeadersInit {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Fetch every deposit kind + balance for a person. Returns the raw
 * rows from DPS_OVERVIEW — caller can filter to the kinds they care
 * about. Race packs only care about RACE_WEEKDAY / RACE_ANYTIME, but
 * a future "your account credits" page will want the full list.
 */
export async function getDepositOverview(
  personId: string | number,
  locationId: string = FASTTRAX_LOCATION_ID,
): Promise<DepositOverviewRow[]> {
  const url = `${PANDORA_BASE}/v2/bmi/deposits/${encodeURIComponent(locationId)}/${encodeURIComponent(String(personId))}`;
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Pandora deposits ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as DepositsApiResponse;
  if (!json.success || !Array.isArray(json.data)) {
    throw new Error(json.message || "Pandora deposits returned no data");
  }
  return json.data;
}

/**
 * Convenience: get balances keyed by DPK_ID. Useful for quick
 * lookups against the DEPOSIT_KIND constants without the caller
 * walking the array each time.
 */
export async function getDepositBalances(
  personId: string | number,
  locationId: string = FASTTRAX_LOCATION_ID,
): Promise<Map<string, { name: string; balance: number }>> {
  const rows = await getDepositOverview(personId, locationId);
  const out = new Map<string, { name: string; balance: number }>();
  for (const r of rows) {
    out.set(String(r.OUT_DPK_ID), { name: r.OUT_DPK_NAME, balance: r.OUT_DPS_AMOUNT });
  }
  return out;
}

export interface AddDepositParams {
  personId: string | number;
  depositKindId: DepositKindId;
  /** Positive to add credits, negative to remove. Zero is rejected by Pandora. */
  amount: number;
  locationId?: string;
  /** ISO timestamp — defaults to server time (now) when omitted. */
  activates?: string;
  /** ISO timestamp — defaults to year 2999 (effectively never) when omitted. */
  expires?: string;
}

/**
 * Add (or remove) a deposit on a person. Returns the new
 * `depositID` Pandora assigned. Throws on transport / API failure
 * — caller should wrap in try/catch and log the failure so admin
 * can reconcile if Square charged but the deposit didn't land.
 */
export async function addDeposit(params: AddDepositParams): Promise<string> {
  if (!params.amount || params.amount === 0) {
    throw new Error("addDeposit: amount must be non-zero");
  }
  const body: Record<string, unknown> = {
    locationID: params.locationId ?? FASTTRAX_LOCATION_ID,
    personID: String(params.personId),
    depositKindID: String(params.depositKindId),
    amount: params.amount,
  };
  if (params.activates) body.activates = params.activates;
  if (params.expires) body.expires = params.expires;

  const res = await fetch(`${PANDORA_BASE}/v2/bmi/deposit`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let json: DepositInsertResponse | null = null;
  try { json = JSON.parse(text) as DepositInsertResponse; } catch { /* non-JSON body */ }

  if (!res.ok || !json?.success || !json.data?.depositID) {
    const msg = json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`Pandora addDeposit failed: ${msg}`);
  }
  return json.data.depositID;
}
