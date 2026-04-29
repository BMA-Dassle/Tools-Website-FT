import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import redis from "@/lib/redis";
import {
  upsertRaceTicket,
  upsertGroupTicket,
  type RaceTicket,
  type GroupTicketMember,
} from "@/lib/race-tickets";
import {
  canonicalizePhone,
  hasSmsConsent,
  pickContactChannel,
  pickContactWithGuardianFallback,
  pickPhone,
  type ContactCandidate,
  type Participant,
} from "@/lib/participant-contact";
import { logSms, logCronRun } from "@/lib/sms-log";
import { queueRetry, drainRetries, voxSend } from "@/lib/sms-retry";

/**
 * Flow B — "Now checking in" alert cron.
 *
 * Every minute:
 *   1. Pull /api/pandora/races-current  → { blue, red, mega } with sessionId etc.
 *   2. For each non-null track not yet alerted on, pull participants.
 *   3. Bucket fresh SMS candidates by canonical phone. Single-phone-single-person
 *      uses the existing /t/{id} ticket; multi-member phones get one grouped SMS
 *      + /g/{id} page.
 *   4. Email path is one-per-person.
 *
 * Query params:
 *   ?dryRun=1  — log who would receive but don't send
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const VOX_API_KEY = process.env.VOX_API_KEY || "";
const VOX_FROM = "+12394819666";
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const SHORT_TTL = 60 * 60 * 24 * 90;
const DEDUP_TTL = 60 * 60 * 6;

interface CurrentRace {
  trackName: string;
  raceType: string;
  heatNumber: number;
  scheduledStart: string;
  calledAt: string;
  sessionId: number;
}
type TrackKey = "blue" | "red" | "mega";
type CurrentRaces = Record<TrackKey, CurrentRace | null>;

interface Candidate {
  race: CurrentRace;
  trackDisplay: string;
  participant: Participant;
  /** Picker's verdict — racer's own contact, or guardian fallback for
   *  minors. null when neither is reachable (silent skip). */
  resolved?: ContactCandidate | null;
}

async function fetchCurrentRaces(): Promise<CurrentRaces> {
  const res = await fetch(`${BASE}/api/pandora/races-current`, { cache: "no-store" });
  if (!res.ok) return { blue: null, red: null, mega: null };
  return (await res.json()) as CurrentRaces;
}

