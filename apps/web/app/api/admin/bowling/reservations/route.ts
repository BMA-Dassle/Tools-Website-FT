import { NextRequest, NextResponse } from "next/server";
import { listBowlingReservations, updateBowlingReservationShortCode } from "@/lib/bowling-db";
import { getSurveysForReservations } from "@/lib/guest-survey-db";
import { shortenUrl } from "@/lib/short-url";

/**
 * GET /api/admin/bowling/reservations?token=...&date=YYYY-MM-DD&center=...
 *
 * Returns all bowling reservations for the given date.
 * Each reservation includes a `shortCode` for the confirmation page,
 * read from the stored short_code column. Legacy rows that pre-date
 * the column get a code generated + backfilled on first access.
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
    return NextResponse.json({ error: "date param required (YYYY-MM-DD)" }, { status: 400 });
  }

  const center = searchParams.get("center") || undefined;

  try {
    const reservations = await listBowlingReservations({
      startDate: date,
      endDate: date,
      centerCode: center,
    });

    // Backfill short codes for legacy rows that don't have one stored yet
    const withCodes = await Promise.all(
      reservations.map(async (r) => {
        if (r.shortCode) return r; // already stored — use as-is

        // Legacy row — generate + persist so future reads don't regenerate
        const confirmBase =
          r.productKind === "kbf"
            ? "/hp/book/kids-bowl-free/confirmation"
            : "/hp/book/bowling/confirmation";
        try {
          const code = await shortenUrl(`${confirmBase}?neonId=${r.id}`);
          // Fire-and-forget persist to Neon
          updateBowlingReservationShortCode(r.id, code).catch(() => {});
          return { ...r, shortCode: code };
        } catch {
          return r; // non-fatal
        }
      }),
    );

    // Attach guest-survey snapshot per reservation (one batch query, no
    // N+1). Reservations without a survey row return `survey: null`.
    const surveyMap = await getSurveysForReservations(withCodes.map((r) => r.id));
    const enriched = withCodes.map((r) => ({
      ...r,
      survey: surveyMap.get(String(r.id)) ?? null,
    }));

    return NextResponse.json({ reservations: enriched });
  } catch (err) {
    console.error("[admin/bowling/reservations]", err);
    return NextResponse.json({ error: "Failed to load reservations" }, { status: 500 });
  }
}
