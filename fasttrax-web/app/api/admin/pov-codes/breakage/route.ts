import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { sql } from "@/lib/db";
import { listAllUnlockCodes, type Vt3UnlockCode } from "@/lib/vt3";

/**
 * GET /api/admin/pov-codes/breakage
 *
 * POV / ViewPoint redemption + breakage report.
 *
 * Authoritative chain:
 *   1. Neon `sales_log` — every confirmed POV sale (rows where
 *      `pov_purchased = true`, summed via `pov_qty`). This is the
 *      operator-truth "we sold N POV products in this window."
 *   2. Redis `pov:used` HASH — bridge layer. For each Neon billId we
 *      fetch the codes that got popped out of the available pool.
 *      Lets us go from a sale to a specific 10-char unlock code.
 *   3. VT3 `POST sys.vt3.io/unlock-codes` — redemption truth. Status
 *      `USED` + `redeemedAt` set means the customer entered the code
 *      on vt3.io and unlocked their video.
 *
 * Cross-reference quirk: VT3 returns codes MASKED in the API response
 * ("ZBHT7*****"). Our Redis hash has full plaintext. We match by the
 * first-5-character visible prefix; collision rate at our volume is
 * ~0.06%. Ambiguous matches (prefix shared by ≥2 VT3 codes) get
 * surfaced as a separate counter rather than silently miscounted.
 *
 * Date filter targets the **race date** (the ET day they booked the
 * race for), pulled from the `bookingrecord:{billId}` Redis cache.
 * Sales without a booking record fall back to the booking timestamp's
 * ET day so they stay visible.
 *
 * Response totals:
 *   salesRows        — count of POV sale rows in window
 *   povSold          — SUM(pov_qty) — the operator-truth issued count
 *   codesIssued      — Redis pov:used codes for those bills
 *   issuanceGap      — bills in Neon with no codes in Redis (problem)
 *   redeemed         — codes that VT3 marks USED (prefix-match)
 *   redemptionPct    — redeemed / povSold (anchored on operator truth)
 *   breakage         — povSold − redeemed
 *
 * Auth: same `x-api-key` (SALES_API_KEYS) as the rest of the admin
 * surface; falls back to operator admin token. See middleware.ts.
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

interface SaleRow {
  bill_id: string;
  // Neon's serverless driver returns TIMESTAMPTZ as a JS Date, not an
  // ISO string. We accept either and normalize to ISO string before
  // putting it on the response — `Date.localeCompare` doesn't exist
  // and broke the sort the first time we shipped this.
  ts: string | Date;
  pov_qty: number;
  reservation_number: string | null;
  email: string | null;
  phone: string | null;
}

interface BreakageEntry {
  billId: string;
  bookedAt: string;             // ISO — when the customer paid
  raceDate: string | null;       // YYYY-MM-DD ET — race date from booking record
  reservationNumber: string | null;
  racerName: string | null;
  email: string | null;
  povQty: number;                // from Neon — operator truth
  codesIssued: number;           // codes in Redis for this bill
  codesRedeemed: number;         // VT3 prefix-match status=USED
  codesActive: number;
  codesRevoked: number;
  codesAmbiguous: number;
  codes: Array<{
    code: string;
    redeemed: boolean;
    redeemedAt: string | null;
    videoCode: string | null;
    vt3Status: "ACTIVE" | "USED" | "REVOKED" | "AMBIGUOUS" | "MISSING" | string;
  }>;
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

/** Normalize sale.ts (string | Date) to a string ISO for the response. */
function toIso(v: string | Date): string {
  return typeof v === "string" ? v : v.toISOString();
}

/** HSCAN through `pov:used` once. Returns full plaintext code → metadata.
 *  Skips malformed JSON entries with an empty meta. */