async function fetchParticipants(sessionId: number): Promise<Participant[]> {
  // warm=1 → 30s upstream timeout. Cron-warmup path; no user is
  // waiting on this. Populates Redis so user-facing calls hit cache.
  const res = await fetch(
    `${BASE}/api/pandora/session-participants?locationId=${FASTTRAX_LOCATION_ID}&sessionId=${sessionId}&warm=1`,
    {
      cache: "no-store",
      // Server-only call — pass the internal trust header so the
      // proxy returns full PII (needed to address SMS). Public
      // e-ticket browser calls never include this header.
      headers: { "x-pandora-internal": process.env.SWAGGER_ADMIN_KEY || "" },
    },
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? (data.data as Participant[]) : [];
}

/**
 * Pull the personIds that Pandora knows about for this session in
 * ANY state — registered, removed, unpaid. Used purely to dedup
 * express-lane racers below: if Pandora has any record of them at
 * all (even "removed"), we trust Pandora's roster and skip the
 * express-lane path so a scratched racer doesn't get SMS'd via
 * the fastLane shortcut.
 *
 * Without this, a returning racer who:
 *   1. booked /book/race with a valid waiver (got `fastLane: true`
 *      stamped on their bookingrecord),
 *   2. checked in,
 *   3. was scratched by staff,
 * would disappear from the filtered participants list (correctly,
 * because excludeRemoved=true is the proxy default) but stay in
 * the `bookingrecord:express:session:*` index — and the existing
 * dedup (`!pandoraPids.has(pid)`) wouldn't catch them because
 * `pandoraPids` only saw the active list.
 */
async function fetchPandoraPidsAnyState(sessionId: number): Promise<Set<string>> {
  const res = await fetch(
    `${BASE}/api/pandora/session-participants?locationId=${FASTTRAX_LOCATION_ID}&sessionId=${sessionId}&excludeRemoved=false&excludeUnpaid=false&warm=1`,
    {
      cache: "no-store",
      // PersonId-only is fine here, but pass the internal header for
      // consistency with other server callers. Public response would
      // also work since it returns personIds — but matching the
      // contract avoids breakage if the lean response shape ever
      // changes.
      headers: { "x-pandora-internal": process.env.SWAGGER_ADMIN_KEY || "" },
    },
  );
  if (!res.ok) return new Set();
  const data = await res.json();
  const list = Array.isArray(data?.data) ? (data.data as { personId: string | number }[]) : [];
  return new Set(list.map((p) => String(p.personId)));
}

interface ExpressBookingRacer {
  personId?: string | number;
  racerName?: string;
  firstName?: string;
  lastName?: string;
  sessionId?: string | number;
}

interface ExpressBookingRecord {
  billId?: string;
  fastLane?: boolean;
  racers?: ExpressBookingRacer[];
  contact?: { email?: string; phone?: string; firstName?: string };
}

/**
 * Read express-lane booking holders for a Pandora session. These racers
 * bypass Guest Services so they're NOT on Pandora's participant list — we
 * source them from our own bookingrecord store instead.
 *
 * The per-racer contact info lives on the booking's `contact` object (shared
 * by all racers on the booking — typically the primary purchaser's phone +
 * email). Family bookings naturally collapse into one grouped SMS via the
 * phone-bucketing in the main cron loop.
 */
async function fetchExpressParticipants(sessionId: number): Promise<Participant[]> {
  try {
    const billIds = await redis.smembers(`bookingrecord:express:session:${sessionId}`);
    if (!billIds?.length) return [];

    const out: Participant[] = [];
    for (const billId of billIds) {
      const raw = await redis.get(`bookingrecord:${billId}`);
      if (!raw) continue;
      let rec: ExpressBookingRecord;
      try { rec = JSON.parse(raw) as ExpressBookingRecord; } catch { continue; }
      if (rec.fastLane !== true) continue;
      const contact = rec.contact || {};
      const phone = contact.phone || null;
      const email = contact.email || null;
      for (const r of rec.racers || []) {
        // Defensive filter — index should already match, but a booking covers
        // multiple heats and each racer carries its own sessionId.
        if (String(r.sessionId ?? "") !== String(sessionId)) continue;
        if (!r.personId) continue;
        const firstName = r.firstName || (r.racerName ? r.racerName.split(" ")[0] : "") || "Racer";
        const lastName = r.lastName || (r.racerName ? r.racerName.split(" ").slice(1).join(" ") : "") || "";
        out.push({
          personId: r.personId,
          firstName,
          lastName,
          email,
          mobilePhone: phone,
          // No consent flag on booking records — pickContactChannel's legacy
          // fallback will send via SMS when a phone is present.
          acceptSmsCommercial: undefined,
          acceptMailCommercial: undefined,
        });
      }
    }
    return out;
  } catch (err) {
    console.error(`[checkin-alerts] fetchExpressParticipants error for session=${sessionId}:`, err);
    return [];
  }
}

/**
 * Normalize any ISO-ish datetime to ET wall-clock minute ("YYYY-MM-DDTHH:MM").
 * Mirrors the logic in `attachSessionIds` on the confirmation page so
 * lookups line up across the two call sites.
 *
 *   "2026-04-21T21:48:00"       → "2026-04-21T21:48"  (naive, assumed ET)
 *   "2026-04-22T01:48:00Z"      → "2026-04-21T21:48"  (UTC → ET)
 *   "2026-04-21T22:00:00-04:00" → "2026-04-21T22:00"  (TZ offset → ET)
 */
function etMinuteKey(iso: string): string {
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(iso)) return iso.slice(0, 16);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Today's ET date as YYYY-MM-DD — keys `bookingrecord:date:{ymd}`. */
function todayETYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * Self-healing backfill for the express-session reverse index.
 *
 * Background: when a guest books via the express lane, the confirmation
 * page calls `attachSessionIds` which tries to map each racer to a
 * Pandora sessionId via `/api/pandora/sessions` — that upstream endpoint
 * currently returns 404 (Pandora regression). The result: every
 * express booking saves with no sessionId on its racers, and the
 * `bookingrecord:express:session:{sessionId}` reverse index that this
 * cron reads from never gets populated. Express holders silently miss
 * their check-in SMS.
 *
 * This function sidesteps the broken upstream. When the cron detects
 * an active session (via `/races-current`, which works), we scan
 * today's booking records and match any fastLane booking whose racer's
 * (track, heatStart-minute-in-ET) matches this active session's
 * (trackName, scheduledStart-minute-in-ET). Matches get added to the
 * reverse index on the fly, and the racer's sessionId is patched on
 * the record itself so downstream (email, race-day, etc.) works too.
 *
 * Returns `{ added, scanned }` for logging.
 */
async function backfillExpressSessionIndex(race: CurrentRace): Promise<{ added: number; scanned: number }> {
  try {
    const todayYmd = todayETYmd();
    const billIds = await redis.smembers(`bookingrecord:date:${todayYmd}`);
    if (!billIds?.length) return { added: 0, scanned: 0 };

    const sessTrackLower = (race.trackName || "").toLowerCase(); // "mega" | "blue" | "red" (or "blue track" / "red track")
    const sessMinute = etMinuteKey(race.scheduledStart);
    const indexKey = `bookingrecord:express:session:${race.sessionId}`;

    let added = 0;
    for (const billId of billIds) {
      const raw = await redis.get(`bookingrecord:${billId}`);
      if (!raw) continue;
      let rec: {
        fastLane?: boolean;
        racers?: Array<{ track?: string | null; heatStart?: string; sessionId?: string | number | null }>;
      };
      try { rec = JSON.parse(raw); } catch { continue; }
      if (rec.fastLane !== true || !Array.isArray(rec.racers)) continue;

      // Does ANY racer on this booking belong to the active session?
      // Normalize both sides: "Mega" === "mega", "Blue" === "blue track", etc.
      let patched = false;
      const hit = rec.racers.some((r) => {
        const rt = (r.track || "").toLowerCase();
        // Accept "mega" ≈ "mega", "blue" ≈ "blue track", "red" ≈ "red track"
        const tracksMatch =
          rt === sessTrackLower ||
          sessTrackLower.startsWith(rt) ||
          rt.startsWith(sessTrackLower);
        if (!tracksMatch) return false;
        if (!r.heatStart) return false;
        return etMinuteKey(r.heatStart) === sessMinute;
      });
      if (!hit) continue;

      const wasMember = await redis.sismember(indexKey, billId);
      if (!wasMember) {
        await redis.sadd(indexKey, billId);
        await redis.expire(indexKey, SHORT_TTL);
        added++;
      }

      // Patch the record's racers with the discovered sessionId so
      // email / race-day / confirmation-reload paths also see it.
      for (const r of rec.racers) {
        if (r.sessionId) continue;
        const rt = (r.track || "").toLowerCase();
        const tracksMatch =
          rt === sessTrackLower ||
          sessTrackLower.startsWith(rt) ||
          rt.startsWith(sessTrackLower);
        if (!tracksMatch) continue;
        if (!r.heatStart || etMinuteKey(r.heatStart) !== sessMinute) continue;
        r.sessionId = race.sessionId;
        patched = true;
      }
      if (patched) {
        await redis.set(`bookingrecord:${billId}`, JSON.stringify(rec), "EX", SHORT_TTL);
      }
    }
    if (added > 0) {
      console.log(`[checkin-alerts] backfill session=${race.sessionId} scanned=${billIds.length} added=${added}`);
    }
    return { added, scanned: billIds.length };
  } catch (err) {
    console.error(`[checkin-alerts] backfillExpressSessionIndex error for session=${race.sessionId}:`, err);
    return { added: 0, scanned: 0 };
  }
}

async function shortenUrl(fullUrl: string): Promise<{ code: string; url: string }> {
  const code = randomBytes(4).toString("base64url").slice(0, 6);
  await redis.set(`short:${code}`, fullUrl, "EX", SHORT_TTL);
  return { code, url: `${BASE}/s/${code}` };
}

interface SmsAudit {
  sessionIds: (string | number)[];
  personIds: (string | number)[];
  memberCount: number;
  shortCode?: string;
  /** True when this SMS was routed via guardian fallback. Surfaces
   *  on the SMS log entry so admin can render the via-guardian badge. */
  viaGuardian?: boolean;
}

async function sendSms(to: string, body: string, audit: SmsAudit): Promise<boolean> {
  const ts = new Date().toISOString();
  const toFormatted = canonicalizePhone(to);
  if (!VOX_API_KEY) {
    console.error("[checkin-alerts] VOX_API_KEY missing");
    await logSms({ ts, phone: toFormatted || to, source: "checkin-cron", status: null, ok: false, error: "VOX_API_KEY missing", body, ...audit });
    return false;
  }
  if (!toFormatted) {
    await logSms({ ts, phone: to, source: "checkin-cron", status: null, ok: false, error: "invalid phone format", body, ...audit });
    return false;
  }

  const result = await voxSend(toFormatted, body);
  if (result.ok) {
    await logSms({
      ts, phone: toFormatted, source: "checkin-cron",
      status: result.status, ok: true, body,
      provider: result.provider, failedOver: result.failedOver,
      // Carry voxId so the Vox status webhook can update this
      // entry's deliveryStatus when the carrier reports back.
      providerMessageId: result.voxId,
      ...audit,
    });
    return true;
  }

  // Quota / daily-limit hit — route to the long-lived quota queue.
  if (result.skipped || result.quotaHit) {
    const { quotaEnqueue } = await import("@/lib/sms-quota");
    await quotaEnqueue({
      phone: toFormatted,
      body,
      source: "checkin-cron",
      queuedAt: ts,
      shortCode: audit.shortCode,
      audit: { sessionIds: audit.sessionIds, personIds: audit.personIds, memberCount: audit.memberCount },
    });
    await logSms({
      ts, phone: toFormatted, source: "checkin-cron",
      status: result.status, ok: false,
      error: `[quota] queued for next reset window (${result.error || "429"})`,
      body, ...audit,
    });
    return false;
  }

  console.error(`[checkin-alerts] SMS ${result.status}: ${result.error}`);
  await logSms({ ts, phone: toFormatted, source: "checkin-cron", status: result.status, ok: false, error: result.error || "", body, ...audit });
  await queueRetry({ cron: "checkin-cron", phone: toFormatted, body, audit, status: result.status, error: result.error || "" });
  return false;
}

// Retry drain is centralized in lib/sms-retry.ts so the sweep cron can
// reuse it without duplicating Voxtelesys send + dedup-setting logic.

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.error("[checkin-alerts] SENDGRID_API_KEY missing");
    return false;
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: SENDGRID_FROM_EMAIL, name: "FastTrax Entertainment" },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("[checkin-alerts] Email error:", err);
    return false;
  }
}

