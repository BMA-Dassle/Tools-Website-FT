import { NextRequest, NextResponse } from "next/server";
import { isAdminApiRequest } from "@/lib/admin-request-auth";
import { applyFoodEdit, resolveReservationFood } from "~/features/package-food/service";
import type { LaneSelections } from "~/features/booking/service/food-config";

/**
 * Staff edit of a booked package's food (Pizza Bowl pizza + pitcher) from the
 * reservation-admin board — owner 2026-09-06: "in reservation admin we should
 * be able to edit as well."
 *
 * GET   /api/admin/reservations/food?token=…&id=<neonId>   — same picture the guest sees
 * PATCH /api/admin/reservations/food?token=…&id=<neonId>   — body { selections }
 *
 * Staff have NO time restriction: an edit after the lane opens still updates
 * the Square order's notes, which the KDS reflects. Staff never charge a card
 * from here — extras above what was paid are added to the order unpaid and
 * collected at the lane.
 */
function neonIdFrom(req: NextRequest): number | null {
  const id = parseInt(req.nextUrl.searchParams.get("id") ?? "", 10);
  return isNaN(id) || id < 1 ? null : id;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!(await isAdminApiRequest(req, { token }))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const neonId = neonIdFrom(req);
  if (!neonId) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  try {
    const state = await resolveReservationFood(neonId);
    if (!state) return NextResponse.json({ error: "reservation not found" }, { status: 404 });
    return NextResponse.json(state);
  } catch (err) {
    console.error(
      `[admin/food] GET neonId=${neonId} failed:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "could not load food options" }, { status: 502 });
  }
}

export async function PATCH(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!(await isAdminApiRequest(req, { token }))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const neonId = neonIdFrom(req);
  if (!neonId) return NextResponse.json({ error: "invalid id" }, { status: 400 });
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
    const result = await applyFoodEdit({ neonId, selections: body.selections, actor: "admin" });
    if (!result.ok) {
      const { status, ...rest } = result;
      return NextResponse.json(rest, { status });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error(
      `[admin/food] PATCH neonId=${neonId} failed:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "could not update the order" }, { status: 502 });
  }
}
