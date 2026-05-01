import { NextRequest, NextResponse } from "next/server";
import { readSalesRange, readDailyTotals, type SaleEntry, type BookingType } from "@/lib/sales-log";
import { listMatchesInRange } from "@/lib/video-match";

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

    const all = await readSalesRange(from, to, { limit: 5000 });

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

    // Generic package breakdown — count by packageId across ALL racing entries.
    // Includes backwards-compat: old rows that only have rookiePack=true will
    // have packageId synthesized to "rookie-pack" by rowToEntry().
    const packageMap = new Map<string, number>();
    for (const e of racingAll) {
      if (e.packageId) {
        packageMap.set(e.packageId, (packageMap.get(e.packageId) ?? 0) + 1);
      }
    }
    const PACKAGE_LABELS: Record<string, string> = {
      "rookie-pack": "Rookie Pack",
      "ultimate-qualifier-mega": "Ultimate Qualifier",
    };
    const packagesByType = Array.from(packageMap.entries())
      .map(([id, count]) => ({
        id,
        label: PACKAGE_LABELS[id] ?? id,
        count,
        pctOfRacing: pct(count, racingAll.length),
      }))
      .sort((a, b) => b.count - a.count);
    const povCount = racingAll.filter((e) => e.povPurchased === true).length;
    const povQtySum = racingAll.reduce((s, e) => s + (e.povQty ?? 0), 0);
    const povNewRacer = racingAll.filter((e) => e.povPurchased && e.isNewRacer === true).length;
    const povReturning = racingAll.filter((e) => e.povPurchased && e.isNewRacer === false).length;

    // POV by race tier — inferred from verbatim product names
    function inferTier(e: SaleEntry): "Starter" | "Intermediate" | "Pro" | null {
      const names = (e.raceProductNames ?? []).join(" ").toLowerCase();
      if (!names) return null;
      if (names.includes("pro")) return "Pro";
      if (names.includes("intermediate")) return "Intermediate";
      if (names.includes("starter")) return "Starter";
      return null;
    }
    const POV_TIERS = ["Starter", "Intermediate", "Pro"] as const;
    const povByTier = POV_TIERS.map((tier) => {
      const inTier = racingAll.filter((e) => inferTier(e) === tier);
      const povInTier = inTier.filter((e) => e.povPurchased === true);
      return { tier, racingCount: inTier.length, povCount: povInTier.length, attachRate: pct(povInTier.length, inTier.length) };
    }).filter((t) => t.racingCount > 0);

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
      // Legacy field — kept for backwards compat with existing dashboard reads.
      rookiePack: {
        count: rookiePackCount,
        pctOfNew: pct(rookiePackCount, racingNew.length),
        pctOfRacing: pct(rookiePackCount, racingAll.length),
      },
      // Generic packages breakdown — one entry per packageId found in the range.
      packages: {
        total: packageMap.size > 0 ? Array.from(packageMap.values()).reduce((s, c) => s + c, 0) : 0,
        byType: packagesByType,
      },
      pov: {
        count: povCount,
        qty: povQtySum,
        attachRate: pct(povCount, racingAll.length),
        byNewRacer: povNewRacer,
        byReturning: povReturning,
        attachRateNewRacer: pct(povNewRacer, racingNew.length),
        attachRateReturning: pct(povReturning, racingReturning.length),
        byTier: povByTier,
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

    // ── Video post-sale data (from Redis video-match log) ──────────
    // Fetch video matches whose `matchedAt` falls in the same ET day
    // window. Indexed by matchedAt (the moment the cron linked the
    // video to the racer), which is close enough to race day for
    // dashboard purposes.
    //
    // Helper: YYYY-MM-DD (ET) → epoch ms for the start of that day.
    // Uses Intl to resolve the actual UTC offset (handles DST).
    function etDayStartMs(ymd: string): number {
      const probe = new Date(`${ymd}T12:00:00.000Z`);
      const etHour = parseInt(
        probe.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }),
        10,
      );
      // utcOffset is how many hours ET is BEHIND UTC (4 for EDT, 5 for EST)
      const utcOffset = 12 - etHour;
      return new Date(`${ymd}T00:00:00.000Z`).getTime() + utcOffset * 3_600_000;
    }

    const videoStartMs = etDayStartMs(from);
    const videoEndMs   = etDayStartMs(to) + 86_400_000 - 1; // end of `to` day in ET

    const videoMatches = await listMatchesInRange({
      startMs: videoStartMs,
      endMs:   videoEndMs,
      limit:   2000,
    }).catch(() => []); // non-fatal — sales page must not break if Redis is down

    // Exclude blocked and manual-send synthetics
    const realMatches = videoMatches.filter(
      (m) => String(m.sessionId) !== "manual" && !m.blocked,
    );

    const videoTotal     = realMatches.length;
    const videoPurchased = realMatches.filter((m) => m.purchased === true).length;
    const videoViewed    = realMatches.filter((m) => m.viewed === true).length;
    const videoSmsSent   = realMatches.filter((m) => m.notifySmsOk === true).length;
    const videoPending   = realMatches.filter((m) => m.pendingNotify === true).length;

    // Group by track — normalize "Red Track" → "Red" etc.
    const trackMap = new Map<string, { total: number; purchased: number; viewed: number; smsSent: number }>();
    for (const m of realMatches) {
      const track = (m.track || "Unknown").replace(/\s*track\s*/i, "").trim() || "Unknown";
      const s = trackMap.get(track) ?? { total: 0, purchased: 0, viewed: 0, smsSent: 0 };
      s.total++;
      if (m.purchased)    s.purchased++;
      if (m.viewed)       s.viewed++;
      if (m.notifySmsOk)  s.smsSent++;
      trackMap.set(track, s);
    }
    const videosByTrack = Array.from(trackMap.entries())
      .map(([track, s]) => ({ track, ...s, purchaseRate: pct(s.purchased, s.total) }))
      .sort((a, b) => b.total - a.total);

    // Group by race type (Starter / Intermediate / Pro / unknown)
    const raceTypeMap = new Map<string, { total: number; purchased: number }>();
    for (const m of realMatches) {
      const rt = m.raceType || "Unknown";
      const s = raceTypeMap.get(rt) ?? { total: 0, purchased: 0 };
      s.total++;
      if (m.purchased) s.purchased++;
      raceTypeMap.set(rt, s);
    }
    const videosByRaceType = Array.from(raceTypeMap.entries())
      .map(([raceType, s]) => ({ raceType, ...s, purchaseRate: pct(s.purchased, s.total) }))
      .sort((a, b) => b.total - a.total);

    const videos = {
      total:           videoTotal,
      purchased:       videoPurchased,
      viewed:          videoViewed,
      smsSent:         videoSmsSent,
      pending:         videoPending,
      purchaseRate:    pct(videoPurchased, videoTotal),
      smsDeliveryRate: pct(videoSmsSent, videoTotal),
      byTrack:         videosByTrack,
      byRaceType:      videosByRaceType,
    };

    // ── Per-day breakdown for chart rendering ─────────────────────
    // SQL-native bucketing; lives in lib/sales-log.ts so the cast
    // to ET calendar day stays in one place.
    const days = await readDailyTotals(from, to);

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
