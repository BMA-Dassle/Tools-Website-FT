import { NextRequest, NextResponse } from "next/server";
import { isAdminApiRequest } from "@/lib/admin-request-auth";
import { centreCodeFor, readReservationGrid } from "~/features/reservations-admin/grid.server";

/**
 * `GET /api/admin/bowling/reservations/grid?token=…&date=YYYY-MM-DD&center=…`
 *
 * The lane / track grid behind the reservations board's Grid view: one row per
 * lane (bowling centres) or per Office resource (FastTrax), with every occupied
 * stretch the VENDOR knows about — leagues, maintenance, front-desk bookings and
 * Conqueror walk-ins included, none of which reach `bowling_reservations`.
 *
 * It deliberately returns vendor truth ALONE and does not join our reservations
 * onto it. The board already holds today's rows and re-polls them every 10 s; it
 * matches `LaneBlock.reservationId` against its own `qamfReservationId`s on the
 * client. Joining here would mean a second read of the same rows, and a grid
 * that went stale a poll behind the list sitting beneath it.
 *
 * Auth is `isAdminApiRequest` — the board hands its client a SIGNED 8-hour
 * token (`mintAdminApiToken`), not `ADMIN_CAMERA_TOKEN`. Defence in depth behind
 * the middleware, exactly like its sibling `../route.ts`.
 *
 * READ ONLY.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token") ?? "";
  if (!(await isAdminApiRequest(req, { token }))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const date = searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date param required (YYYY-MM-DD)" }, { status: 400 });
  }

  const center = searchParams.get("center") ?? "";
  const centre = centreCodeFor(center);
  if (!centre) {
    // The grid is per-centre by construction: lanes belong to one building.
    // The board picks one before asking, so an absent centre is a caller bug,
    // not an empty night.
    return NextResponse.json(
      { error: "center param required (a Square location code or centre slug)" },
      { status: 400 },
    );
  }

  const refresh = searchParams.get("refresh") === "1";
  const grid = await readReservationGrid(centre, date, { refresh });
  return NextResponse.json(grid, {
    // Never let a CDN or the browser hold a lane grid: it is 60 s fresh at best
    // and staff act on it at the desk.
    headers: { "Cache-Control": "no-store" },
  });
}
