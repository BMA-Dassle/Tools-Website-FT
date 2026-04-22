import { NextRequest, NextResponse } from "next/server";
import { readSmsLog, type SmsLogEntry } from "@/lib/sms-log";
import { getRaceTicket, getGroupTicket, type RaceTicket, type GroupTicket } from "@/lib/race-tickets";
import redis from "@/lib/redis";

/**
 * GET /api/admin/e-tickets/list
 *
 * Reads today's (or `?date=YYYY-MM-DD`) SMS log and enriches each entry
 * with the racer name(s) + session / heat / track info sourced from the
 * underlying ticket record (ticket:{shortCode} or group:{shortCode}).
 *
 * Auth: guarded by middleware.ts (/api/admin/* path + token + IP). If the
 * gate fails, the request never reaches this handler.
 *
 * Query params:
 *   date      — YYYY-MM-DD in ET, defaults to today
 *   source    — optional filter (pre-race-cron | checkin-cron | admin-resend)
 *   phone     — optional exact E.164 match
 *   sessionId — optional filter: entry must cover this session
 *   personId  — optional filter: entry must cover this person
 *   q         — optional free-text filter; matches against racer name
 *               (case-insensitive), phone (digits), or shortCode
 *   limit     — default 100, max 500
 *   offset    — pagination, default 0
 *
 * Response:
 *   {
 *     date, total, returned,
 *     entries: [{
 *       ...SmsLogEntry,
 *       racerNames: string[]     // from ticket record
 *       track?: string
 *       heatNumber?: number
 *       raceType?: string
 *       scheduledStart?: string
 *     }]
 *   }
 */

function todayETYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export type EnrichedLogEntry = SmsLogEntry & {
  racerNames: string[];
  track?: string;
  heatNumber?: number;
  raceType?: string;
  scheduledStart?: string;
};

/**
 * Resolve an SMS log's `shortCode` back to the underlying ticket id.
 *
 * The SMS log stores the 6-char short URL code (redis key `short:{code}` →
 * full URL like `${BASE}/t/{ticketId}` or `${BASE}/g/{groupId}`). The
 * actual ticket record lives at `ticket:{id}` / `group:{id}`. So we have
 * to deref the short-url first, then pull the last path segment.
 *
 * Returns `{ kind, id }` or null if the short-url has already expired or
 * never existed.
 */
async function resolveShortCode(
  shortCode: string,
): Promise<{ kind: "ticket" | "group"; id: string } | null> {
  try {
    const full = await redis.get(`short:${shortCode}`);
    if (!full) return null;
    // Expected shape: https://fasttraxent.com/t/{id} or /g/{id}
    const m = /\/(t|g)\/([A-Za-z0-9_-]+)\b/.exec(full);
    if (!m) return null;
    return { kind: m[1] === "g" ? "group" : "ticket", id: m[2] };
  } catch {
    return null;
  }
}

async function enrichEntry(entry: SmsLogEntry): Promise<EnrichedLogEntry> {
  const out: EnrichedLogEntry = { ...entry, racerNames: [] };
  if (!entry.shortCode) return out;

  // 1. Deref short-code → ticket id.
  const ref = await resolveShortCode(entry.shortCode);
  if (!ref) {
    // Short URL expired (TTL lapsed) or never existed — row renders with
    // "(no ticket)" in the UI. That's fine, still resendable by shortCode.
    return out;
  }

  // 2. Pull the actual record.
  if (ref.kind === "ticket") {
    const tix: RaceTicket | null = await getRaceTicket(ref.id);
    if (tix) {
      const name = `${tix.firstName ?? ""} ${tix.lastName ?? ""}`.trim();
      if (name) out.racerNames.push(name);
      out.track = tix.track;
      out.heatNumber = tix.heatNumber;
      out.raceType = tix.raceType;
      out.scheduledStart = tix.scheduledStart;
    }
    return out;
  }

  const grp: GroupTicket | null = await getGroupTicket(ref.id);
  if (grp) {
    for (const m of grp.members || []) {
      const name = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
      if (name) out.racerNames.push(name);
    }
    // Use the first member's session info as the primary display
    const first = grp.members?.[0];
    if (first) {
      out.track = first.track;
      out.heatNumber = first.heatNumber;
      out.raceType = first.raceType;
      out.scheduledStart = first.scheduledStart;
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const date = (searchParams.get("date") || todayETYmd()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — use YYYY-MM-DD" }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(500, parseInt(searchParams.get("limit") || "100", 10) || 100));
    const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);

    const source = searchParams.get("source");
    const phone = searchParams.get("phone");
    const sessionId = searchParams.get("sessionId");
    const personId = searchParams.get("personId");
    const q = (searchParams.get("q") || "").trim().toLowerCase();

    // Pull a generous pool so filters don't starve the page.
    const poolSize = Math.min(2000, Math.max(limit * 5, 500));
    const pool = await readSmsLog(date, { limit: poolSize, offset: 0 });

    // Pre-filter by fields that live on SmsLogEntry directly.
    const preFiltered = pool.filter((e) => {
      if (source && e.source !== source) return false;
      if (phone && e.phone !== phone) return false;
      if (sessionId && !(e.sessionIds || []).map(String).includes(sessionId)) return false;
      if (personId && !(e.personIds || []).map(String).includes(personId)) return false;
      return true;
    });

    // Enrich in parallel — up to `poolSize` entries but typically <= 500/day.
    const enriched = await Promise.all(preFiltered.map(enrichEntry));

    // Apply free-text filter against enriched fields.
    const filtered = q
      ? enriched.filter((e) => {
          if (e.phone?.includes(q)) return true;
          if (e.shortCode?.toLowerCase().includes(q)) return true;
          for (const n of e.racerNames) {
            if (n.toLowerCase().includes(q)) return true;
          }
          return false;
        })
      : enriched;

    const paged = filtered.slice(offset, offset + limit);

    return NextResponse.json(
      { date, total: filtered.length, returned: paged.length, entries: paged },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[admin/e-tickets/list]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list" },
      { status: 500 },
    );
  }
}
