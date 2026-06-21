import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { ensureBowlingSchema } from "@/lib/bowling-db";
import { patchReservation } from "@/lib/qamf-bowling";

/**
 * POST /api/admin/bowling/backfill-memo?token=...
 *
 * Backfills QAMF reservation memos for all upcoming non-cancelled
 * reservations with the updated format:
 *   - Line items summary
 *   - Tax-inclusive deposit
 *   - Shoe status (paid / included / ⚠ NOT INCLUDED)
 *   - Short URL to confirmation page
 *
 * Auth: ADMIN_CAMERA_TOKEN query param.
 *
 * Body (optional):
 *   { dryRun?: boolean }   — preview changes without patching QAMF
 */

const CENTER_CODE_TO_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

/** Slugs / labels whose base price includes shoe rental. */
const SHOES_INCLUDED_RE = /fun\s*4\s*all|pizza\s*bowl/i;

/** Labels for the Pizza Bowl package (has a kitchen pizza component). */
const PIZZA_BOWL_RE = /pizza\s*bowl/i;
/** The cookable "Pizza Bowl Pizza" item. Its presence on the day-of Square
 *  order means the pizza/soda fired to the kitchen KDS; absence means the
 *  online order missed the food line and the pizza must be taken manually. */
const PIZZA_BOWL_PIZZA_CATALOG_ID = "2IKZB4O2HQBXWMTSUQ2SEKJY";
const SQUARE_ORDERS_BASE = "https://connect.squareup.com/v2/orders";

function squareHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN ?? ""}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
}

/** square_dayof_order_id may be a bare id or a JSON array (combo legs). */
function firstOrderId(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return String(parsed[0]);
  } catch {
    /* bare id — fall through */
  }
  return raw;
}

interface SquareLineItem {
  catalog_object_id?: string;
  note?: string;
}

/**
 * Pizza-status line for a Pizza Bowl reservation, read from the day-of Square
 * order. Returns the kitchen memo line so staff see — right under the shoe
 * line — whether the pizza fired to the KDS (with toppings) or must be taken
 * manually. On any fetch failure we conservatively flag MANUAL.
 */
async function pizzaStatusLine(rawOrderId: string | null): Promise<string> {
  const MANUAL = "** TAKE PIZZA ORDER MANUALLY — not sent to kitchen **";
  const orderId = firstOrderId(rawOrderId);
  if (!orderId) return MANUAL;
  try {
    const res = await fetch(`${SQUARE_ORDERS_BASE}/${orderId}`, {
      headers: squareHeaders(),
      cache: "no-store",
    });
    if (!res.ok) return MANUAL;
    const order = ((await res.json()) as { order?: { line_items?: SquareLineItem[] } }).order;
    const pizzas = (order?.line_items ?? []).filter(
      (li) => li.catalog_object_id === PIZZA_BOWL_PIZZA_CATALOG_ID,
    );
    if (pizzas.length === 0) return MANUAL;
    const toppings = pizzas
      .map((li) => li.note)
      .filter((n): n is string => !!n)
      .join(" | ");
    return `PIZZA → KITCHEN${toppings ? `: ${toppings}` : ""}`;
  } catch {
    return MANUAL;
  }
}

interface ReservationRow {
  id: number;
  center_code: string;
  qamf_reservation_id: string | null;
  deposit_cents: number;
  total_cents: number;
  status: string;
  booked_at: string;
  player_count: number | null;
  guest_name: string | null;
  notes: string | null;
  short_code: string | null;
  square_dayof_order_id: string | null;
}

interface LineRow {
  reservation_id: number;
  label: string;
  quantity: number;
  unit_price_cents: number;
  product_kind: string | null;
}

