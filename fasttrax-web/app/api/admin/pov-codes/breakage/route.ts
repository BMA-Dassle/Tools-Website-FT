import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { listAllUnlockCodes, type Vt3UnlockCode } from "@/lib/vt3";

/**
 * GET /api/admin/pov-codes/breakage
 *
 * POV / ViewPoint code breakage report. Cross-references:
 *   1. Codes WE issued via the website (Redis HASH `pov:used`, keyed by
 *      code → JSON metadata with billId / personId / sessionId / source)
 *   2. The VT3 unlock-code registry (`POST sys.vt3.io/unlock-codes`,
 *      paginated, returns status: "ACTIVE" | "USED" + redeemedAt + video)
 *   3. Race-date metadata via the booking-record cache
 *      (`bookingrecord:{billId}` → JSON with `date: YYYY-MM-DD`)
 *
 * Joining all three answers the operator question:
 *   "Of the codes we gave out for races on May 3, how many did the
 *    customer actually redeem on vt3.io to unlock their video?"
 *
 * Breakage = issued − redeemed. "Stale" but not yet revoked. The
 * employee portal's POV Codes tab reads this every minute or so and
 * surfaces a redemption rate + a per-day chart.
 *
 * Query params:
 *   from  YYYY-MM-DD ET — race date lower bound (inclusive). Default
 *         = 30 days ago.
 *   to    YYYY-MM-DD ET — race date upper bound (inclusive). Default
 *         = today.
 *   limit cap on the raw `entries[]` array. Default 1000, max 5000.
 *         Aggregations always use the full filtered set.
 *
 * Auth: same `x-api-key` (SALES_API_KEYS) as the rest of the admin
 * surface; falls back to operator admin token. See middleware.ts.
 *
 * Note on "Neon": the user spec said "look into Neon for issued codes",
 * but POV-issued state actually lives in Redis (see app/api/pov-codes/route.ts).
 * No migration needed — the Redis hash is authoritative and this report
 * reads it directly.
 */

const VT3_SITE_ID = parseInt(process.env.VT3_SITE_ID || "992", 10);
const POV_USED_KEY = "pov:used";

interface PovUsedMeta {
  usedAt?: string;
  billId?: string;
  email?: string;
  personId?: string | number;
  sessionId?: string | number;
  locationId?: string;
  source?: string;
}

interface BookingRecord {
  billId: string;
  date?: string;
  status?: "pending_payment" | "confirmed";
  reservationNumber?: string | null;
  contact?: { firstName?: string; lastName?: string; email?: string; phone?: string };
  primaryPersonId?: string | null;
}

interface BreakageEntry {
  code: string;
  issuedAt: string | null;       // when we popped it out of the pool
  issuedVia: "billId" | "claim-from-credit" | "manual-use" | "unknown";
  billId: string | null;
  email: string | null;
  personId: string | null;
  sessionId: string | null;
  raceDate: string | null;       // YYYY-MM-DD ET, from booking record
  reservationNumber: string | null;
  racerName: string | null;
  redeemed: boolean;
  redeemedAt: string | null;
  videoCode: string | null;
  vt3Status: "ACTIVE" | "USED" | "REVOKED" | "MISSING" | string;
  revokedAt: string | null;
  daysSinceIssued: number | null;
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

/** Drain the `pov:used` Redis HASH via HSCAN. The hash currently sits
 *  in the low thousands of entries; HSCAN with COUNT 500 finishes in
 *  one or two round trips. Skips malformed JSON entries (logs once). */
async function readAllIssued(): Promise<Map<string, PovUsedMeta>> {
  const out = new Map<string, PovUsedMeta>();
  let cursor = "0";
  let scanCount = 0;
  do {
    // ioredis returns [cursor, fields[]] — fields alternate code, json
    const [next, fields] = await redis.hscan(POV_USED_KEY, cursor, "COUNT", 500);
    cursor = next;
    scanCount++;
    for (let i = 0; i < fields.length; i += 2) {
      const code = fields[i];
      const raw = fields[i + 1];
      try {
        out.set(code, JSON.parse(raw) as PovUsedMeta);
      } catch {
        // Single malformed entry shouldn't kill the whole report.
        // Treat as opaque — code present, no metadata.
        out.set(code, {});
      }
    }
    // Hard cap on scan iterations so a runaway HSCAN can't loop forever.
    if (scanCount > 200) break;
  } while (cursor !== "0");
  return out;
}

/** Bulk-fetch booking records for a unique set of billIds. Uses MGET
 *  in chunks of 100 keys to keep request payload sane. Missing records
 *  return `null` in the same slot. */
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
      try {
        out.set(chunk[j], JSON.parse(raw) as BookingRecord);
      } catch {
        out.set(chunk[j], null);
      }
    }
  }
  return out;
}

