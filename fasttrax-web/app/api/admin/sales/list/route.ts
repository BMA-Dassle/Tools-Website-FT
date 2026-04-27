import { NextRequest, NextResponse } from "next/server";
import { readSalesRange, type SaleEntry, type BookingType } from "@/lib/sales-log";

/**
 * GET /api/admin/sales/list
 *
 * Query params:
 *   from   YYYY-MM-DD (ET)  default = today
 *   to     YYYY-MM-DD (ET)  default = today
 *   limit  raw-entry cap, default 1000
 *
 * Returns:
 *   {
 *     range: { from, to, days },
 *     totals: { reservations, racers, racingReservations, attractionReservations,
 *               racePackReservations, mixedReservations },
 *     racing: {
 *       newRacers, returningRacers, expressLane,
 *       rookiePack: { count, pctOfNew },
 *       pov: { count, qty, attachRate, byNewRacer, byReturning },
 *       license: { count },
 *       addOnAttachRate,
 *       topRaceProducts: [{ name, count }],
 *     },
 *     attractions: {
 *       reservations,
 *       topAddOns: [{ name, count }],
 *     },
 *     entries: SaleEntry[],   // raw, newest first, paged to `limit`
 *   }
 *
 * Auth: gated by middleware (ADMIN_CAMERA_TOKEN on /api/admin/*).
 */

function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function pct(num: number, denom: number): number {
  if (!denom) return 0;
  return Math.round((num / denom) * 1000) / 10; // one decimal
}

interface CountedName {
  name: string;
  count: number;
}

function topByName(items: string[], limit = 10): CountedName[] {
  const m = new Map<string, number>();
  for (const x of items) {
    if (!x) continue;
    m.set(x, (m.get(x) || 0) + 1);
  }
  return Array.from(m.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const from = (searchParams.get("from") || todayET()).trim();
    const to = (searchParams.get("to") || todayET()).trim();
    const limit = Math.max(1, Math.min(5000, parseInt(searchParams.get("limit") || "1000", 10) || 1000));

    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: "Invalid from/to — use YYYY-MM-DD" }, { status: 400 });
    }
    if (to < from) {
      return NextResponse.json({ error: "to must be >= from" }, { status: 400 });
    }

    const all = await readSalesRange(from, to, { limitPerDay: 5000 });

    // ── Totals ──────────────────────────────────────────────────────
    const totals = {
      reservations: all.length,
      racers: all.reduce((s, e) => s + (e.participantCount ?? 0), 0),
      racingReservations: all.filter((e) => e.bookingType === "racing").length,
      racingPackReservations: all.filter((e) => e.bookingType === "racing-pack").length,
      attractionReservations: all.filter((e) => e.bookingType === "attractions").length,
      mixedReservations: all.filter((e) => e.bookingType === "mixed").length,
    };

    // ── Racing breakdown ────────────────────────────────────────────
    const racingAll = all.filter((e) => e.bookingType === "racing" || e.bookingType === "mixed");
    const racingNew = racingAll.filter((e) => e.isNewRacer === true);
    const racingReturning = racingAll.filter((e) => e.isNewRacer === false);
    const rookiePackCount = racingAll.filter((e) => e.rookiePack === true).length;
    const povCount = racingAll.filter((e) => e.povPurchased === true).length;
    const povQtySum = racingAll.reduce((s, e) => s + (e.povQty ?? 0), 0);
    const povNewRacer = racingAll.filter((e) => e.povPurchased && e.isNewRacer === true).length;
    const povReturning = racingAll.filter((e) => e.povPurchased && e.isNewRacer === false).length;
    const licenseCount = racingAll.filter((e) => e.licensePurchased === true).length;
    const expressLaneCount = racingAll.filter((e) => e.expressLane === true).length;
    // "Add-on attach" = racing booking that also had attraction line
    // items (mixed bookings + racing bookings whose addOnNames is set).
    const addOnAttachCount = racingAll.filter(
      (e) => (e.addOnNames?.length ?? 0) > 0 || e.bookingType === "mixed",
    ).length;

    const racing = {
      reservations: racingAll.length,
      newRacers: racingNew.length,
      returningRacers: racingReturning.length,
      expressLane: expressLaneCount,
      rookiePack: {
        count: rookiePackCount,
        pctOfNew: pct(rookiePackCount, racingNew.length),
        pctOfRacing: pct(rookiePackCount, racingAll.length),
      },
      pov: {
        count: povCount,
        qty: povQtySum,
        attachRate: pct(povCount, racingAll.length),
        byNewRacer: povNewRacer,
        byReturning: povReturning,
        attachRateNewRacer: pct(povNewRacer, racingNew.length),
        attachRateReturning: pct(povReturning, racingReturning.length),
      },
      license: {
        count: licenseCount,
      },
      addOnAttachCount,
      addOnAttachRate: pct(addOnAttachCount, racingAll.length),
      topRaceProducts: topByName(racingAll.flatMap((e) => e.raceProductNames || []), 10),
    };

    // ── Attractions breakdown ──────────────────────────────────────
    const attractionAll = all.filter(
      (e) => e.bookingType === "attractions" || e.bookingType === "mixed",
    );
    const attractions = {
      reservations: attractionAll.length,
      topAddOns: topByName(all.flatMap((e) => e.addOnNames || []), 10),
    };

    // ── Per-day breakdown for chart-ish rendering ──────────────────
    const byDay = new Map<string, { ymd: string; reservations: number; racers: number }>();
    for (const e of all) {
      const ymd = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(e.ts));
      const slot = byDay.get(ymd) || { ymd, reservations: 0, racers: 0 };
      slot.reservations += 1;
      slot.racers += e.participantCount ?? 0;
      byDay.set(ymd, slot);
    }
    const days = Array.from(byDay.values()).sort((a, b) => a.ymd.localeCompare(b.ymd));

    // ── Page out raw entries newest-first ──────────────────────────
    const entries = all.slice(0, limit);

    return NextResponse.json(
      {
        range: { from, to, days: days.length },
        totals,
        racing,
        attractions,
        byDay: days,
        entries,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[admin/sales/list]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sales" },
      { status: 500 },
    );
  }
}

// Re-export type so the client can import it without a separate barrel.
export type { SaleEntry, BookingType };
