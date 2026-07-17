/**
 * Square Terminal + Devices API — kiosk card-present payments.
 *
 * Ported from the reusable core of C:\GIT\Mercury (src/util/square.ts), which
 * drives Square Terminals in production today; we keep its exact call shapes
 * and drop its BMI/WebSocket transport. All server-side REST via the same
 * connect.squareup.com base + SQUARE_ACCESS_TOKEN the rest of the app uses.
 *
 * Flow: pair a reader (createDeviceCode → operator types it into the Terminal)
 * → list paired readers for the admin picker → send a checkout to a deviceId
 * → the kiosk client polls getTerminalCheckout → dismiss to cancel. No
 * webhooks (Mercury polls too); the kiosk browser is long-lived so it polls a
 * status route rather than holding server state.
 */
const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

/** center → Square location id (matches PaymentForm + Mercury's locMap). */
export const SQUARE_LOCATION_BY_CENTER: Record<string, string> = {
  "fort-myers": "LAB52GY480CJF", // FastTrax FM (HeadPinz FM = TXBSQN0FEKQ11 when brand=headpinz)
  naples: "PPTR5G2N0QXF7",
};
export function squareLocationId(center: string, brand: string): string {
  if (center === "naples") return "PPTR5G2N0QXF7";
  return brand === "headpinz" ? "TXBSQN0FEKQ11" : "LAB52GY480CJF";
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Square-Version": SQUARE_VERSION,
    "Content-Type": "application/json",
  };
}

async function sq<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${SQUARE_BASE}${path}`, { ...init, headers: headers() });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

export interface PairedReader {
  deviceId: string;
  name: string;
  code: string;
  status: string; // PAIRED | UNPAIRED | ...
}

/**
 * List paired Terminal readers for a location — the admin reader picker.
 * (Mercury: devicesApi.listDeviceCodes filtered to PAIRED.)
 */
export async function listReaders(locationId: string): Promise<PairedReader[]> {
  if (!SQUARE_TOKEN) return [];
  const out: PairedReader[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ location_id: locationId, product_type: "TERMINAL_API" });
    if (cursor) qs.set("cursor", cursor);
    const { body } = await sq<{
      device_codes?: Array<{ device_id?: string; name?: string; code?: string; status?: string }>;
      cursor?: string;
    }>(`/devices/codes?${qs.toString()}`);
    for (const dc of body.device_codes ?? []) {
      if (dc.device_id) {
        out.push({
          deviceId: dc.device_id,
          name: dc.name ?? "Reader",
          code: dc.code ?? "",
          status: dc.status ?? "UNKNOWN",
        });
      }
    }
    cursor = body.cursor;
  } while (cursor);
  return out;
}

/**
 * Begin pairing a new reader: returns a code the operator types into the
 * physical Square Terminal (Devices → Sign in → Pairing code).
 */
export async function createDeviceCode(
  locationId: string,
  name: string,
): Promise<{ code: string; id: string } | null> {
  if (!SQUARE_TOKEN) return null;
  const { body } = await sq<{ device_code?: { id?: string; code?: string } }>("/devices/codes", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      device_code: { product_type: "TERMINAL_API", name, location_id: locationId },
    }),
  });
  const dc = body.device_code;
  return dc?.code ? { code: dc.code, id: dc.id ?? "" } : null;
}

export interface TerminalCheckoutResult {
  checkoutId: string;
  status: string; // PENDING | IN_PROGRESS | COMPLETED | CANCELED | CANCEL_REQUESTED
  paymentIds?: string[];
}

/**
 * Send a card-present checkout to a specific reader (Mercury:
 * terminalApi.createTerminalCheckout with deviceOptions.deviceId).
 */
export async function createTerminalCheckout(args: {
  deviceId: string;
  amountCents: number;
  referenceId: string;
  note?: string;
}): Promise<TerminalCheckoutResult | null> {
  if (!SQUARE_TOKEN) return null;
  const { body } = await sq<{ checkout?: { id?: string; status?: string } }>(
    "/terminals/checkouts",
    {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        checkout: {
          amount_money: { amount: args.amountCents, currency: "USD" },
          device_options: { device_id: args.deviceId, skip_receipt_screen: true },
          payment_options: { autocomplete: true },
          reference_id: args.referenceId.slice(0, 40),
          note: args.note?.slice(0, 500),
        },
      }),
    },
  );
  const c = body.checkout;
  return c?.id ? { checkoutId: c.id, status: c.status ?? "PENDING" } : null;
}

/** Poll a terminal checkout (kiosk client hits this on an interval). */
export async function getTerminalCheckout(id: string): Promise<TerminalCheckoutResult | null> {
  if (!SQUARE_TOKEN) return null;
  const { body } = await sq<{
    checkout?: { id?: string; status?: string; payment_ids?: string[] };
  }>(`/terminals/checkouts/${encodeURIComponent(id)}`);
  const c = body.checkout;
  return c?.id
    ? { checkoutId: c.id, status: c.status ?? "UNKNOWN", paymentIds: c.payment_ids }
    : null;
}

/** Cancel an in-flight terminal checkout. */
export async function dismissTerminalCheckout(id: string): Promise<boolean> {
  if (!SQUARE_TOKEN) return false;
  const { status } = await sq(`/terminals/checkouts/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}",
  });
  return status < 400;
}

/** Lightweight reachability check for the admin diagnostics panel. */
export async function pingReader(deviceId: string, locationId: string): Promise<boolean> {
  const readers = await listReaders(locationId);
  return readers.some((r) => r.deviceId === deviceId && r.status === "PAIRED");
}
