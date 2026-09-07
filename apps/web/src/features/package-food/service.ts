/**
 * Package food on a BOOKED reservation — the one writer (server only).
 *
 * Every surface that shows or changes a Pizza Bowl's pizza + drink after
 * booking goes through here: the confirmation page's editor, the web and kiosk
 * "open lane" gates, and the reservation-admin card. Before 2026-09-06 the guest
 * route hardcoded two catalog ids and an EditPizzaPanel hardcoded them again;
 * this reads the experience's configured food instead, so a new package (NFL
 * wings) is a seed row here too.
 *
 * MONEY: NONE. Owner 2026-09-06 — "to keep this simple don't allow edits to
 * anything that adds money to the bill. Just do the required included." A
 * post-booking edit may only change the picks the package already paid for
 * (the included topping, the drink). Priced options are never offered, and the
 * edit is MERGED over the stored picks: the new $0 picks replace the old $0
 * picks, and every paid extra already on the order is carried over untouched
 * (owner: "for this one just don't show extras"). An edit whose extras total
 * would rise is refused.
 *
 * Order of operations on an edit: validate → PERSIST TO NEON → update the
 * Square order. Neon first because our DB is the source of truth for what the
 * guest told us; the Square order is the downstream copy (CLAUDE.md § persist
 * guest input at capture). A failed Square PUT is logged loudly and reported,
 * never silently dropped.
 */
import { getBowlingReservation, getBowlingExperiences } from "@/lib/bowling-db";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { sql } from "@/lib/db";
import {
  buildFoodRawItems,
  configurableFoodItems,
  extraCentsTotal,
  foodSelectionIssue,
  mergeFreePicks,
  missingRequiredFoodLines,
  type FoodItem,
  type LaneSelections,
} from "~/features/booking/service/food-config";
import { rawFoodItemsToReservationLines } from "~/features/booking/service/reservation-lines";
import { fetchModifierGroupsForCatalogObject } from "./catalog";
import {
  extrasCentsFromLines,
  parseFoodLineLabel,
  rawItemsFromStoredLines,
  selectionsFromStoredLines,
} from "./lines";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** square_dayof_order_id may be a bare id or a JSON array (combo legs). */
function firstOrderId(raw?: string): string | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length) return String(p[0]);
  } catch {
    /* bare id */
  }
  return raw;
}

interface SquareLineItem {
  uid: string;
  name?: string;
  note?: string;
  quantity?: string;
  catalog_object_id?: string;
  base_price_money?: { amount?: number };
}
interface SquareOrder {
  state?: string;
  version?: number;
  location_id?: string;
  line_items?: SquareLineItem[];
}

async function fetchOrder(orderId: string): Promise<SquareOrder | null> {
  const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    headers: sqHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const order = ((await res.json()) as { order?: SquareOrder }).order;
  return order && order.version != null ? order : null;
}

/* ───────────────────────────── resolve ───────────────────────────── */

export interface ReservationFoodState {
  neonId: number;
  status: string;
  centerCode: string;
  laneCount: number;
  /** The lane-open processor has run (kitchen has the ticket). */
  laneOpen: boolean;
  orderId: string | null;
  /** [] = this package has no guest-configured food. Full groups, priced
   *  options included — the editor strips those (withoutPaidOptions). */
  foodItems: FoodItem[];
  /** Prefill, one entry per lane. */
  selections: LaneSelections[];
  /** Every included pick made on every lane (trivially true with no food). */
  complete: boolean;
  /** Why not complete, guest-readable; null when complete. */
  issue: string | null;
  /** Paid extras already on the booking (cents). Informational — they are
   *  carried over untouched by an edit, never re-offered, never refunded. */
  paidExtrasCents: number;
  /** May the GUEST change this right now? */
  guestEditable: { ok: true } | { ok: false; reason: string };
  /** May STAFF change this right now? (No time limit — lane open or not.) */
  adminEditable: { ok: true } | { ok: false; reason: string };
}

/** Experience for a reservation: by the slug stamped at booking, else by the
 *  primary item's label appearing among the stored lines. */
function experienceFor(
  reservation: { bookingMetadata?: Record<string, unknown>; lines: { label: string }[] },
  experiences: BowlingExperienceWithDetails[],
): BowlingExperienceWithDetails | undefined {
  const meta = (reservation.bookingMetadata?.bowling ?? {}) as { experienceSlug?: string };
  if (meta.experienceSlug) {
    const bySlug = experiences.find((e) => e.slug === meta.experienceSlug);
    if (bySlug) return bySlug;
  }
  const labels = new Set(reservation.lines.map((l) => l.label));
  return experiences.find((e) =>
    (e.items ?? []).some((i) => i.sortOrder === 0 && labels.has(i.label)),
  );
}

function laneCountFor(reservation: { bookingMetadata?: Record<string, unknown> }): number {
  const meta = (reservation.bookingMetadata?.bowling ?? {}) as { laneCount?: number };
  if (meta.laneCount && meta.laneCount > 0) return Math.round(meta.laneCount);
  return 1;
}

