import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { sql } from "@/lib/db";
import { getVideoReport } from "@/lib/vt3";

/**
 * GET /api/admin/pov-codes/breakage
 *
 * POV redemption + breakage report — fast aggregate variant.
 *
 * Issued     = Neon `sales_log` SUM(pov_qty) WHERE pov_purchased
 *              (operator truth — what we sold via the website)
 * Redeemed   = VT3 video-report `unlockedVideoCount` for the same
 *              window (any video that became playable — sales +
 *              free unlocks across all source paths). Per ops
 *              direction we anchor on this rather than per-code
 *              cross-reference (the prefix-match approach was
 *              4–8s under load).
 * Breakage   = max(0, povSold − unlocked)
 *
 * **No per-bill / per-code data**. Aggregate totals + a per-day
 * series for charting only. If you need per-bill lookup for an
 * individual customer, use the existing `/api/booking-record` /
 * `/api/admin/sales/list` endpoints. If you need per-code drilldown,
 * use VT3's control-panel directly.
 *
 * Date filter targets the **race date** (booking-record `date`)
 * when available, with fallback to the booking timestamp's ET day.
 *
 * Auth: same `x-api-key` (SALES_API_KEYS) as the rest of the admin
 * surface; falls back to operator admin token.
 */

interface BookingRecord {
  billId: string;
  date?: string;
  status?: "pending_payment" | "confirmed";
}

interface SaleRow {
  bill_id: string;
  ts: string | Date;
  pov_qty: number;
}

function todayETYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function daysAgoETYmd(n: number): string {
  const ms = Date.now() - n * 24 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}
function isoToETYmd(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(typeof iso === "string" ? new Date(iso) : iso);
}
function etYmdToISO(ymd: string): string {
  const month = parseInt(ymd.slice(5, 7), 10);
  const isEDT = month >= 4 && month <= 10;
  const offset = isEDT ? "-04:00" : "-05:00";
  return `${ymd}T00:00:00${offset}`;
}
function ratio(num: number, denom: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return 0;
  return +(num / denom).toFixed(4);
}

