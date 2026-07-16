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
}

export async function createReloadOrder(params: CreateReloadOrderParams): Promise<string> {
  const { squareLocation, baseKey, lines } = params;
  const lineItems = lines.map((l) => ({
    quantity: "1",
    base_price_money: { amount: l.amountCents, currency: "USD" },
    catalog_object_id: SQUARE_TOKEN_CATALOG_ID,
    item_type: "ITEM",
    name: `${l.label} → card ${l.accountNumber}`,
  }));

  const { ok, data } = await squareFetch<{ order?: { id?: string }; errors?: unknown }>("/orders", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: `order-${baseKey}`,
      order: {
        location_id: squareLocation,
        line_items: lineItems,
        note:
          lines.length === 1
            ? `Game card reload — card ${lines[0].accountNumber}`
            : `Game card reload — ${lines.length} cards`,
      },
    }),
  });
  const orderId = data?.order?.id;
  if (!ok || !orderId) {
    throw new Error(`Square order create failed: ${squareErrorDetail(data)}`);
  }
  return orderId;
}
