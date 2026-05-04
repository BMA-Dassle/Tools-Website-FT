import { NextRequest, NextResponse } from "next/server";
import { getVideoReport, type Vt3VideoReportPoint } from "@/lib/vt3";

/**
 * GET /api/admin/pov-codes/report
 *
 * Aggregated VT3 viewpoint / video-report for the FastTrax site.
 * Surfaces every field VT3 exposes in its `/reporting/video-report`
 * endpoint plus a few computed conversion ratios so the portal
 * doesn't have to do the math.
 *
 * Field translation (HeadPinz ops conventions):
 *   sold              videoSalesCount         total sales (paid OR credit-consumed)
 *   captured          videoCount              every kart capture in window
 *   unlocked          unlockedVideoCount      sales + free unlocks
 *   impressions       videoImpressionCount    page or media-centre opens
 *   online sales      stripeVideoCount        post-race vt3.io card purchases
 *   in-person sales   stripeTerminalVideoCount + venueVideoCount
 *   our web codes     unlockCodeVideoCount    ← codes we issued via the website
 *   manual override   manualUnlockVideoCount  staff forced an unlock
 *   pre-paid          preUnlockedVideoCount   bundle / credit applied before race
 *   post-paid         postUnlockedVideoCount  the standard purchase path
 *
 * Conversion metrics:
 *   salesPerCaptured     videoSalesCount  / videoCount        — what % of capture is monetized
 *   unlockPerCaptured    unlockedVideoCount / videoCount      — what % is being watched
 *   salesPerImpression   videoSalesCount / videoImpressionCount — close-rate on viewed videos
 *
 * Date filter targets booking calendar dates in ET. The endpoint
 * passes them through to VT3 with explicit -04:00 / -05:00 offsets;
 * VT3 handles the bucketing.
 *
 * Auth: same `x-api-key` (SALES_API_KEYS) as the rest of the admin
 * surface. See middleware.ts.
 */

const VT3_SITE_ID = parseInt(process.env.VT3_SITE_ID || "992", 10);

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

/** ET start-of-day → ISO with the right DST offset. EDT (Apr–Oct) = -04:00,
 *  EST = -05:00. Same DST math used elsewhere in the codebase. */
function etYmdToISO(ymd: string): string {
  const month = parseInt(ymd.slice(5, 7), 10);
  const isEDT = month >= 4 && month <= 10;
  const offset = isEDT ? "-04:00" : "-05:00";
  return `${ymd}T00:00:00${offset}`;
}

interface ReportRow extends Vt3VideoReportPoint {
  // Computed conversion ratios — 0..1, 4-decimal precision
  salesPerCaptured: number;
  unlockPerCaptured: number;
  salesPerImpression: number;
  // Friendlier YYYY-MM-DD for chart axes — VT3's `from` is local ISO
  // without offset; we slice to the date portion.
  ymd: string;
}

function ratio(num: number, denom: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return 0;
  return +(num / denom).toFixed(4);
}

function enrichRow(p: Vt3VideoReportPoint): ReportRow {
  return {
    ...p,
    salesPerCaptured: ratio(p.videoSalesCount, p.videoCount),
    unlockPerCaptured: ratio(p.unlockedVideoCount, p.videoCount),
    salesPerImpression: ratio(p.videoSalesCount, p.videoImpressionCount),
    ymd: typeof p.from === "string" ? p.from.slice(0, 10) : "",
  };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const from = (searchParams.get("from") || daysAgoETYmd(30)).trim();
    const to = (searchParams.get("to") || todayETYmd()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: "Invalid date — use YYYY-MM-DD" }, { status: 400 });
    }
    const intervalParam = (searchParams.get("interval") || "days").toLowerCase();
    if (!["hours", "days", "weeks", "months"].includes(intervalParam)) {
      return NextResponse.json({ error: "interval must be hours|days|weeks|months" }, { status: 400 });
    }
    const interval = intervalParam as "hours" | "days" | "weeks" | "months";

    // VT3 treats `to` as exclusive-end-of-day. Bump `to` by 24h so
    // the response's last bucket covers the whole `to` day. The HAR
    // confirms this pattern — when the UI is set to "May 3" it sends
    // to=2026-05-04T00:00:00 and VT3 returns the May-3 bucket.
    const fromIso = etYmdToISO(from);
    const toNextYmd = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    const toIso = etYmdToISO(toNextYmd);

    const report = await getVideoReport({
      from: fromIso,
      to: toIso,
      interval,
      timezone: "America/New_York",
      sites: [], // VT3 scopes by JWT — service account only sees FastTrax
    });

    // Filter to FastTrax-only points (siteId: 992). The aggregated
    // siteId: null rows are equivalent for a single-site account so
    // we use them as the canonical series — but expose both in case
    // VT3 ever lets the service account see HeadPinz too.
    const ftPoints = report.points.filter((p) => p.siteId === VT3_SITE_ID);
    const aggPoints = report.points.filter((p) => p.siteId === null);
    const series = ftPoints.length > 0 ? ftPoints : aggPoints;

    // Roll up to a single totals object across the filter window.
    const totals = series.reduce(
      (acc, p) => {
        acc.videoCount += p.videoCount;
        acc.videoImpressionCount += p.videoImpressionCount;
        acc.videoPageImpressionCount += p.videoPageImpressionCount;
        acc.mediaCentreImpressionCount += p.mediaCentreImpressionCount;
        acc.unlockedVideoCount += p.unlockedVideoCount;
        acc.videoSalesCount += p.videoSalesCount;
        acc.stripeVideoCount += p.stripeVideoCount;
        acc.stripeTerminalVideoCount += p.stripeTerminalVideoCount;
        acc.venueVideoCount += p.venueVideoCount;
        acc.unlockCodeVideoCount += p.unlockCodeVideoCount;
        acc.preUnlockedVideoCount += p.preUnlockedVideoCount;
        acc.postUnlockedVideoCount += p.postUnlockedVideoCount;
        acc.uploadedVideoCount += p.uploadedVideoCount;
        acc.manualUnlockVideoCount += p.manualUnlockVideoCount;
        acc.apiUnlockVideoCount += p.apiUnlockVideoCount;
        acc.totalDataUp += p.totalDataUp;
        return acc;
      },
      {
        videoCount: 0, videoImpressionCount: 0, videoPageImpressionCount: 0,
        mediaCentreImpressionCount: 0, unlockedVideoCount: 0, videoSalesCount: 0,
        stripeVideoCount: 0, stripeTerminalVideoCount: 0, venueVideoCount: 0,
        unlockCodeVideoCount: 0, preUnlockedVideoCount: 0, postUnlockedVideoCount: 0,
        uploadedVideoCount: 0, manualUnlockVideoCount: 0, apiUnlockVideoCount: 0,
        totalDataUp: 0,
      },
    );

    const enriched = {
      ...totals,
      averageVideoSize: totals.uploadedVideoCount > 0
        ? Math.round(totals.totalDataUp / totals.uploadedVideoCount)
        : 0,
      // Conversion ratios anchored on the rolled-up totals
      salesPerCaptured: ratio(totals.videoSalesCount, totals.videoCount),
      unlockPerCaptured: ratio(totals.unlockedVideoCount, totals.videoCount),
      salesPerImpression: ratio(totals.videoSalesCount, totals.videoImpressionCount),
    };

    return NextResponse.json(
      {
        range: {
          from, to,
          days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1,
          timezone: report.timezone,
          interval: report.interval,
        },
        sites: report.sites,
        totals: enriched,
        byInterval: series.map(enrichRow),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[admin/pov-codes/report]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch report" },
      { status: 500 },
    );
  }
}