function timeET(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
    });
  } catch { return ""; }
}

function raceHeader(race: CurrentRace): string {
  return `${race.heatNumber} - ${race.trackName} ${race.raceType} · ${timeET(race.scheduledStart)}`;
}

function racerLabel(m: { firstName: string; lastName: string }): string {
  return `${m.firstName} ${m.lastName}`.trim() || m.firstName || "Racer";
}

function buildSingleSmsBody(race: CurrentRace, member: GroupTicketMember, shortUrl: string): string {
  return [
    `FastTrax · NOW CHECKING IN`,
    ``,
    raceHeader(race),
    racerLabel(member),
    ``,
    `Head to Karting · 1st Floor NOW.`,
    `Have your e-ticket OPEN and ready: ${shortUrl}`,
    ``,
    `Lockers are in the briefing room — no loose items on the track.`,
  ].join("\n");
}

function buildGroupSmsBody(members: GroupTicketMember[], shortUrl: string): string {
  const bySession = new Map<string, GroupTicketMember[]>();
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  for (const m of sorted) {
    const k = String(m.sessionId);
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(m);
  }
  const lines: string[] = [`FastTrax · NOW CHECKING IN`];
  for (const group of bySession.values()) {
    const first = group[0];
    lines.push(``);
    lines.push(`${first.heatNumber} - ${first.track} ${first.raceType} · ${timeET(first.scheduledStart)}`);
    for (const m of group) lines.push(`- ${racerLabel(m)}`);
  }
  lines.push(``);
  lines.push(`Head to Karting · 1st Floor NOW.`);
  lines.push(`Have your e-tickets OPEN and ready: ${shortUrl}`);
  lines.push(``);
  lines.push(`Lockers are in the briefing room — no loose items on the track.`);
  return lines.join("\n");
}

