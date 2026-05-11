/**
 * Creates a $0 Square day-of order for walk-in / kiosk / Conqueror bowling
 * reservations. The order exists solely for KDS shoe routing — the SHIPMENT
 * fulfillment added later by processLaneOpen tells kitchen staff which lane
 * to deliver shoes to.
 *
 * Payment is handled at the POS (cash/card at the register). This order
 * is left OPEN with a single $0 ad-hoc line item.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

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

export async function createWalkinDayofOrder(opts: {
  locationId: string;
  guestName: string;
  playerCount: number;
  neonId: number;
  qamfReservationId: string;
}): Promise<{ dayofOrderId: string }> {
  const { locationId, guestName, playerCount, neonId, qamfReservationId } = opts;

  const taxCatalogId = LOCATION_TAX[locationId];
  const orderTaxes = taxCatalogId
    ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
    : [];

  const label = `Walk-in Bowling - ${guestName} (${playerCount}p)`;

  const res = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `walkin-dayof-${neonId}`,
      order: {
        location_id: locationId,
        reference_id: qamfReservationId,
        line_items: [
          {
            name: label,
            quantity: "1",
            base_price_money: { amount: 0, currency: "USD" },
          },
        ],
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
