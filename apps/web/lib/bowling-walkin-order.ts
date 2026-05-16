/**
 * Creates a $0 Square day-of order for walk-in / kiosk / Conqueror bowling
 * reservations. The order exists solely for KDS shoe routing — the SHIPMENT
 * fulfillment added later by processLaneOpen tells kitchen staff which lane
 * to deliver shoes to.
 *
 * When player data is available (name + shoe size from QAMF), each player
 * gets a separate $0 "Shoes" line item so KDS staff see individual sizes.
 * Falls back to a single generic line item when no player data exists.
 *
 * Payment is handled at the POS (cash/card at the register). This order
 * is left OPEN with $0 line items.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

/** $0 catalog item used as a KDS ticket for shoe sizes. */
const SHOE_KDS_CATALOG_ID = "3SCMJXWRY5KJZONU7HDKKUQ3";

/** Location → county sales-tax catalog object ID */
const LOCATION_TAX: Record<string, string> = {
  TXBSQN0FEKQ11: "UBPQTR3W6ZKVRYFC7DXN2SJN", // Lee County   — 6.5%
  PPTR5G2N0QXF7: "BQNVIEEZQO2PX2FI72U6FEC4", // Collier Co.  — 6.0%
};

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** Player/shoe data from QAMF webhook Lanes[].Players[]. */
export interface WalkinPlayer {
  name: string;
  shoeSize?: string | null;
}

export async function createWalkinDayofOrder(opts: {
  locationId: string;
  guestName: string;
  playerCount: number;
  neonId: number;
  qamfReservationId: string;
  squareCustomerId?: string;
  /** Player data from QAMF — when present, each player gets a shoe line item. */
  players?: WalkinPlayer[];
}): Promise<{ dayofOrderId: string }> {
  const {
    locationId,
    guestName,
    playerCount,
    neonId,
    qamfReservationId,
    squareCustomerId,
    players,
  } = opts;

  const taxCatalogId = LOCATION_TAX[locationId];
  const orderTaxes = taxCatalogId
    ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
    : [];

  // Build line items: one shoe line per player (using the KDS catalog item
  // so Square KDS recognises them), plus a summary line for the dashboard.
  const lineItems: Array<{
    name: string;
    quantity: string;
    base_price_money: { amount: number; currency: string };
    catalog_object_id?: string;
    note?: string;
  }> = [];

  const playersWithShoes = (players ?? []).filter((p) => p.shoeSize);
  if (playersWithShoes.length > 0) {
    for (const p of playersWithShoes) {
      lineItems.push({
        catalog_object_id: SHOE_KDS_CATALOG_ID,
        name: p.shoeSize!,
        note: p.name,
        quantity: "1",
        base_price_money: { amount: 0, currency: "USD" },
      });
    }
  }
  // Always add a summary line so the order is identifiable in Square dashboard
  lineItems.push({
    name: `Walk-in Bowling - ${guestName} (${playerCount}p)`,
    quantity: "1",
    base_price_money: { amount: 0, currency: "USD" },
  });

  const res = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `walkin-dayof-${neonId}`,
      order: {
        location_id: locationId,
        ...(squareCustomerId ? { customer_id: squareCustomerId } : {}),
        reference_id: qamfReservationId,
        line_items: lineItems,
        ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
      },
    }),
  });

  const data = await res.json();

  if (!res.ok || data.errors) {
    const sqErr = data.errors?.[0];
    throw new Error(
      `Square createOrder failed: ${sqErr?.code ?? res.status} ${sqErr?.detail ?? ""}`,
    );
  }

  const dayofOrderId = data.order?.id as string;
  if (!dayofOrderId) {
    throw new Error("Square createOrder returned no order.id");
  }

  console.log(
    `[walkin-order] created $0 day-of order=${dayofOrderId} neonId=${neonId} qamfId=${qamfReservationId}`,
  );

  return { dayofOrderId };
}
