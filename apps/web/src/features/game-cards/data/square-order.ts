/**
 * Square order creation for a token-package reload (1..N cards in one order).
 * One catalog-backed line item per card with a price override (the catalog id
 * is for dashboard categorization, not pricing — same pattern as race packs).
 * Reuses the account module's shared Square HTTP client.
 */
import { squareFetch, squareErrorDetail } from "~/features/account/data/square-client";
import {
  SQUARE_TOKEN_CATALOG_ID,
  SQUARE_ACTIVATION_FEE_CATALOG_ID,
  ACTIVATION_FEE_CENTS,
} from "../constants";

export interface ReloadOrderLine {
  /** Receipt label, e.g. "500 Tokens + 100 Bonus". */
  label: string;
  amountCents: number;
  /** Card being reloaded — flows into the line name for the audit trail. */
  accountNumber: string;
}

export interface CreateReloadOrderParams {
  squareLocation: string;
  /** Fixed-length idempotency seed (≤45-char Square limit with prefixes). */
  baseKey: string;
  lines: ReloadOrderLine[];
  /** "reload" (existing cards, default) vs "purchase" (new cards being sold). */
  purpose?: "reload" | "purchase";
}

export async function createReloadOrder(params: CreateReloadOrderParams): Promise<string> {
  const { squareLocation, baseKey, lines, purpose = "reload" } = params;
  const verb = purpose === "purchase" ? "purchase" : "reload";
  const lineItems: Array<Record<string, unknown>> = lines.map((l) => ({
    quantity: "1",
    base_price_money: { amount: l.amountCents, currency: "USD" },
    catalog_object_id: SQUARE_TOKEN_CATALOG_ID,
    item_type: "ITEM",
    // New cards have no account yet — omit the "→ card N" suffix for a purchase.
    name: purpose === "purchase" ? `${l.label} (new card)` : `${l.label} → card ${l.accountNumber}`,
  }));

  // NEW cards carry a one-time $2 activation fee — one line, its own catalog id
  // so Square reporting separates fees from token sales (owner 2026-07-18).
  // Reloads never activate, so no fee line. The fee is ON TOP of the token price;
  // prepareTerminalPurchase's totalCents + finalizeTerminalPurchase's expected
  // amount add the identical fee, so the order total, the reader charge, and the
  // server verify all agree.
  if (purpose === "purchase") {
    lineItems.push({
      quantity: String(lines.length),
      base_price_money: { amount: ACTIVATION_FEE_CENTS, currency: "USD" },
      catalog_object_id: SQUARE_ACTIVATION_FEE_CATALOG_ID,
      item_type: "ITEM",
      name: "Card activation fee",
    });
  }

  const { ok, data } = await squareFetch<{ order?: { id?: string }; errors?: unknown }>("/orders", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: `order-${baseKey}`,
      order: {
        location_id: squareLocation,
        line_items: lineItems,
        note:
          lines.length === 1 && purpose === "reload"
            ? `Game card reload — card ${lines[0].accountNumber}`
            : `Game card ${verb} — ${lines.length} card${lines.length === 1 ? "" : "s"}`,
      },
    }),
  });
  const orderId = data?.order?.id;
  if (!ok || !orderId) {
    throw new Error(`Square order create failed: ${squareErrorDetail(data)}`);
  }
  return orderId;
}

/**
 * Read a Square payment for server-side verification of a kiosk card-present
 * (Terminal) capture. The browser is NEVER trusted for a reader charge — the
 * finalize step re-reads the payment to confirm it COMPLETED, paid OUR order,
 * for the right amount at the right location. Returns null on any fetch error.
 */
export async function readSquarePayment(id: string): Promise<{
  id: string;
  status: string;
  amountCents: number;
  orderId?: string;
  locationId?: string;
} | null> {
  const { ok, data } = await squareFetch<{
    payment?: {
      id?: string;
      status?: string;
      amount_money?: { amount?: number };
      order_id?: string;
      location_id?: string;
    };
  }>(`/payments/${encodeURIComponent(id)}`, { method: "GET" });
  const p = data?.payment;
  if (!ok || !p?.id) return null;
  return {
    id: p.id,
    status: p.status ?? "UNKNOWN",
    amountCents: p.amount_money?.amount ?? -1,
    orderId: p.order_id,
    locationId: p.location_id,
  };
}

export type SquarePaymentRead = NonNullable<Awaited<ReturnType<typeof readSquarePayment>>>;

/** Payment statuses that will never become COMPLETED — stop polling immediately. */
const TERMINAL_FAILURE_STATUSES = new Set(["FAILED", "CANCELED"]);

/**
 * Read a reader payment, tolerating Square's brief post-checkout propagation
 * lag. A Terminal checkout flips to COMPLETED (and hands us a payment id) a
 * moment before `GET /payments/{id}` reflects that same payment as COMPLETED —
 * sometimes it 404s or reads back APPROVED (autocomplete still capturing) for a
 * second or two. A single read therefore rejected a perfectly good capture as
 * "unverified", stranding the guest's money (the reload-alerts / reconcile cron
 * only recovers rows we managed to mark charged — and we throw BEFORE that).
 *
 * So poll: return as soon as the payment reads COMPLETED, bail early on a
 * terminal failure (declined/canceled — don't wait it out), else keep trying to
 * the attempt budget. Only COMPLETED is ever accepted by the caller, so this
 * never weakens the server-side tripwire — it just gives a real capture time to
 * settle. ~4s worst case (6 reads, 700 ms apart) fits inside the finalize POST.
 */
export async function readSquarePaymentSettled(
  id: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<SquarePaymentRead | null> {
  const attempts = Math.max(1, opts.attempts ?? 6);
  const delayMs = opts.delayMs ?? 700;
  let last: SquarePaymentRead | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await readSquarePayment(id);
    if (last?.status === "COMPLETED") return last;
    if (last && TERMINAL_FAILURE_STATUSES.has(last.status)) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.error(
    `[game-cards] reader payment ${id} not COMPLETED after ${attempts} reads — last status=${last?.status ?? "not-found"}`,
  );
  return last;
}
