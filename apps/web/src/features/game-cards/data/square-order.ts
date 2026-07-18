/**
 * Square order creation for a token-package reload (1..N cards in one order).
 * One catalog-backed line item per card with a price override (the catalog id
 * is for dashboard categorization, not pricing — same pattern as race packs).
 * Reuses the account module's shared Square HTTP client.
 */
import { squareFetch, squareErrorDetail } from "~/features/account/data/square-client";
import { SQUARE_TOKEN_CATALOG_ID } from "../constants";

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
  const lineItems = lines.map((l) => ({
    quantity: "1",
    base_price_money: { amount: l.amountCents, currency: "USD" },
    catalog_object_id: SQUARE_TOKEN_CATALOG_ID,
    item_type: "ITEM",
    // New cards have no account yet — omit the "→ card N" suffix for a purchase.
    name: purpose === "purchase" ? `${l.label} (new card)` : `${l.label} → card ${l.accountNumber}`,
  }));

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
