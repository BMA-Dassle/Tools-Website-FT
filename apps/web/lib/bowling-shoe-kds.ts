/**
 * Shared shoe-size KDS sync for bowling day-of Square orders.
 *
 * Shoe SIZES (per bowler, e.g. "Male 11") are informational only — they ride
 * on the day-of order as $0 line items under a fixed KDS catalog item so the
 * kitchen/shoe-desk display shows each bowler's size + name when the order is
 * paid out. This is separate from priced shoe RENTAL line items.
 *
 * Two producers historically duplicated this logic:
 *   - the confirmation-page PATCH (web flow collects sizes post-booking)
 *   - unified-reserve (kiosk flow collects sizes UP FRONT)
 * and a third variant lives in bowling-walkin-order.ts (POST-on-create for the
 * walk-in / Conqueror path). This module is the shared clear-then-add updater
 * used by the first two, which mutate an ALREADY-CREATED order.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

/** $0 catalog item used as a KDS ticket for shoe sizes. */
export const SHOE_KDS_CATALOG_ID = "3SCMJXWRY5KJZONU7HDKKUQ3";

function sqHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN ?? ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** "Female 8" → "Female Size 8", "Male 11" → "Male Size 11", etc.
 *  Also handles legacy labels: "Women 8", "Men 11", "Kids 9" */
export function formatShoeSize(raw: string): string {
  const spaceIdx = raw.indexOf(" ");
  if (spaceIdx === -1) return raw;
  const category = raw.slice(0, spaceIdx).toLowerCase();
  const size = raw.slice(spaceIdx + 1);
  if (category === "female" || category === "women") return `Female Size ${size}`;
  if (category === "male" || category === "men") return `Male Size ${size}`;
  if (category === "toddler" || category === "kids") return `Toddler Size ${size}`;
  return `${raw.slice(0, spaceIdx)} Size ${size}`;
}

export interface ShoeKdsPlayer {
  name?: string | null;
  /** null / "" = own shoes → no KDS line for this bowler. */
  shoeSize?: string | null;
}

/**
 * Clears any existing shoe-size KDS line items on `orderId` and re-adds one
 * $0 line per player who has a shoe size (size in `name`, bowler in `note`).
 *
 * Best-effort by design — shoe KDS items are a convenience for shoe-desk /
 * kitchen staff, never a gate on the booking. Silently skips a missing,
 * canceled, or completed order; logs (never throws) on a failed update.
 *
 * The order's own `location_id` (read from the GET) is used for the PUT, so
 * callers don't have to know where the order lives.
 */
export async function syncShoeKdsLineItems(opts: {
  orderId: string;
  players: ShoeKdsPlayer[];
  /** Distinct per attempt — the PUT is a clear-then-set, idempotent in end-state. */
  idempotencyKey: string;
  /** Log-line prefix, e.g. "players" or "unified-reserve". */
  logLabel?: string;
}): Promise<void> {
  const { orderId, players, idempotencyKey, logLabel = "shoe-kds" } = opts;
  const shoePlayers = players.filter((p) => p.shoeSize);

  try {
    const sqOrderRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: sqHeaders(),
      cache: "no-store",
    });
    if (!sqOrderRes.ok) return;

    const sqOrderJson = (await sqOrderRes.json()) as {
      order?: {
        id: string;
        version: number;
        location_id: string;
        state: string;
        line_items?: Array<{ uid: string; catalog_object_id?: string }>;
      };
    };
    const sqOrder = sqOrderJson.order;
    if (!sqOrder || sqOrder.state === "CANCELED" || sqOrder.state === "COMPLETED") return;

    // Remove existing shoe-size KDS items, then add the current set.
    const existingShoeUids = (sqOrder.line_items ?? [])
      .filter((li) => li.catalog_object_id === SHOE_KDS_CATALOG_ID)
      .map((li) => li.uid);
    const fieldsToClear = existingShoeUids.map((uid) => `line_items[${uid}]`);
    const newShoeItems = shoePlayers.map((p) => ({
      catalog_object_id: SHOE_KDS_CATALOG_ID,
      quantity: "1",
      name: formatShoeSize(p.shoeSize!),
      note: p.name || undefined,
      base_price_money: { amount: 0, currency: "USD" },
    }));

    if (fieldsToClear.length === 0 && newShoeItems.length === 0) return;

    const updateRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
      method: "PUT",
      headers: sqHeaders(),
      body: JSON.stringify({
        order: {
          version: sqOrder.version,
          location_id: sqOrder.location_id,
          ...(newShoeItems.length > 0 ? { line_items: newShoeItems } : {}),
        },
        ...(fieldsToClear.length > 0 ? { fields_to_clear: fieldsToClear } : {}),
        idempotency_key: idempotencyKey,
      }),
    });
    if (!updateRes.ok) {
      const errBody = (await updateRes.json().catch(() => ({}))) as {
        errors?: Array<{ detail?: string }>;
      };
      console.warn(
        `[${logLabel}] shoe KDS sync failed for order=${orderId}:`,
        errBody.errors?.[0]?.detail ?? updateRes.status,
      );
    }
  } catch (err) {
    console.warn(
      `[${logLabel}] shoe KDS sync error for order=${orderId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
