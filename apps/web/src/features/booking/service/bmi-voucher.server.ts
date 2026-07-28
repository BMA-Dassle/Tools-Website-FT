/**
 * BMI voucher server calls — `order/applyCode` / `order/removeCode` against
 * the Public Booking API, shared by the kiosk AND web surfaces via
 * `POST /api/booking/v2/voucher`.
 *
 * Everything here honors the probe-verified semantics (2026-07-27, see
 * voucher-redeem.ts header + tasks/future/kiosk-coupons-vouchers.md §4):
 * applyCode lands the comp product as a $0 line and returns the order
 * overview INLINE (the public bill-overview GET is not exposed); errors are
 * HTTP 200 + `{success:false, errorMessage}`; codes aren't locked at apply.
 *
 * Hard rules: 17-digit ids never ride through JSON.parse/stringify unquoted
 * (parseWithRawIds / stringifyWithRawIds); the Neon audit row is written
 * BEFORE apply reports success — if the row can't be written, the comp line
 * is backed out so BMI and our ledger can never disagree (the reserve's
 * coverage verification reads the ledger, not the client session).
 */

import { BMI_ID_FIELDS, parseWithRawIds, stringifyWithRawIds } from "@ft/db";

/** applyCode's inline overview carries the comp line id under a name the
 *  default BMI_ID_FIELDS set doesn't know — quote it too or JSON.parse
 *  rounds the 17-digit value. */
const VOUCHER_ID_FIELDS = [...BMI_ID_FIELDS, "voucherOrderItemId", "VoucherOrderItemId"] as const;
import { recordVoucherApplied, markVoucherRemoved } from "../data/voucher-redemptions-db";

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";

/** Same center → clientKey rule as unified-reserve's resolveBmiClientKey. */
export function voucherClientKeyForCenter(center: string | null | undefined): string {
  return center === "naples" ? "headpinznaples" : "headpinzftmyers";
}

const tokenCache: Record<string, { token: string; expiry: number }> = {};

async function getToken(clientKey: string): Promise<string> {
  const cached = tokenCache[clientKey];
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;
  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`BMI auth failed: ${res.status}`);
  const data = (await res.json()) as { AccessToken?: string; accessToken?: string };
  const token = data.AccessToken || data.accessToken || "";
  tokenCache[clientKey] = { token, expiry: Date.now() + 3500_000 };
  return token;
}

async function bmiPost(
  clientKey: string,
  endpoint: "order/applyCode" | "order/removeCode",
  body: string,
): Promise<{ status: number; data: Record<string, unknown> | null; raw: string }> {
  const token = await getToken(clientKey);
  const res = await fetch(`${BMI_API_URL}/public-booking/${clientKey}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "BMI-Subscription-Key": BMI_SUB_KEY,
      "Content-Type": "application/json",
    },
    body,
    cache: "no-store",
  });
  const raw = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = parseWithRawIds(raw, VOUCHER_ID_FIELDS) as Record<string, unknown>;
  } catch {
    /* non-JSON — status carries the story */
  }
  return { status: res.status, data, raw };
}

export interface VoucherApplyResult {
  ok: boolean;
  /** Comp line name ("Race Comp") — set on success. */
  name?: string;
  /** Comp line OrderItemId (raw string) — set on success. */
  voucherOrderItemId?: string;
  /** BMI's errorMessage verbatim on failure ("Voucher (code: …) is not found"). */
  errorMessage?: string;
}

/**
 * Apply a voucher code to an existing BMI bill. On success the Neon audit row
 * is written BEFORE returning ok; a failed ledger write backs the comp line
 * out (removeCode) and reports failure — the two systems never disagree.
 */
export async function applyVoucherToBill(args: {
  clientKey: string;
  billId: string;
  code: string;
  source: "kiosk" | "web";
}): Promise<VoucherApplyResult> {
  const { clientKey, billId, code, source } = args;
  const body = stringifyWithRawIds({ Code: code }, { rawIds: { OrderId: billId } });
  const res = await bmiPost(clientKey, "order/applyCode", body);

  if (res.status !== 200 || !res.data) {
    return { ok: false, errorMessage: `BMI ${res.status}` };
  }
  if (res.data.success === false) {
    return { ok: false, errorMessage: String(res.data.errorMessage ?? "apply failed") };
  }

  // The overview comes back inline (camelCase in practice). The comp line is
  // the one stamped with OUR code; AppliedPromoCodes carries its line id.
  const promos = (res.data.appliedPromoCodes ?? res.data.AppliedPromoCodes ?? []) as Array<
    Record<string, unknown>
  >;
  const applied = promos.find((p) =>
    String(p.name ?? p.Name ?? "")
      .toUpperCase()
      .includes(code),
  );
  const voucherOrderItemId = applied
    ? String(applied.voucherOrderItemId ?? applied.VoucherOrderItemId ?? "")
    : "";
  if (!voucherOrderItemId) {
    // 200 + no applied entry for our code — vendor success is not proof of
    // effect (house rule); treat as failure.
    return { ok: false, errorMessage: "voucher did not attach to the order" };
  }
  const lines = (res.data.lines ?? res.data.Lines ?? []) as Array<Record<string, unknown>>;
  const compLine = lines.find(
    (l) => String(l.voucherCode ?? l.VoucherCode ?? "").toUpperCase() === code,
  );
  const name = compLine
    ? String(compLine.name ?? compLine.Name ?? "")
    : String(applied?.name ?? applied?.Name ?? "").split(" - ")[0];

  try {
    await recordVoucherApplied({
      code,
      billId,
      voucherOrderItemId,
      compName: name || null,
      clientKey,
      source,
    });
  } catch (err) {
    console.error("[bmi-voucher] ledger write failed — backing the comp line out:", err);
    await removeVoucherFromBill({ clientKey, billId, voucherOrderItemId, code }).catch(() => {});
    return { ok: false, errorMessage: "could not record the voucher — please try again" };
  }

  return { ok: true, name: name || undefined, voucherOrderItemId };
}

/** Remove a previously applied voucher (guest cleared it / teardown hygiene). */
export async function removeVoucherFromBill(args: {
  clientKey: string;
  billId: string;
  voucherOrderItemId: string;
  code: string;
}): Promise<{ ok: boolean }> {
  const { clientKey, billId, voucherOrderItemId, code } = args;
  const body = stringifyWithRawIds(
    { DiscountId: null },
    { rawIds: { OrderId: billId, VoucherOrderItemId: voucherOrderItemId } },
  );
  const res = await bmiPost(clientKey, "order/removeCode", body);
  const ok = res.status === 200 && res.data?.success !== false;
  if (ok) await markVoucherRemoved(billId, code).catch(() => {});
  return { ok };
}
