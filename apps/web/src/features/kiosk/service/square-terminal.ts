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
      device_codes?: Array<{
        device_id?: string;
        name?: string;
        code?: string;
        status?: string;
        location_id?: string;
      }>;
      cursor?: string;
    }>(`/devices/codes?${qs.toString()}`);
    for (const dc of body.device_codes ?? []) {
      // Strictly this location's readers only — Square's location_id query param
      // can still surface codes from other locations, so re-filter (owner: "only
      // show readers from the center it's set to").
      if (dc.device_id && dc.location_id === locationId) {
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
  const { status, body } = await sq<{
    device_code?: { id?: string; code?: string };
    errors?: Array<{ code?: string; detail?: string; field?: string }>;
  }>("/devices/codes", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      device_code: { product_type: "TERMINAL_API", name, location_id: locationId },
    }),
  });
  const dc = body.device_code;
  if (dc?.code) return { code: dc.code, id: dc.id ?? "" };
  const e = body.errors?.[0];
  const detail = e ? `${e.code}${e.field ? ` [${e.field}]` : ""}: ${e.detail}` : `HTTP ${status}`;
  console.error(`[square-terminal] createDeviceCode rejected loc=${locationId} → ${detail}`);
  throw new Error(`Square reader pairing failed — ${detail}`);
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
  /**
   * Pay an EXISTING Square order (Mercury pattern). When set, the Terminal
   * pays this order so downstream gift-card activation stays order+line-item
   * linked exactly like the typed-card deposit path — no money-rail fork.
   * When omitted, Square creates an implicit order for the amount.
   */
  orderId?: string;
  /**
   * Deterministic idempotency key (kiosk money path passes `term-${baseKey}`) so
   * a double-POST / retry replays the SAME checkout — the reader is armed once,
   * never tapped twice. Omitted for non-money callers → random per call.
   */
  idempotencyKey?: string;
}): Promise<TerminalCheckoutResult | null> {
  if (!SQUARE_TOKEN) return null;
  const checkout: Record<string, unknown> = {
    device_options: { device_id: args.deviceId, skip_receipt_screen: true },
    payment_options: { autocomplete: true },
    reference_id: args.referenceId.slice(0, 40),
    note: args.note?.slice(0, 500),
  };
  if (args.orderId) {
    checkout.order_id = args.orderId;
    // With an order, Square derives the amount from the order's net due, but
    // the API still requires amount_money — send the same amount.
    checkout.amount_money = { amount: args.amountCents, currency: "USD" };
  } else {
    checkout.amount_money = { amount: args.amountCents, currency: "USD" };
  }
  const { status, body } = await sq<{
    checkout?: { id?: string; status?: string };
    errors?: Array<{ code?: string; detail?: string; field?: string }>;
  }>("/terminals/checkouts", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: args.idempotencyKey ?? crypto.randomUUID(),
      checkout,
    }),
  });
  const c = body.checkout;
  if (c?.id) return { checkoutId: c.id, status: c.status ?? "PENDING" };
  // The reader/token exist (we got here) but Square rejected the checkout —
  // surface the REAL reason (device offline, bad order, amount, etc.) instead of
  // a misleading "Square not configured". Throw so the route returns the detail.
  const e = body.errors?.[0];
  const detail = e ? `${e.code}${e.field ? ` [${e.field}]` : ""}: ${e.detail}` : `HTTP ${status}`;
  console.error(
    `[square-terminal] createTerminalCheckout rejected device=${args.deviceId} order=${args.orderId ?? "(none)"} amount=${args.amountCents} → ${detail}`,
  );
  throw new Error(`Square reader checkout failed — ${detail}`);
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

// ── SAVE_CARD terminal action ────────────────────────────────────────────
//
// The KIOSK card-present path uses SAVE_CARD (not a Terminal checkout) so the
// existing reserve money rail is reused UNCHANGED: the guest dips/taps on the
// reader, Square vaults the card to a card-on-file id, and reserveAll charges
// that id exactly like a "saved card" (cardSourceId). No deposit split, no
// pause/resume of the multi-vendor reserve — the only new surface is capturing
// the card. Requires a Square customer to attach the card to.

export interface TerminalActionResult {
  actionId: string;
  status: string; // PENDING | IN_PROGRESS | COMPLETED | CANCELED
  cardId?: string; // card-on-file id, present when a SAVE_CARD action COMPLETED
}

export async function createSaveCardAction(args: {
  deviceId: string;
  customerId: string;
  referenceId: string;
}): Promise<TerminalActionResult | null> {
  if (!SQUARE_TOKEN) return null;
  const { body } = await sq<{ action?: { id?: string; status?: string } }>("/terminals/actions", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      action: {
        type: "SAVE_CARD",
        device_id: args.deviceId,
        save_card_options: {
          customer_id: args.customerId,
          reference_id: args.referenceId.slice(0, 40),
        },
      },
    }),
  });
  const a = body.action;
  return a?.id ? { actionId: a.id, status: a.status ?? "PENDING" } : null;
}

export async function getTerminalAction(id: string): Promise<TerminalActionResult | null> {
  if (!SQUARE_TOKEN) return null;
  const { body } = await sq<{
    action?: { id?: string; status?: string; save_card_action_details?: { card_id?: string } };
  }>(`/terminals/actions/${encodeURIComponent(id)}`);
  const a = body.action;
  return a?.id
    ? { actionId: a.id, status: a.status ?? "UNKNOWN", cardId: a.save_card_action_details?.card_id }
    : null;
}

export async function dismissTerminalAction(id: string): Promise<boolean> {
  if (!SQUARE_TOKEN) return false;
  const { status } = await sq(`/terminals/actions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}",
  });
  return status < 400;
}