async function readBookingRecords(billIds: string[]): Promise<Map<string, BookingRecord | null>> {
  const out = new Map<string, BookingRecord | null>();
  if (billIds.length === 0) return out;
  const unique = [...new Set(billIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const keys = chunk.map((b) => `bookingrecord:${b}`);
    const vals = await redis.mget(...keys);
    for (let j = 0; j < chunk.length; j++) {
      const raw = vals[j];
      if (!raw) { out.set(chunk[j], null); continue; }
      try { out.set(chunk[j], JSON.parse(raw) as BookingRecord); }
      catch { out.set(chunk[j], null); }
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const from = (searchParams.get("from") || daysAgoETYmd(30)).trim();
    const to = (searchParams.get("to") || todayETYmd()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: "Invalid date — use YYYY-MM-DD" }, { status: 400 });
    }

    const q = sql();
    // Wide booking-ts window so a customer who paid outside [from,to]
    // for an in-window race still rolls into the right race-date bucket.
    const rows = (await q`
      SELECT bill_id, ts, pov_qty
      FROM sales_log
      WHERE pov_purchased = true
        AND bill_id IS NOT NULL
        AND ts >= (${from}::date - INTERVAL '7 days')
        AND ts <  (${to}::date + INTERVAL '8 days')
    `) as unknown as SaleRow[];

    // VT3 video-report — single round-trip. Bump `to` by 24h so VT3
    // includes the `to` date in the result (their `to` is exclusive).
    const fromIso = etYmdToISO(from);
    const toNextYmd = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000)
      .toISOString().slice(0, 10);
    const toIso = etYmdToISO(toNextYmd);

    const [bookingByBillId, vt3Report] = await Promise.all([
      readBookingRecords(rows.map((r) => r.bill_id)),
      getVideoReport({
        from: fromIso, to: toIso,
        interval: "days", timezone: "America/New_York", sites: [],
      }).catch((err) => {
        console.warn("[admin/pov-codes/breakage] VT3 report failed:", err);
        return null;
      }),
    ]);

    // VT3 daily series for the FastTrax site (siteId: 992) when present;
    // the cross-site aggregate (siteId: null) is equivalent for our
    // single-site account.
    const vt3SiteId = parseInt(process.env.VT3_SITE_ID || "992", 10);
    const ftPoints = vt3Report?.points.filter((p) => p.siteId === vt3SiteId) ?? [];
    const aggPoints = vt3Report?.points.filter((p) => p.siteId === null) ?? [];
    const vt3DailySeries = ftPoints.length > 0 ? ftPoints : aggPoints;

    const vt3UnlockedByYmd = new Map<string, number>();
    const vt3SoldByYmd = new Map<string, number>();
    const vt3UnlockCodeByYmd = new Map<string, number>();
    const vt3ManualByYmd = new Map<string, number>();
    for (const p of vt3DailySeries) {
      const ymd = typeof p.from === "string" ? p.from.slice(0, 10) : "";
      if (!ymd) continue;
      vt3UnlockedByYmd.set(ymd, p.unlockedVideoCount);
      vt3SoldByYmd.set(ymd, p.videoSalesCount);
      vt3UnlockCodeByYmd.set(ymd, p.unlockCodeVideoCount);
      vt3ManualByYmd.set(ymd, p.manualUnlockVideoCount);
    }

    // Roll Neon sales into per-race-date buckets. No per-bill output —
    // we only emit aggregate counts.
    const byDayMap = new Map<string, {
      ymd: string;
      povSold: number;
      salesRows: number;
      vt3Sold: number;
      vt3Unlocked: number;
      vt3UnlockCode: number;
      vt3Manual: number;
      breakage: number;
      redemptionPct: number;
    }>();

    let totalPovSold = 0;
    let outOfRange = 0;
    let noDate = 0;
    for (const sale of rows) {
      const booking = bookingByBillId.get(sale.bill_id) || null;
      const raceDate = booking?.date || null;
      const fallbackDate = isoToETYmd(sale.ts);
      const filterDate = raceDate || fallbackDate;
      if (!filterDate) { noDate++; continue; }
      if (filterDate < from || filterDate > to) { outOfRange++; continue; }

      const cur = byDayMap.get(filterDate) ?? {
        ymd: filterDate, povSold: 0, salesRows: 0,
        vt3Sold: vt3SoldByYmd.get(filterDate) ?? 0,
        vt3Unlocked: vt3UnlockedByYmd.get(filterDate) ?? 0,
        vt3UnlockCode: vt3UnlockCodeByYmd.get(filterDate) ?? 0,
        vt3Manual: vt3ManualByYmd.get(filterDate) ?? 0,
        breakage: 0, redemptionPct: 0,
      };
      cur.povSold += sale.pov_qty;
      cur.salesRows++;
      byDayMap.set(filterDate, cur);
      totalPovSold += sale.pov_qty;
    }

    // Backfill per-day rows where VT3 saw activity but Neon had no
    // POV sales (race day with no POV qty sold). Keeps the chart
    // continuous instead of sparse.
    for (const ymd of vt3UnlockedByYmd.keys()) {
      if (ymd < from || ymd > to) continue;
      if (!byDayMap.has(ymd)) {
        byDayMap.set(ymd, {
          ymd, povSold: 0, salesRows: 0,
          vt3Sold: vt3SoldByYmd.get(ymd) ?? 0,
          vt3Unlocked: vt3UnlockedByYmd.get(ymd) ?? 0,
          vt3UnlockCode: vt3UnlockCodeByYmd.get(ymd) ?? 0,
          vt3Manual: vt3ManualByYmd.get(ymd) ?? 0,
          breakage: 0, redemptionPct: 0,
        });
      }
    }

    // Per-day breakage anchored on povSold − vt3Unlocked.
    for (const r of byDayMap.values()) {
      r.breakage = Math.max(0, r.povSold - r.vt3Unlocked);
      r.redemptionPct = ratio(r.vt3Unlocked, r.povSold);
    }

    const totalUnlocked = [...byDayMap.values()].reduce((s, r) => s + r.vt3Unlocked, 0);
    const totalVt3Sold = [...byDayMap.values()].reduce((s, r) => s + r.vt3Sold, 0);
    const totalUnlockCode = [...byDayMap.values()].reduce((s, r) => s + r.vt3UnlockCode, 0);
    const totalManual = [...byDayMap.values()].reduce((s, r) => s + r.vt3Manual, 0);
    const breakage = Math.max(0, totalPovSold - totalUnlocked);

    const totals = {
      salesRows: [...byDayMap.values()].reduce((s, r) => s + r.salesRows, 0),
      povSold: totalPovSold,
      vt3Sold: totalVt3Sold,
      unlocked: totalUnlocked,
      unlockCodeRedeemed: totalUnlockCode,
      manualUnlocked: totalManual,
      breakage,
      redemptionPct: ratio(totalUnlocked, totalPovSold),
      breakagePct: ratio(breakage, totalPovSold),
    };

    const poolAvailable = await redis.scard("pov:codes");

    return NextResponse.json(
      {
        range: { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 },
        totals,
        pool: { available: poolAvailable },
        byDay: [...byDayMap.values()].sort((a, b) => a.ymd.localeCompare(b.ymd)),
        excluded: { outOfRange, noDate },
        meta: {
          issuedSource: "neon.sales_log.pov_qty WHERE pov_purchased",
          redeemedSource: "vt3.video-report.unlockedVideoCount",
          notes: [
            "unlocked includes ALL videos that became playable (Stripe online + our codes + manual + free).",
            "unlockCodeRedeemed is the narrower 'our codes only' counter.",
            "Per-bill and per-code data removed for performance; see /api/admin/pov-codes/report for the full VT3 metric set.",
          ],
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[admin/pov-codes/breakage]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to compute breakage" },
      { status: 500 },
    );
  }
}