export async function POST(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let dryRun = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
    dryRun = body.dryRun === true;
  } catch {
    // No body — defaults are fine
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DB not configured" }, { status: 500 });
  }
  await ensureBowlingSchema();
  const q = sql();

  // Fetch all upcoming non-cancelled reservations with a QAMF ID
  const reservations = (await q`
    SELECT id, center_code, qamf_reservation_id, deposit_cents, total_cents,
           status, booked_at, player_count, guest_name, notes, short_code,
           square_dayof_order_id
    FROM bowling_reservations
    WHERE status != 'cancelled'
      AND booked_at >= NOW() - INTERVAL '1 day'
      AND qamf_reservation_id IS NOT NULL
    ORDER BY booked_at ASC
  `) as unknown as ReservationRow[];

  if (reservations.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, message: "No upcoming reservations found" });
  }

  // Fetch all lines for these reservations, joined with products for product_kind
  const resIds = reservations.map((r) => r.id);
  const lines = (await q`
    SELECT brl.reservation_id, brl.label, brl.quantity, brl.unit_price_cents,
           bsp.product_kind
    FROM bowling_reservation_lines brl
    LEFT JOIN bowling_square_products bsp ON bsp.id = brl.square_product_id
    WHERE brl.reservation_id = ANY(${resIds})
    ORDER BY brl.reservation_id, brl.id
  `) as unknown as LineRow[];

  // Group lines by reservation
  const linesByRes = new Map<number, LineRow[]>();
  for (const l of lines) {
    const arr = linesByRes.get(l.reservation_id) ?? [];
    arr.push(l);
    linesByRes.set(l.reservation_id, arr);
  }

  const results: Array<{
    neonId: number;
    guestName: string | null;
    memo: string;
    patched: boolean;
    error?: string;
  }> = [];

  for (const res of reservations) {
    const resLines = linesByRes.get(res.id) ?? [];
    const parts: string[] = [];

    // Shoe status + short URL — first line so staff see it at a glance
    const hasShoeAddOn = resLines.some((l) => l.product_kind === "addon_shoe");
    const shoesIncludedInExperience = resLines.some((l) => SHOES_INCLUDED_RE.test(l.label));
    let shoeLine: string;
    if (hasShoeAddOn) {
      const shoeQty = resLines
        .filter((l) => l.product_kind === "addon_shoe")
        .reduce((s, l) => s + l.quantity, 0);
      shoeLine = `${shoeQty} pair${shoeQty !== 1 ? "s" : ""} shoes paid`;
    } else if (shoesIncludedInExperience) {
      shoeLine = "Shoes included";
    } else {
      shoeLine = "SHOES NOT INCLUDED";
    }
    if (res.short_code) {
      shoeLine += ` | headpinz.com/s/${res.short_code}`;
    }
    parts.push(shoeLine);

    // Pizza status — right under the shoe line so staff see at a glance whether
    // the pizza fired to the kitchen KDS (with toppings) or must be taken
    // manually. Only for Pizza Bowl packages; reads the day-of Square order.
    const isPizzaBowl = resLines.some((l) => PIZZA_BOWL_RE.test(l.label));
    if (isPizzaBowl) {
      parts.push(await pizzaStatusLine(res.square_dayof_order_id));
    }

    // Line items summary
    if (resLines.length > 0) {
      const itemParts = resLines.map((l) => {
        const total = l.quantity * l.unit_price_cents;
        const totalStr = `$${(total / 100).toFixed(2)}`;
        return l.quantity > 1 ? `${l.quantity}x ${l.label} ${totalStr}` : `${l.label} ${totalStr}`;
      });
      parts.push(itemParts.join(" + "));
    }

    // Tax-inclusive deposit
    if (res.deposit_cents > 0) {
      parts.push(`Deposit $${(res.deposit_cents / 100).toFixed(2)} paid (incl. tax)`);
    }

    // User-supplied notes
    if (res.notes) parts.push(res.notes);

    const memo = parts.join("\n");

    let patched = false;
    let error: string | undefined;

    if (!dryRun) {
      const centerId = CENTER_CODE_TO_ID[res.center_code];
      if (centerId && res.qamf_reservation_id) {
        try {
          const title = `${res.guest_name || "Guest"} (${res.player_count ?? 0}p)`;
          await patchReservation(centerId, res.qamf_reservation_id, { Title: title, Notes: memo });
          patched = true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      } else {
        error = `No centerId mapping for ${res.center_code}`;
      }
    }

    results.push({
      neonId: res.id,
      guestName: res.guest_name,
      memo,
      patched,
      error,
    });
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    updated: results.filter((r) => r.patched).length,
    total: results.length,
    results,
  });
}
