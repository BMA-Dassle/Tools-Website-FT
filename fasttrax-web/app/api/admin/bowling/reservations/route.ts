import { NextRequest, NextResponse } from "next/server";
import { listBowlingReservations } from "@/lib/bowling-db";
import { shortenUrl } from "@/lib/short-url";

/**
 * GET /api/admin/bowling/reservations?token=...&date=YYYY-MM-DD&center=...
 *
 * Returns all bowling reservations for the given date.
 * Each reservation includes a `shortCode` for the confirmation page
 * (generated on demand, no neonId exposed in URLs).
 *
 * Auth: ADMIN_CAMERA_TOKEN query param.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const date = searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "date param required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  const center = searchParams.get("center") || undefined;

  try {
    const reservations = await listBowlingReservations({
      startDate: date,
      endDate: date,
      centerCode: center,
    });

    // Generate short codes for confirmation links (parallel)
    const withCodes = await Promise.all(
      reservations.map(async (r) => {
        const confirmBase =
          r.productKind === "kbf"
            ? "/hp/book/kids-bowl-free/confirmation"
            : "/hp/book/bowling/confirmation";
        let shortCode: string | undefined;
        try {
          shortCode = await shortenUrl(`${confirmBase}?neonId=${r.id}`);
        } catch {
          // Non-fatal — client falls back to no link
        }
        return { ...r, shortCode };
      }),
    );

    return NextResponse.json({ reservations: withCodes });
  } catch (err) {
    console.error("[admin/bowling/reservations]", err);
    return NextResponse.json(
      { error: "Failed to load reservations" },
      { status: 500 },
    );
  }
}