/**
 * Guardian-flavored single-racer check-in SMS — heat just got called,
 * the parent needs to know whose race is up + send their kid to
 * Karting NOW. Action first, then per-kid line.
 */
function buildGuardianSingleSmsBody(member: GroupTicketMember, shortUrl: string): string {
  return [
    `FastTrax · NOW CHECKING IN`,
    ``,
    `Your racer's heat is up — head to Karting · 1st Floor NOW`,
    ``,
    `- ${racerLabel(member)} — ${member.track} Heat ${member.heatNumber} · ${timeET(member.scheduledStart)}`,
    ``,
    `Have the e-ticket OPEN and ready: ${shortUrl}`,
    ``,
    `Lockers are in the briefing room — no loose items on the track.`,
  ].join("\n");
}

/**
 * Guardian-flavored multi-racer check-in SMS — only fires when
 * multiple kids' heats are called in the same cron tick (rare but
 * possible across tracks). Same urgency framing.
 */
function buildGuardianGroupSmsBody(members: GroupTicketMember[], shortUrl: string): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const lines: string[] = [
    `FastTrax · NOW CHECKING IN`,
    ``,
    `Your racers are up — head to Karting · 1st Floor NOW`,
    ``,
  ];
  for (const m of sorted) {
    lines.push(`- ${racerLabel(m)} — ${m.track} Heat ${m.heatNumber} · ${timeET(m.scheduledStart)}`);
  }
  lines.push(``);
  lines.push(`Have the e-tickets OPEN and ready: ${shortUrl}`);
  lines.push(``);
  lines.push(`Lockers are in the briefing room — no loose items on the track.`);
  return lines.join("\n");
}