async function readAllIssued(): Promise<Map<string, PovUsedMeta>> {
  const out = new Map<string, PovUsedMeta>();
  let cursor = "0";
  let scanCount = 0;
  do {
    const [next, fields] = await redis.hscan(POV_USED_KEY, cursor, "COUNT", 500);
    cursor = next;
    scanCount++;
    for (let i = 0; i < fields.length; i += 2) {
      const code = fields[i];
      const raw = fields[i + 1];
      try { out.set(code, JSON.parse(raw) as PovUsedMeta); }
      catch { out.set(code, {}); }
    }
    if (scanCount > 200) break;
  } while (cursor !== "0");
  return out;
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

/**
 * Build the prefix-match index over VT3 codes. Key = first 5 visible
 * characters (uppercase); value = list of VT3 records that match.
 * Length-1 lists → confident match; length-2+ → ambiguous bucket.
 */
function indexVt3ByPrefix(codes: Vt3UnlockCode[]): Map<string, Vt3UnlockCode[]> {
  const out = new Map<string, Vt3UnlockCode[]>();
  for (const c of codes) {
    const visible = c.code.replace(/\*+$/, "");
    const prefix = visible.slice(0, 5).toUpperCase();
    if (!out.has(prefix)) out.set(prefix, []);
    out.get(prefix)!.push(c);
  }
  return out;
}

function classifyVt3Status(rec: Vt3UnlockCode | undefined): BreakageEntry["codes"][number]["vt3Status"] {
  if (!rec) return "MISSING";
  if (rec.revokedAt) return "REVOKED";
  if (rec.status === "USED" || rec.redeemedAt) return "USED";
  if (rec.status === "ACTIVE") return "ACTIVE";
  return rec.status || "MISSING";
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

    // Date semantics: the filter targets RACE date (booking_record.date) when
    // available, falling back to booking timestamp's ET day. We pull a wide
    // Neon window (booking ts in [from-7, to+7]) so a customer who booked
    // outside the window for an in-window race still gets included; the
    // post-join filter narrows down to actual race dates.
    const q = sql();
    const rows = (await q`
      SELECT
        bill_id, ts, pov_qty, reservation_number, email, phone
      FROM sales_log
      WHERE pov_purchased = true
        AND bill_id IS NOT NULL
        AND ts >= (${from}::date - INTERVAL '7 days')
        AND ts <  (${to}::date + INTERVAL '8 days')
      ORDER BY ts DESC
    `) as unknown as SaleRow[];

    if (rows.length === 0) {
      // Empty window — return zeroed report so UI renders cleanly
      return NextResponse.json({
        range: { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 },
        totals: { salesRows: 0, povSold: 0, codesIssued: 0, issuanceGap: 0, redeemed: 0, active: 0, revoked: 0, ambiguous: 0, missingFromVt3: 0, breakage: 0, redemptionPct: 0, breakagePct: 0 },
        pool: { available: await redis.scard("pov:codes") },
        byDay: [],
        excluded: { outOfRange: 0, noDate: 0 },
        returned: 0,
        entries: [],
      }, { headers: { "Cache-Control": "no-store" } });
    }

    // Parallel: load Redis pov:used + booking-records + VT3 unlock-codes.
    const [issued, bookingByBillId, vt3Codes] = await Promise.all([
      readAllIssued(),
      readBookingRecords(rows.map((r) => r.bill_id)),
      listAllUnlockCodes({ siteId: VT3_SITE_ID, maxRows: 20000 }),
    ]);

    const vt3ByPrefix = indexVt3ByPrefix(vt3Codes);

    // Index our Redis codes by billId so we can pivot Neon-row → codes.
    const codesByBillId = new Map<string, string[]>();
    for (const [code, meta] of issued) {
      if (meta.billId) {
        if (!codesByBillId.has(meta.billId)) codesByBillId.set(meta.billId, []);
        codesByBillId.get(meta.billId)!.push(code);
      }
    }

    // Build the per-bill breakage entries, filter by race date in [from, to].
    const inRange: BreakageEntry[] = [];
    let outOfRange = 0;
    let noDate = 0;

    for (const sale of rows) {
      const booking = bookingByBillId.get(sale.bill_id) || null;
      const raceDate = booking?.date || null;
      const fallbackDate = isoToETYmd(sale.ts);
      const filterDate = raceDate || fallbackDate;
      if (!filterDate) { noDate++; continue; }
      if (filterDate < from || filterDate > to) { outOfRange++; continue; }

      const codes = codesByBillId.get(sale.bill_id) || [];
      const codeRows: BreakageEntry["codes"] = [];
      let red = 0, act = 0, rev = 0, amb = 0;
      for (const code of codes) {
        const cands = vt3ByPrefix.get(code.slice(0, 5).toUpperCase()) || [];
        if (cands.length > 1) {
          amb++;
          codeRows.push({ code, redeemed: false, redeemedAt: null, videoCode: null, vt3Status: "AMBIGUOUS" });
          continue;
        }
        const v = cands[0];
        const status = classifyVt3Status(v);
        if (status === "USED") red++;
        else if (status === "REVOKED") rev++;
        else if (status === "ACTIVE") act++;
        codeRows.push({
          code,
          redeemed: status === "USED",
          redeemedAt: v?.redeemedAt || null,
          videoCode: v?.video || null,
          vt3Status: status,
        });
      }

      const racerName = booking?.contact
        ? `${booking.contact.firstName ?? ""} ${booking.contact.lastName ?? ""}`.trim() || null
        : null;

      inRange.push({
        billId: sale.bill_id,
        bookedAt: toIso(sale.ts),
        raceDate,
        reservationNumber: sale.reservation_number ?? booking?.reservationNumber ?? null,
        racerName,
        email: sale.email ?? booking?.contact?.email ?? null,
        povQty: sale.pov_qty,
        codesIssued: codes.length,
        codesRedeemed: red,
        codesActive: act,
        codesRevoked: rev,
        codesAmbiguous: amb,
        codes: codeRows,
      });
    }

    // Aggregate the in-range slice.
    const totals = {
      salesRows: inRange.length,
      povSold: 0,
      codesIssued: 0,
      issuanceGap: 0,
      redeemed: 0,
      active: 0,
      revoked: 0,
      ambiguous: 0,
      missingFromVt3: 0,
      breakage: 0,
      redemptionPct: 0,
      breakagePct: 0,
    };
    const byDay = new Map<string, { ymd: string; salesRows: number; povSold: number; codesIssued: number; redeemed: number; breakage: number }>();

    for (const e of inRange) {
      totals.povSold += e.povQty;
      totals.codesIssued += e.codesIssued;
      if (e.codesIssued === 0) totals.issuanceGap++;
      totals.redeemed += e.codesRedeemed;
      totals.active += e.codesActive;
      totals.revoked += e.codesRevoked;
      totals.ambiguous += e.codesAmbiguous;
      // codes whose status is MISSING (not in any prefix bucket) — count
      // separately so ops sees them but they don't pollute the active math
      const missing = e.codes.filter((c) => c.vt3Status === "MISSING").length;
      totals.missingFromVt3 += missing;

      const d = e.raceDate || isoToETYmd(e.bookedAt);
      const cur = byDay.get(d) ?? { ymd: d, salesRows: 0, povSold: 0, codesIssued: 0, redeemed: 0, breakage: 0 };
      cur.salesRows++;
      cur.povSold += e.povQty;
      cur.codesIssued += e.codesIssued;
      cur.redeemed += e.codesRedeemed;
      cur.breakage += Math.max(0, e.povQty - e.codesRedeemed);
      byDay.set(d, cur);
    }

    // Breakage anchored on operator-truth povSold.
    totals.breakage = Math.max(0, totals.povSold - totals.redeemed);
    totals.redemptionPct = totals.povSold > 0 ? +(totals.redeemed / totals.povSold).toFixed(4) : 0;
    totals.breakagePct = totals.povSold > 0 ? +(totals.breakage / totals.povSold).toFixed(4) : 0;

    const poolAvailable = await redis.scard("pov:codes");

    // Newest-first by booking time, page to limit.
    inRange.sort((a, b) => b.bookedAt.localeCompare(a.bookedAt));
    const entries = inRange.slice(0, limit);

    return NextResponse.json(
      {
        range: { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 },
        totals,
        pool: { available: poolAvailable },
        byDay: [...byDay.values()].sort((a, b) => a.ymd.localeCompare(b.ymd)),
        excluded: { outOfRange, noDate },
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