/**
 * Catalog-free completeness: does the booking carry a noted line per configured
 * item per lane? This is what the check-in gate asks — it must answer without a
 * Square round-trip so a catalog hiccup can never hold a lane hostage.
 */
export async function reservationFoodIssue(neonId: number): Promise<string | null> {
  const reservation = await getBowlingReservation(neonId);
  if (!reservation) return null;
  const experiences = await getBowlingExperiences(reservation.centerCode);
  const exp = experienceFor(reservation, experiences);
  const items = configurableFoodItems(exp?.items);
  if (items.length === 0) return null;
  return missingRequiredFoodLines({
    items,
    laneCount: laneCountFor(reservation),
    rawItems: rawItemsFromStoredLines(items, reservation.lines),
  });
}

/** Full picture for an editor: config + live groups + prefill + editability. */
export async function resolveReservationFood(neonId: number): Promise<ReservationFoodState | null> {
  const reservation = await getBowlingReservation(neonId);
  if (!reservation) return null;

  const laneCount = laneCountFor(reservation);
  const laneOpen = !!reservation.dayofOrderSentAt;
  const orderId = firstOrderId(reservation.squareDayofOrderId);
  const experiences = await getBowlingExperiences(reservation.centerCode);
  const exp = experienceFor(reservation, experiences);
  const configured = configurableFoodItems(exp?.items);

  // Live groups per item. A configured item with no groups is a broken catalog
  // link — surfaced as an error (callers answer 502 / retry), never as "nothing
  // to pick", because the package says there IS something to pick.
  const foodItems: FoodItem[] = await Promise.all(
    configured.map(async (ci) => ({
      catalogObjectId: ci.squareCatalogObjectId,
      name: ci.label,
      includedModifierCount: ci.includedModifierCount ?? 1,
      extraModifierCents: ci.extraModifierCents ?? 0,
      groups: await fetchModifierGroupsForCatalogObject(ci.squareCatalogObjectId),
    })),
  );
  if (foodItems.some((f) => f.groups.length === 0)) {
    throw new Error(`configured food item has no modifier groups (reservation ${neonId})`);
  }

  const selections = selectionsFromStoredLines({ foodItems, lines: reservation.lines, laneCount });
  const issue =
    foodItems.length === 0 ? null : foodSelectionIssue({ foodItems, selections, laneCount });

  // Paid extras on the booking: our own extras rows, plus whatever the stored
  // picks would cost against the live catalog (a $2 bacon written at booking).
  const paidExtrasCents =
    extrasCentsFromLines(
      reservation.lines.map((l) => ({
        label: l.label,
        quantity: l.quantity,
        unitCents: l.unitPriceCents,
      })),
    ) + (foodItems.length ? extraCentsTotal({ foodItems, selections, laneCount }) : 0);

  let guestEditable: ReservationFoodState["guestEditable"] = { ok: true };
  let adminEditable: ReservationFoodState["adminEditable"] = { ok: true };
  if (reservation.status === "cancelled") {
    guestEditable = adminEditable = { ok: false, reason: "reservation is cancelled" };
  } else if (!orderId) {
    guestEditable = adminEditable = { ok: false, reason: "no day-of order on file" };
  } else if (reservation.status !== "confirmed" && reservation.status !== "confirm_pending") {
    guestEditable = { ok: false, reason: `not editable (status ${reservation.status})` };
  } else if (laneOpen) {
    guestEditable = { ok: false, reason: "your lane is already open — see staff" };
  }

  return {
    neonId,
    status: reservation.status,
    centerCode: reservation.centerCode,
    laneCount,
    laneOpen,
    orderId,
    foodItems,
    selections,
    complete: issue === null,
    issue,
    paidExtrasCents,
    guestEditable,
    adminEditable,
  };
}

/* ───────────────────────────── apply ───────────────────────────── */

export type FoodEditResult =
  | { ok: true; squareUpdated: boolean }
  | { ok: false; status: number; error: string; code?: string };