function classifyIssuedVia(meta: PovUsedMeta): BreakageEntry["issuedVia"] {
  if (meta.source === "claim-from-credit") return "claim-from-credit";
  if (meta.billId) return "billId";
  if (meta.usedAt && !meta.billId && !meta.personId) return "manual-use";
  return "unknown";
}

function classifyVt3Status(rec: Vt3UnlockCode | undefined): BreakageEntry["vt3Status"] {
  if (!rec) return "MISSING";
  if (rec.revokedAt) return "REVOKED";
  if (rec.status === "USED" || rec.redeemedAt) return "USED";
  if (rec.status === "ACTIVE") return "ACTIVE";
  return rec.status || "MISSING";
}

function daysBetweenET(fromIso: string, toMs: number): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((toMs - t) / (24 * 60 * 60 * 1000));
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const from = (searchParams.get("from") || daysAgoETYmd(30)).trim();
    const to = (searchParams.get("to") || todayETYmd()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: "Invalid date — use YYYY-MM-DD" }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(5000, parseInt(searchParams.get("limit") || "1000", 10) || 1000));

    // ── 1. Load both sides of the cross-reference in parallel ───────────
    const [issued, vt3Codes] = await Promise.all([
      readAllIssued(),
      listAllUnlockCodes({ siteId: VT3_SITE_ID, maxRows: 5000 }),
    ]);

    // Index VT3 codes by code string for O(1) lookup. Codes are unique
    // per site in VT3's data model.
    const vt3ByCode = new Map<string, Vt3UnlockCode>();
    for (const c of vt3Codes) vt3ByCode.set(c.code, c);

    // ── 2. Bulk-fetch booking records for everything we issued ──────────
    const billIds = [...issued.values()]
      .map((m) => m.billId || "")
      .filter(Boolean);
    const bookingByBillId = await readBookingRecords(billIds);

    // ── 3. Join and filter by reservation date ─────────────────────────
    const nowMs = Date.now();
    const all: BreakageEntry[] = [];
    for (const [code, meta] of issued) {
      const vt3 = vt3ByCode.get(code);
      const billId = meta.billId || null;
      const booking = billId ? bookingByBillId.get(billId) || null : null;
      const raceDate = booking?.date || null;
      const racerName = booking?.contact
        ? `${booking.contact.firstName ?? ""} ${booking.contact.lastName ?? ""}`.trim() || null
        : null;

      const status = classifyVt3Status(vt3);
      const entry: BreakageEntry = {
        code,
        issuedAt: meta.usedAt || null,
        issuedVia: classifyIssuedVia(meta),
        billId,
        email: meta.email || booking?.contact?.email || null,
        personId: meta.personId != null ? String(meta.personId) : null,
        sessionId: meta.sessionId != null ? String(meta.sessionId) : null,
        raceDate,
        reservationNumber: booking?.reservationNumber || null,
        racerName,
        redeemed: status === "USED",
        redeemedAt: vt3?.redeemedAt || null,
        videoCode: vt3?.video || null,
        vt3Status: status,
        revokedAt: vt3?.revokedAt || null,
        daysSinceIssued: meta.usedAt ? daysBetweenET(meta.usedAt, nowMs) : null,
      };
      all.push(entry);
    }

    // Filter: race date in [from, to]. Codes without a known race date
    // are bucketed separately so they're visible to staff but don't
    // pollute the per-day chart.
    const inRange: BreakageEntry[] = [];
    const noDate: BreakageEntry[] = [];
    for (const e of all) {
      if (!e.raceDate) {
        // Fall back to issuedAt for date-bucketing when booking record
        // missing — that way a freshly-issued code with no booking-record
        // (TTL expired, or claim-from-credit path) still shows up.
        const iso = e.issuedAt;
        const ymd = iso ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date(iso)) : null;
        if (ymd && ymd >= from && ymd <= to) {
          inRange.push({ ...e, raceDate: ymd });
        } else {
          noDate.push(e);
        }
        continue;
      }
      if (e.raceDate >= from && e.raceDate <= to) inRange.push(e);
    }

    // ── 4. Aggregations across the in-range slice ──────────────────────
    const totals = {
      issued: inRange.length,
      redeemed: 0,
      active: 0,
      revoked: 0,
      missingFromVt3: 0,
    };
    const byDay = new Map<string, { ymd: string; issued: number; redeemed: number; active: number }>();
    const byIssuedVia = new Map<string, { issued: number; redeemed: number }>();

    for (const e of inRange) {
      if (e.redeemed) totals.redeemed++;
      else if (e.vt3Status === "REVOKED") totals.revoked++;
      else if (e.vt3Status === "MISSING") totals.missingFromVt3++;
      else totals.active++;

      const d = e.raceDate || "unknown";
      const dayBucket = byDay.get(d) ?? { ymd: d, issued: 0, redeemed: 0, active: 0 };
      dayBucket.issued++;
      if (e.redeemed) dayBucket.redeemed++;
      else if (e.vt3Status !== "REVOKED" && e.vt3Status !== "MISSING") dayBucket.active++;
      byDay.set(d, dayBucket);

      const k = e.issuedVia;
      const cur = byIssuedVia.get(k) ?? { issued: 0, redeemed: 0 };
      cur.issued++;
      if (e.redeemed) cur.redeemed++;
      byIssuedVia.set(k, cur);
    }

    const breakage = totals.issued - totals.redeemed - totals.revoked;
    const redemptionRate = totals.issued > 0 ? +(totals.redeemed / totals.issued).toFixed(4) : 0;
    const breakageRate = totals.issued > 0 ? +(breakage / totals.issued).toFixed(4) : 0;

    // Pool size — codes still in the available SET. Operators use this
    // to decide when to import more codes.
    const poolAvailable = await redis.scard("pov:codes");

    // ── 5. Sort entries newest-first, page to limit ────────────────────
    inRange.sort((a, b) => {
      const ax = a.issuedAt || "";
      const bx = b.issuedAt || "";
      return bx.localeCompare(ax);
    });
    const entries = inRange.slice(0, limit);

    return NextResponse.json(
      {
        range: { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 },
        totals: {
          ...totals,
          breakage,
          redemptionRate,   // 0..1, 4 decimals
          breakageRate,     // 0..1, 4 decimals
        },
        pool: { available: poolAvailable },
        byDay: [...byDay.values()].sort((a, b) => a.ymd.localeCompare(b.ymd)),
        byIssuedVia: [...byIssuedVia.entries()].map(([source, v]) => ({
          source,
          issued: v.issued,
          redeemed: v.redeemed,
          redemptionRate: v.issued > 0 ? +(v.redeemed / v.issued).toFixed(4) : 0,
        })),
        excluded: {
          // Out-of-range or no-date counts. Surfaces "we issued X codes
          // that have no booking record we can date-bucket" so ops
          // can investigate without those codes silently disappearing.
          outOfRange: all.length - inRange.length - noDate.length,
          noDate: noDate.length,
        },
        returned: entries.length,
        entries,
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