function buildEmailHtml(race: CurrentRace, firstName: string, shortUrl: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#10b981;padding:22px 28px;color:#fff;text-align:center">
          <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;opacity:0.9">FastTrax Entertainment</p>
          <h1 style="margin:0;font-size:26px;letter-spacing:-0.5px">🏁 Your Heat Is Checking In</h1>
        </td></tr>
        <tr><td style="padding:26px 28px">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.5">Hey ${firstName} — your <strong>${race.trackName} ${race.raceType} Race ${race.heatNumber}</strong> is now checking in.</p>
          <p style="margin:0 0 20px 0;font-size:15px;line-height:1.5">Head straight to the <strong>Karting counter on the 1st Floor</strong>. Skip guest services if you've already checked in.</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${shortUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">View Your E-Ticket</a>
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#888;text-align:center">No paper ticket is needed. Show your e-ticket screen at check-in.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Grouped check-in email — used when 2+ racers share a destination
 * email (guardian fallback OR shared family inbox). Same urgent tone
 * as the single-recipient email, but lists all kids at once.
 */
function buildGroupEmailHtml(
  members: GroupTicketMember[],
  shortUrl: string,
  recipient: "racer" | "guardian",
): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const heading = recipient === "guardian"
    ? `🏁 Your Racers Are Checking In`
    : `🏁 Your Heats Are Checking In`;
  const intro = recipient === "guardian"
    ? `Heads up — your racers' heats are now checking in.`
    : `Heads up — your heats are now checking in.`;
  const rows = sorted.map((m) => {
    return `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">
      <strong style="color:#1a1a1a">${racerLabel(m)}</strong>
      <span style="color:#555"> — ${m.track} ${m.raceType} Heat ${m.heatNumber}</span>
      <span style="color:#888"> · ${timeET(m.scheduledStart)}</span>
    </td></tr>`;
  }).join("");
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#10b981;padding:22px 28px;color:#fff;text-align:center">
          <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;opacity:0.9">FastTrax Entertainment</p>
          <h1 style="margin:0;font-size:26px;letter-spacing:-0.5px">${heading}</h1>
        </td></tr>
        <tr><td style="padding:26px 28px">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.5">${intro}</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;font-size:15px">${rows}</table>
          <p style="margin:0 0 20px 0;font-size:15px;line-height:1.5">Head straight to the <strong>Karting counter on the 1st Floor</strong>. Skip guest services if you've already checked in.</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${shortUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">View E-Tickets</a>
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#888;text-align:center">Show the e-ticket screen at check-in. No paper ticket needed.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function trackFromName(name: string): { key: TrackKey; display: string } | null {
  const n = name.toLowerCase();
  if (n.includes("blue")) return { key: "blue", display: "Blue" };
  if (n.includes("red")) return { key: "red", display: "Red" };
  if (n.includes("mega")) return { key: "mega", display: "Mega" };
  return null;
}

function memberFromCandidate(c: Candidate): GroupTicketMember {
  return {
    sessionId: c.race.sessionId,
    personId: c.participant.personId,
    firstName: c.participant.firstName || "Racer",
    lastName: c.participant.lastName || "",
    scheduledStart: c.race.scheduledStart,
    track: c.trackDisplay,
    raceType: c.race.raceType,
    heatNumber: c.race.heatNumber,
  };
}

function personDedupKey(c: Candidate): string {
  return `alert:checkin:${c.race.sessionId}:${c.participant.personId}`;
}

