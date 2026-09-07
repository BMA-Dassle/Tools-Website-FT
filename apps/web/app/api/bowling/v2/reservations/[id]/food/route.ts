import { NextRequest, NextResponse } from "next/server";
import { applyFoodEdit, resolveReservationFood } from "~/features/package-food/service";
import type { LaneSelections } from "~/features/booking/service/food-config";

/**
 * Guest self-service for a booked package's food (Pizza Bowl pizza + pitcher).
 *
 * GET  /api/bowling/v2/reservations/[id]/food
 *   The picker as the booking step would show it — configured items with their
 *   live Square groups, the current picks per lane (read back from our own
 *   stored lines), whether it is complete, what is already paid in extras, and
 *   whether the guest may edit right now. Used by the confirmation page, the
 *   web check-in page and the kiosk lane-open panel.
 *
 * PATCH /api/bowling/v2/reservations/[id]/food
 *   Body: { selections: LaneSelections[] }
 *   Allowed until the LANE OPENS (owner 2026-09-06), not until the booked time.
 *   INCLUDED PICKS ONLY — nothing that adds money to the bill (owner
 *   2026-09-06); the service refuses a non-zero extras total, and an order that
 *   already carries paid extras is not editable here.
 *
 * Thin shell: parse → delegate to ~/features/package-food/service (the one
 * writer, shared with the admin route and the check-in gate).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const neonId = parseInt(id, 10);
  if (isNaN(neonId) || neonId < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const state = await resolveReservationFood(neonId);
    if (!state) return NextResponse.json({ error: "reservation not found" }, { status: 404 });
    // Everything here is the guest's own booking; nothing staff-only.
    return NextResponse.json(state);
  } catch (err) {
    console.error(`[food] GET neonId=${neonId} failed:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load food options" }, { status: 502 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const neonId = parseInt(id, 10);
  if (isNaN(neonId) || neonId < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  let body: { selections?: LaneSelections[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.selections)) {
    return NextResponse.json({ error: "selections required" }, { status: 400 });
  }
  try {
    const result = await applyFoodEdit({ neonId, selections: body.selections, actor: "guest" });
    if (!result.ok) {
      const { status, ...rest } = result;
      return NextResponse.json(rest, { status });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error(
      `[food] PATCH neonId=${neonId} failed:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "could not update your order" }, { status: 502 });
  }
}