export async function applyFoodEdit(args: {
  neonId: number;
  selections: LaneSelections[];
  actor: "guest" | "admin";
}): Promise<FoodEditResult> {
  const { neonId, actor } = args;
  const state = await resolveReservationFood(neonId);
  if (!state) return { ok: false, status: 404, error: "reservation not found" };
  if (state.foodItems.length === 0) {
    return { ok: false, status: 409, error: "this package has no food to configure" };
  }
  const gate = actor === "admin" ? state.adminEditable : state.guestEditable;
  if (!gate.ok) return { ok: false, status: 409, error: gate.reason, code: "not_editable" };

  const { foodItems, laneCount } = state;
  // Included-only edit merged over what is stored: new $0 picks replace old $0
  // picks; every PAID pick already on the order is kept exactly as it was
  // (owner 2026-09-06 — never re-offer extras, never lose the ones they bought).
  const selections = mergeFreePicks({
    stored: state.selections,
    submitted: args.selections ?? [],
    foodItems,
    laneCount,
  });
  const issue = foodSelectionIssue({ foodItems, selections, laneCount });
  if (issue) return { ok: false, status: 400, error: issue, code: "food_incomplete" };

  // Nothing that adds money (owner 2026-09-06). The merge keeps paid extras and
  // drops priced ids from the submission, so the total can only stay or fall.
  const before = extraCentsTotal({ foodItems, selections: state.selections, laneCount });
  const after = extraCentsTotal({ foodItems, selections, laneCount });
  if (after > before) {
    return {
      ok: false,
      status: 400,
      error: "Changes here can't add paid extras — see the front desk for those.",
      code: "paid_extras_refused",
    };
  }

  const rawItems = buildFoodRawItems({ foodItems, selections, laneCount });

  // ── PERSIST TO NEON — before Square, because ours is the record ──
  // Only the food rows are replaced; an extras row (there is none when we get
  // here, by the gate above) or anything else on the reservation is untouched.
  const itemLabels = foodItems.map((f) => f.name);
  const q = sql();
  const existing = (await q`
    SELECT id, label FROM bowling_reservation_lines WHERE reservation_id = ${neonId}
  `) as { id: number; label: string }[];
  const staleIds = existing
    .filter((l) => parseFoodLineLabel(l.label, itemLabels) !== null)
    .map((l) => l.id);
  if (staleIds.length > 0) {
    await q`DELETE FROM bowling_reservation_lines WHERE id = ANY(${staleIds})`;
  }
  for (const line of rawFoodItemsToReservationLines(rawItems)) {
    await q`
      INSERT INTO bowling_reservation_lines (reservation_id, label, quantity, unit_price_cents)
      VALUES (${neonId}, ${line.label}, ${line.quantity}, 0)
    `;
  }

  // ── Update the Square order: notes by uid, add missing, clear surplus ──
  const order = state.orderId ? await fetchOrder(state.orderId) : null;
  if (!order) {
    console.error(`[package-food] neonId=${neonId} could not load order; Neon updated`);
    return {
      ok: false,
      status: 502,
      error: "order update failed — your choices are saved with us; see staff at the lane",
      code: "order_update_failed",
    };
  }
  if (order.state !== "OPEN") {
    // Neon holds the truth; a COMPLETED/CANCELED order cannot take notes.
    return {
      ok: false,
      status: 409,
      error: `order not editable (state ${order.state}) — your choices are saved with us; see staff`,
      code: "order_not_open",
    };
  }
  const items = order.line_items ?? [];
  // The lane-open processor prefixes kitchen notes with "Lane N | " when the
  // lane goes Running. An edit that lands after that (staff, or a guest racing
  // it) must keep the prefix — the KDS reads it as the lane.
  const withLanePrefix = (existingNote: string | undefined, note: string) => {
    const prefix = existingNote?.match(/^Lanes? [\d, ]+ \| /)?.[0] ?? "";
    return `${prefix}${note}`;
  };
  const lineItemWrites: Array<Record<string, unknown>> = [];
  const fieldsToClear: string[] = [];
  for (const food of foodItems) {
    const current = items.filter((li) => li.catalog_object_id === food.catalogObjectId);
    const wanted = rawItems.filter((ri) => ri.catalogObjectId === food.catalogObjectId);
    wanted.forEach((ri, i) => {
      const li = current[i];
      if (li) lineItemWrites.push({ uid: li.uid, note: withLanePrefix(li.note, ri.note ?? "") });
      else
        lineItemWrites.push({
          catalog_object_id: ri.catalogObjectId,
          quantity: String(ri.quantity),
          ...(ri.note ? { note: ri.note } : {}),
        });
    });
    // A party that shrank leaves surplus lines — remove them so the kitchen
    // does not make a pizza for a lane that no longer exists.
    for (const li of current.slice(wanted.length)) fieldsToClear.push(`line_items[${li.uid}]`);
  }

  const putRes = await fetch(`${SQUARE_BASE}/orders/${state.orderId}`, {
    method: "PUT",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `food-edit-${neonId}-${order.version}-${Date.now()}`,
      order: {
        location_id: order.location_id,
        version: order.version,
        line_items: lineItemWrites,
      },
      ...(fieldsToClear.length ? { fields_to_clear: fieldsToClear } : {}),
    }),
  });
  if (!putRes.ok) {
    const errBody = (await putRes.json().catch(() => ({}))) as { errors?: { detail?: string }[] };
    // Neon already holds the guest's choices (recoverable); surface loudly.
    console.error(
      `[package-food] neonId=${neonId} order PUT failed; Neon updated:`,
      errBody.errors?.[0]?.detail ?? putRes.status,
    );
    return {
      ok: false,
      status: 502,
      error: "order update failed — your choices are saved with us; see staff at the lane",
      code: "order_update_failed",
    };
  }

  return { ok: true, squareUpdated: true };
}