export async function GET(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();
  const now = Date.now();

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let groupedSmsSends = 0;
  let singleSmsSends = 0;
  let emailSends = 0;
  const sessionResults: { track: string; sessionId: number; reason?: string }[] = [];
  const retryStats = !dryRun ? await drainRetries("checkin-cron") : { attempted: 0, ok: 0, requeued: 0, dead: 0 };

  try {
    const races = await fetchCurrentRaces();
    const entries: [TrackKey, CurrentRace | null][] = [
      ["blue", races.blue],
      ["red", races.red],
      ["mega", races.mega],
    ];

    const candidates: Candidate[] = [];

    for (const [trackKey, race] of entries) {
      if (!race) continue;
      const sessionId = race.sessionId;

      // Mark this session as "called for check-in" — the ticket page uses
      // this signal to flip to MissedCard once Pandora drops the session
      // from /races-current (roughly 20 min after the heat is called).
      // TTL 12h so the flag persists through the whole operating day.
      if (!dryRun) {
        await redis.set(`race:called:${sessionId}`, "1", "EX", 60 * 60 * 12);
      }

      const scheduledMs = new Date(race.scheduledStart).getTime();
      if (!isNaN(scheduledMs) && scheduledMs < now - 30 * 60_000) {
        sessionResults.push({ track: trackKey, sessionId, reason: "stale" });
        continue;
      }

      const sessionKey = `alert:checkin:session:${sessionId}`;
      if (!dryRun && (await redis.get(sessionKey))) {
        sessionResults.push({ track: trackKey, sessionId, reason: "session-already-alerted" });
        continue;
      }

      // Self-heal the express-session reverse index first — if Pandora's
      // sessions-list endpoint was down when today's express bookings got
      // saved, the index will be empty and fetchExpressParticipants will
      // return []. The backfill scans today's fastLane bookings and matches
      // on (track, heatStart-minute-in-ET) to this active session, so
      // express holders get picked up even if sessionId never landed on
      // their racer record.
      const backfill = await backfillExpressSessionIndex(race);
      if (backfill.added > 0) {
        sessionResults.push({ track: trackKey, sessionId, note: `express-backfill: +${backfill.added}` } as typeof sessionResults[number] & { note: string });
      }

      const [participants, allPandoraPids, expressHolders] = await Promise.all([
        fetchParticipants(sessionId),
        fetchPandoraPidsAnyState(sessionId),
        fetchExpressParticipants(sessionId),
      ]);

      if (participants.length === 0 && expressHolders.length === 0) {
        sessionResults.push({ track: trackKey, sessionId, reason: "no-participants" });
        continue;
      }

      // Dedup express holders against the FULL Pandora roster (all
      // states, including removed). Two cases this catches:
      //   1. Racer is currently registered → already covered by the
      //      `participants` list, no need for the express path.
      //   2. Racer was registered AND THEN scratched by staff →
      //      filtered out of `participants` (correct), but still in
      //      our fastLane Redis index. The all-state set still
      //      contains their pid, so we skip — no stale check-in SMS.
      const freshExpress = expressHolders.filter((e) => !allPandoraPids.has(String(e.personId)));

      const trackDisplay = trackFromName(race.trackName)?.display || race.trackName;
      for (const p of participants) {
        candidates.push({ race, trackDisplay, participant: p });
      }
      for (const p of freshExpress) {
        candidates.push({ race, trackDisplay, participant: p });
      }
      sessionResults.push({ track: trackKey, sessionId });
    }

    // Resolve each candidate via the new picker (racer first, guardian
    // fallback for minors). Bucket SMS by destination phone, email by
    // destination email. No-consent racers (own phone opted out, no
    // guardian fallback) get logged separately for admin "needs verbal
    // OK" visibility.
    //
    // NOTE on cadence: this cron only sees racers in CURRENTLY-CALLED
    // heats per `/races-current`. Multi-member buckets only form when
    // multiple kids' heats land in the same minute-tick, which means
    // the grouped message is naturally same-call (not a delayed
    // collapse of heats called minutes apart). See the plan file's
    // "Check-in vs. pre-race grouping cadence" section.
    const freshSmsByPhone = new Map<string, Candidate[]>();
    const allByPhone = new Map<string, Candidate[]>();
    const freshEmailByEmail = new Map<string, Candidate[]>();
    const allByEmail = new Map<string, Candidate[]>();
    const noConsentByPhone = new Map<string, Candidate[]>();

    for (const c of candidates) {
      const resolved = pickContactWithGuardianFallback(c.participant);
      c.resolved = resolved ?? null;

      if (!resolved) {
        const racerPhone = canonicalizePhone(pickPhone(c.participant));
        if (racerPhone && !hasSmsConsent(c.participant)) {
          if (!noConsentByPhone.has(racerPhone)) noConsentByPhone.set(racerPhone, []);
          noConsentByPhone.get(racerPhone)!.push(c);
        }
        skipped++;
        continue;
      }

      if (resolved.phone) {
        const phone = resolved.phone;
        if (!allByPhone.has(phone)) allByPhone.set(phone, []);
        allByPhone.get(phone)!.push(c);

        const already = !dryRun && (await redis.get(personDedupKey(c)));
        if (already) {
          skipped++;
          continue;
        }
        if (!freshSmsByPhone.has(phone)) freshSmsByPhone.set(phone, []);
        freshSmsByPhone.get(phone)!.push(c);
      } else if (resolved.email) {
        const emailKey = resolved.email.trim().toLowerCase();
        if (!allByEmail.has(emailKey)) allByEmail.set(emailKey, []);
        allByEmail.get(emailKey)!.push(c);

        const already = !dryRun && (await redis.get(personDedupKey(c)));
        if (already) {
          skipped++;
          continue;
        }
        if (!freshEmailByEmail.has(emailKey)) freshEmailByEmail.set(emailKey, []);
        freshEmailByEmail.get(emailKey)!.push(c);
      } else {
        skipped++;
      }
    }

    // Session-level locks to set after successful grouped/single sends per session.
    const sessionsWithSends = new Set<number>();

    // SMS path — single vs grouped, racer- vs guardian-flavored.
    for (const [phone, fresh] of freshSmsByPhone) {
      const all = allByPhone.get(phone) || fresh;
      const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
      const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved?.contactFirstName;

      if (all.length === 1) {
        const c = fresh[0];
        const ticket: RaceTicket = {
          sessionId: c.race.sessionId,
          locationId: FASTTRAX_LOCATION_ID,
          personId: c.participant.personId,
          firstName: c.participant.firstName || "Racer",
          lastName: c.participant.lastName || "",
          email: c.participant.email || undefined,
          phone: pickPhone(c.participant) || undefined,
          scheduledStart: c.race.scheduledStart,
          track: c.trackDisplay,
          raceType: c.race.raceType,
          heatNumber: c.race.heatNumber,
          viaGuardian: isGuardianFlavored || undefined,
          guardianFirstName: isGuardianFlavored ? guardianFirstName : undefined,
        };

        if (dryRun) {
          console.log(
            `[checkin-alerts DRY] would sms ${phone} (1 racer: ${c.participant.firstName} ${c.participant.lastName}, session=${c.race.sessionId}${isGuardianFlavored ? ", via guardian" : ""})`,
          );
          continue;
        }

        try {
          const ticketId = await upsertRaceTicket(ticket);
          const { code, url } = await shortenUrl(`${BASE}/t/${ticketId}`);
          const member = memberFromCandidate(c);
          const body = isGuardianFlavored
            ? buildGuardianSingleSmsBody(member, url)
            : buildSingleSmsBody(c.race, member, url);
          const ok = await sendSms(
            phone,
            body,
            {
              sessionIds: [c.race.sessionId],
              personIds: [c.participant.personId],
              memberCount: 1,
              shortCode: code,
              viaGuardian: isGuardianFlavored,
            },
          );
          if (ok) {
            await redis.set(personDedupKey(c), "1", "EX", DEDUP_TTL);
            sent++;
            singleSmsSends++;
            sessionsWithSends.add(c.race.sessionId);
          } else {
            errors++;
          }
        } catch (err) {
          console.error(`[checkin-alerts] single-sms error for phone=${phone}:`, err);
          errors++;
        }
        continue;
      }

      // Grouped — only fires when multiple racers' heats are CALLED IN
      // THE SAME TICK on this destination phone (e.g., parent-of-2-kids
      // whose heats happen to start on different tracks at once).
      const members: GroupTicketMember[] = all.map(memberFromCandidate);
      if (dryRun) {
        const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
        console.log(
          `[checkin-alerts DRY] would sms ${phone} for ${members.length} members: ${names} (fresh=${fresh.length}${isGuardianFlavored ? ", via guardian" : ""})`,
        );
        continue;
      }

      try {
        const groupId = await upsertGroupTicket({
          phone,
          locationId: FASTTRAX_LOCATION_ID,
          members,
          recipient: isGuardianFlavored ? "guardian" : "racer",
          guardianFirstName: isGuardianFlavored ? guardianFirstName : undefined,
        });
        const { code, url } = await shortenUrl(`${BASE}/g/${groupId}`);
        const body = isGuardianFlavored
          ? buildGuardianGroupSmsBody(members, url)
          : buildGroupSmsBody(members, url);
        const ok = await sendSms(phone, body, {
          sessionIds: Array.from(new Set(members.map((m) => m.sessionId))),
          personIds: members.map((m) => m.personId),
          memberCount: members.length,
          shortCode: code,
          viaGuardian: isGuardianFlavored,
        });
        if (ok) {
          for (const c of fresh) {
            await redis.set(personDedupKey(c), "1", "EX", DEDUP_TTL);
            sessionsWithSends.add(c.race.sessionId);
          }
          sent += fresh.length;
          groupedSmsSends++;
        } else {
          errors += fresh.length;
        }
      } catch (err) {
        console.error(`[checkin-alerts] group-sms error for phone=${phone}:`, err);
        errors += fresh.length;
      }
    }

    // No-consent path — racers whose own phone is opted out AND who
    // had no guardian fallback. Log "needs verbal OK" with 30-min
    // dedup so the admin board can surface them for manual resend.
    for (const [phone, members] of noConsentByPhone) {
      const consentSkipKey = `consent-skip:checkin:${phone}`;
      const already = !dryRun && (await redis.get(consentSkipKey));
      if (already) {
        skipped += members.length;
        continue;
      }
      if (dryRun) {
        skipped += members.length;
        continue;
      }
      try {
        const sessionIds = Array.from(new Set(members.map((c) => c.race.sessionId)));
        const personIds = members.map((c) => c.participant.personId);
        let body: string;
        let shortCode: string;
        if (members.length === 1) {
          const c = members[0];
          const ticket: RaceTicket = {
            sessionId: c.race.sessionId,
            locationId: FASTTRAX_LOCATION_ID,
            personId: c.participant.personId,
            firstName: c.participant.firstName || "Racer",
            lastName: c.participant.lastName || "",
            email: c.participant.email || undefined,
            phone: pickPhone(c.participant) || undefined,
            scheduledStart: c.race.scheduledStart,
            track: c.trackDisplay,
            raceType: c.race.raceType,
            heatNumber: c.race.heatNumber,
          };
          const ticketId = await upsertRaceTicket(ticket);
          const shortened = await shortenUrl(`${BASE}/t/${ticketId}`);
          shortCode = shortened.code;
          body = buildSingleSmsBody(c.race, memberFromCandidate(c), shortened.url);
        } else {
          const groupMembers: GroupTicketMember[] = members.map(memberFromCandidate);
          const groupId = await upsertGroupTicket({
            phone,
            locationId: FASTTRAX_LOCATION_ID,
            members: groupMembers,
          });
          const shortened = await shortenUrl(`${BASE}/g/${groupId}`);
          shortCode = shortened.code;
          body = buildGroupSmsBody(groupMembers, shortened.url);
        }
        await logSms({
          ts: new Date().toISOString(),
          phone,
          source: "checkin-cron",
          status: null,
          ok: false,
          error: "SMS not opted in",
          body,
          sessionIds,
          personIds,
          memberCount: members.length,
          shortCode,
        });
        await redis.set(consentSkipKey, "1", "EX", 30 * 60);
      } catch (err) {
        console.error(`[checkin-alerts] consent-skip log error for phone=${phone}:`, err);
      }
      skipped += members.length;
    }

    // Email path — bucket by destination email. Multiple racers (guardian
    // fallback OR shared family inbox) collapse into ONE combined email.
    for (const [emailKey, fresh] of freshEmailByEmail) {
      const all = allByEmail.get(emailKey) || fresh;
      const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
      const displayEmail = fresh[0].resolved?.email || emailKey;

      if (all.length === 1) {
        const c = fresh[0];
        const ticket: RaceTicket = {
          sessionId: c.race.sessionId,
          locationId: FASTTRAX_LOCATION_ID,
          personId: c.participant.personId,
          firstName: c.participant.firstName || "Racer",
          lastName: c.participant.lastName || "",
          email: c.participant.email || undefined,
          phone: pickPhone(c.participant) || undefined,
          scheduledStart: c.race.scheduledStart,
          track: c.trackDisplay,
          raceType: c.race.raceType,
          heatNumber: c.race.heatNumber,
          viaGuardian: isGuardianFlavored || undefined,
          guardianFirstName: isGuardianFlavored ? c.resolved?.contactFirstName : undefined,
        };

        if (dryRun) {
          console.log(
            `[checkin-alerts DRY] would email ${displayEmail} (${c.participant.firstName} ${c.participant.lastName}, session=${c.race.sessionId}${isGuardianFlavored ? ", via guardian" : ""})`,
          );
          continue;
        }

        try {
          const ticketId = await upsertRaceTicket(ticket);
          const { url } = await shortenUrl(`${BASE}/t/${ticketId}`);
          const subject = isGuardianFlavored
            ? `Your racer's heat is checking in — head to Karting 1st Floor`
            : `Your heat is checking in — head to Karting 1st Floor`;
          const html = isGuardianFlavored
            ? buildGroupEmailHtml([memberFromCandidate(c)], url, "guardian")
            : buildEmailHtml(c.race, c.participant.firstName || "Racer", url);
          const ok = await sendEmail(displayEmail, subject, html);
          if (ok) {
            await redis.set(personDedupKey(c), "1", "EX", DEDUP_TTL);
            sent++;
            emailSends++;
            sessionsWithSends.add(c.race.sessionId);
          } else {
            errors++;
          }
        } catch (err) {
          console.error(`[checkin-alerts] email error for personId=${c.participant.personId}:`, err);
          errors++;
        }
        continue;
      }

      // Multiple racers share this destination email — combined email.
      const members: GroupTicketMember[] = all.map(memberFromCandidate);
      if (dryRun) {
        const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
        console.log(`[checkin-alerts DRY] would email ${displayEmail} for ${members.length} members: ${names} (fresh=${fresh.length}${isGuardianFlavored ? ", via guardian" : ""})`);
        continue;
      }

      try {
        const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved?.contactFirstName;
        const groupId = await upsertGroupTicket({
          phone: "", // email-bucketed group has no phone
          locationId: FASTTRAX_LOCATION_ID,
          members,
          recipient: isGuardianFlavored ? "guardian" : "racer",
          guardianFirstName: isGuardianFlavored ? guardianFirstName : undefined,
        });
        const { url } = await shortenUrl(`${BASE}/g/${groupId}`);
        const subject = isGuardianFlavored
          ? `Your racers' heats are checking in — head to Karting 1st Floor`
          : `Your heats are checking in — head to Karting 1st Floor`;
        const html = buildGroupEmailHtml(members, url, isGuardianFlavored ? "guardian" : "racer");
        const ok = await sendEmail(displayEmail, subject, html);
        if (ok) {
          for (const c of fresh) {
            await redis.set(personDedupKey(c), "1", "EX", DEDUP_TTL);
            sessionsWithSends.add(c.race.sessionId);
          }
          sent += fresh.length;
          emailSends++;
        } else {
          errors += fresh.length;
        }
      } catch (err) {
        console.error(`[checkin-alerts] grouped-email error for ${emailKey}:`, err);
        errors += fresh.length;
      }
    }

    // Session-level dedup — one key per session that had a successful send.
    if (!dryRun) {
      for (const sid of sessionsWithSends) {
        await redis.set(`alert:checkin:session:${sid}`, "1", "EX", DEDUP_TTL);
      }
    }

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "checkin",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron") ? "vercel-cron" : (req.headers.get("user-agent") || "unknown"),
      candidates: candidates.length,
      sent,
      skipped,
      errors,
      groupedSmsSends,
      singleSmsSends,
      emailSends,
      sessions: sessionResults,
    });

    return NextResponse.json({
      ok: true,
      dryRun,
      elapsedMs: Date.now() - started,
      sessionResults,
      sent,
      skipped,
      errors,
      groupedSmsSends,
      singleSmsSends,
      emailSends,
      retries: retryStats,
    });
  } catch (err) {
    console.error("[checkin-alerts] error:", err);
    await logCronRun({
      ts: new Date().toISOString(),
      cron: "checkin",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron") ? "vercel-cron" : (req.headers.get("user-agent") || "unknown"),
      candidates: 0,
      sent,
      skipped,
      errors,
      fatalError: err instanceof Error ? err.message : "cron error",
    });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error", sent, skipped, errors },
      { status: 500 },
    );
  }
}
