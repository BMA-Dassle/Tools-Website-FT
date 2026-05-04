import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * GET /api/admin/pov-codes/issued/list
 *
 * Unified inventory of every POV code we've issued via either path,
 * grouped by issuance event so each row represents one customer's
 * batch of codes (most bills produce 1–4 codes).
 *
 * Two issuance paths in our system that this endpoint merges:
 *
 *   1. **Web reservation sale** — checkout flow pops codes from the
 *      pool and writes them to `pov:used` keyed by code → JSON
 *      `{ usedAt, billId, email }`. Codes appear on the booking
 *      confirmation page; SMS / email link to that page.
 *
 *   2. **Credit-claim from e-ticket** — the e-ticket page calls
 *      `/api/pov-codes?action=claim-from-credit` when the racer has
 *      ViewPoint Credit on file. Pops codes, writes them to
 *      `pov:used` with `{ personId, sessionId, locationId,
 *      source: "claim-from-credit" }`, AND keeps a per-person
 *      idempotency record at `pov:claimed:person:{personId}` so the
 *      same e-ticket revisit returns the same codes.
 *
 * The endpoint scans `pov:used` once and groups entries by issuance
 * event (billId for path 1, personId+sessionId for path 2), enriching
 * each group with the booking record (race date, reservation number,
 * contact info) when one is on file.
 *
 * Date filter targets `issuedAt` (when the code was popped from the
 * pool). Wide window default — 90 days — to give ops a long tail of
 * historical issuance to inspect.
 *
 * Auth: same `x-api-key` (SALES_API_KEYS) as the rest of the admin
 * surface.
 */

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

interface IssuedEntry {
  source: "billId" | "claim-from-credit" | "unknown";
  billId: string | null;
  personId: string | null;
  sessionId: string | null;
  locationId: string | null;
  issuedAt: string;             // earliest usedAt across the codes in this group
  codes: string[];
  codeCount: number;
  email: string | null;
  phone: string | null;
  racerName: string | null;
  raceDate: string | null;       // YYYY-MM-DD ET, from booking record
  reservationNumber: string | null;
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
function isoToETYmd(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

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

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const from = (searchParams.get("from") || daysAgoETYmd(90)).trim();
    const to = (searchParams.get("to") || todayETYmd()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: "Invalid date — use YYYY-MM-DD" }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(2000, parseInt(searchParams.get("limit") || "500", 10) || 500));
    const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);
    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const billIdFilter = (searchParams.get("billId") || "").trim();
    const personIdFilter = (searchParams.get("personId") || "").trim();
    const sourceFilter = (searchParams.get("source") || "").trim();

    // ── Read every issued code ─────────────────────────────────────────
    const issued = await readAllIssued();

    // ── Group into issuance events ────────────────────────────────────
    // billId path → key = `bill:{billId}`
    // claim-from-credit path → key = `person:{personId}:{sessionId}` so
    //   distinct claim sessions stay separate
    // unknown path → key = `code:{code}` (one per code, fall-through)
    const groups = new Map<string, IssuedEntry>();
    for (const [code, meta] of issued) {
      const issuedAt = meta.usedAt || "";
      // ET-day filter — if we have a usedAt, bucket by it. No usedAt =
      // include in everything.
      const ymd = issuedAt ? isoToETYmd(issuedAt) : null;
      if (ymd && (ymd < from || ymd > to)) continue;

      let groupKey: string;
      let source: IssuedEntry["source"];
      if (meta.billId) {
        groupKey = `bill:${meta.billId}`;
        source = "billId";
      } else if (meta.personId != null) {
        groupKey = `person:${meta.personId}:${meta.sessionId ?? "no-session"}`;
        source = "claim-from-credit";
      } else {
        groupKey = `code:${code}`;
        source = "unknown";
      }

      const existing = groups.get(groupKey);
      if (existing) {
        existing.codes.push(code);
        existing.codeCount++;
        if (issuedAt && (!existing.issuedAt || issuedAt < existing.issuedAt)) {
          existing.issuedAt = issuedAt;
        }
        if (!existing.email && meta.email) existing.email = meta.email;
      } else {
        groups.set(groupKey, {
          source,
          billId: meta.billId ?? null,
          personId: meta.personId != null ? String(meta.personId) : null,
          sessionId: meta.sessionId != null ? String(meta.sessionId) : null,
          locationId: meta.locationId ?? null,
          issuedAt: issuedAt || "",
          codes: [code],
          codeCount: 1,
          email: meta.email ?? null,
          phone: null,
          racerName: null,
          raceDate: null,
          reservationNumber: null,
        });
      }
    }

    // ── Booking-record enrichment ──────────────────────────────────────
    const billIds: string[] = [];
    for (const g of groups.values()) if (g.billId) billIds.push(g.billId);
    const bookingByBillId = await readBookingRecords(billIds);
    for (const g of groups.values()) {
      if (g.billId) {
        const b = bookingByBillId.get(g.billId);
        if (b) {
          g.raceDate = b.date ?? null;
          g.reservationNumber = b.reservationNumber ?? null;
          if (!g.email && b.contact?.email) g.email = b.contact.email;
          g.phone = b.contact?.phone ?? null;
          g.racerName = b.contact
            ? `${b.contact.firstName ?? ""} ${b.contact.lastName ?? ""}`.trim() || null
            : null;
        }
      }
    }

    // ── Apply filters ──────────────────────────────────────────────────
    let merged = [...groups.values()];
    if (billIdFilter) merged = merged.filter((e) => e.billId === billIdFilter);
    if (personIdFilter) merged = merged.filter((e) => e.personId === personIdFilter);
    if (sourceFilter) merged = merged.filter((e) => e.source === sourceFilter);
    if (q) {
      merged = merged.filter((e) => {
        const hay = [
          e.email, e.racerName, e.billId, e.personId, e.reservationNumber,
          ...e.codes,
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }

    // Sort newest-first by issuance time, blank issuedAt at the bottom.
    merged.sort((a, b) => {
      if (!a.issuedAt && !b.issuedAt) return 0;
      if (!a.issuedAt) return 1;
      if (!b.issuedAt) return -1;
      return b.issuedAt.localeCompare(a.issuedAt);
    });

    const total = merged.length;
    const paged = merged.slice(offset, offset + limit);

    // Source-of-truth counts for diagnostic header
    const totalCodes = merged.reduce((s, e) => s + e.codeCount, 0);
    const bySource = merged.reduce<Record<string, { events: number; codes: number }>>(
      (acc, e) => {
        const k = e.source;
        if (!acc[k]) acc[k] = { events: 0, codes: 0 };
        acc[k].events++;
        acc[k].codes += e.codeCount;
        return acc;
      },
      {},
    );

    return NextResponse.json(
      {
        range: { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 },
        total,
        totalCodes,
        bySource,
        returned: paged.length,
        entries: paged,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[admin/pov-codes/issued/list]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list issued codes" },
      { status: 500 },
    );
  }
}
