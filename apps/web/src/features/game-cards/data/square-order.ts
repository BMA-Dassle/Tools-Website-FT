/**
 * Square order creation for a token-package reload. One catalog-backed line
 * item with a price override (the catalog id is for dashboard categorization,
 * not pricing — same pattern as race packs). Reuses the account module's
 * shared Square HTTP client so Square config stays in one place.
 */
import { squareFetch, squareErrorDetail } from "~/features/account/data/square-client";
import { SQUARE_TOKEN_CATALOG_ID } from "../constants";

export interface CreateReloadOrderParams {
  squareLocation: string;
  amountCents: number;
  /** Human label shown on the receipt (e.g. "500 Tokens + 100 Bonus"). */
  label: string;
  /** Card being reloaded — for the order note / audit trail. */
  accountNumber: string;
  /** Fixed-length idempotency seed (≤45-char Square limit with prefixes). */
  baseKey: string;
}

export async function createReloadOrder(params: CreateReloadOrderParams): Promise<string> {
  const { squareLocation, amountCents, label, accountNumber, baseKey } = params;
  const { ok, data } = await squareFetch<{ order?: { id?: string }; errors?: unknown }>("/orders", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: `order-${baseKey}`,
      order: {
        location_id: squareLocation,
        line_items: [
          {
            quantity: "1",
            base_price_money: { amount: amountCents, currency: "USD" },
            catalog_object_id: SQUARE_TOKEN_CATALOG_ID,
            item_type: "ITEM",
            name: label,
          },
        ],
        note: `Game card reload — card ${accountNumber}`,
      },
    }),
  });
  const orderId = data?.order?.id;
  if (!ok || !orderId) {
    throw new Error(`Square order create failed: ${squareErrorDetail(data)}`);
  }
  return orderId;
}
