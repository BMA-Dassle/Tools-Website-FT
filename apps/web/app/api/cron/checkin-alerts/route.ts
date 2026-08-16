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
  noContactReason,
  pickContactChannel,
  pickContactWithGuardianFallback,
  pickPhone,
  type ContactCandidate,
  type Participant,
} from "@/lib/participant-contact";
import { logSms, logCronRun } from "@/lib/sms-log";
import { updateLicencePasses } from "~/features/racing/wallet/licence-pass";
import { clearFinishedLicenceFields, NO_NEXT_RACE } from "~/features/racing/wallet/licence-clear";
import { formatHeat } from "~/features/racing/wallet/licence-meta";
import { queueRetry, drainRetries, voxSend } from "@/lib/sms-retry";
import { verifyCron } from "@/lib/cron-auth";
import { inEticketQuietHours } from "~/features/eticket/quiet-hours";
import { vipComboPersonLegsOnDate, type VipComboPersonLeg } from "@/lib/bowling-db";
import { appendBookingMemoLine } from "~/features/reservations-admin/bmi-notes";

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
  /** True for express-sourced candidates NOT on the Pandora roster — a
   *  confirmed booking whose session assignment hasn't landed. Stamped onto the
   *  minted ticket so the page shows "e-ticket updating" not "no longer valid". */
  pendingAssignment?: boolean;
  /** True when this racer is on an Ultimate VIP combo booking TODAY (Neon
   *  combo_special_id join on booking_metadata.heats[].bmiPersonId — same
   *  lookup the admin scanner uses to badge VIP guests). VIP parties meet in
   *  the infield VIP Room, not at the Karting counter. */
  isVip?: boolean;
}

async function fetchCurrentRaces(): Promise<CurrentRaces> {
  // warm=1 → 30s upstream timeout instead of 9s. Same flag, same reason as
  // fetchParticipants below: no user is waiting on a cron.
  //
  // THIS CALL IS ALSO THE THING THAT REFRESHES THE REDIS last-race KEYS every
  // board in the building falls back to, so it must not be the first thing to
  // give up when Pandora slows down — on 2026-08-13 it was, and the check-in
  // board sat on a heat that had finished half an hour earlier. A cron that
  // times out here doesn't just miss one tick; it freezes the fallback for
  // everyone until Pandora speeds back up.
  const res = await fetch(`${BASE}/api/pandora/races-current?warm=1`, { cache: "no-store" });
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
async function fetchPandoraPidsAnyState(sessionId: number): Promise<Set<string> | null> {
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
  // NULL, NOT AN EMPTY SET, ON ANY DOUBT.
  //
  // This used to `return new Set()` on a non-200. An empty set makes the
  // `!allPandoraPids.has(pid)` test below pass for EVERY express holder — so
  // the one check that stops a scratched racer being SMS'd silently inverted
  // itself precisely when Pandora was unhealthy, which is exactly when staff
  // are most likely to be shuffling heats. Null forces the caller to fail
  // closed and skip the express path for this session instead.
  if (!res.ok) return null;
  const data = await res.json();
  // A cache-fallback response is last-known state, not current truth — it can
  // predate the removal we are trying to catch. Treat it as no answer.
  if (data?.stale) return null;
  if (!Array.isArray(data?.data)) return null;
  const list = data.data as { personId: string | number }[];
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
      try {
        rec = JSON.parse(raw) as ExpressBookingRecord;
      } catch {
        continue;
      }
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
        const lastName =
          r.lastName || (r.racerName ? r.racerName.split(" ").slice(1).join(" ") : "") || "";
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
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Today's ET date as YYYY-MM-DD — keys `bookingrecord:date:{ymd}`. */
function todayETYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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
async function backfillExpressSessionIndex(
  race: CurrentRace,
): Promise<{ added: number; scanned: number }> {
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
        racers?: Array<{
          track?: string | null;
          heatStart?: string;
          sessionId?: string | number | null;
        }>;
      };
      try {
        rec = JSON.parse(raw);
      } catch {
        continue;
      }
      if (rec.fastLane !== true || !Array.isArray(rec.racers)) continue;

      // Does ANY racer on this booking belong to the active session?
      // Normalize both sides: "Mega" === "mega", "Blue" === "blue track", etc.
      let patched = false;
      const hit = rec.racers.some((r) => {
        const rt = (r.track || "").toLowerCase();
        // Accept "mega" ≈ "mega", "blue" ≈ "blue track", "red" ≈ "red track"
        const tracksMatch =
          rt === sessTrackLower || sessTrackLower.startsWith(rt) || rt.startsWith(sessTrackLower);
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
          rt === sessTrackLower || sessTrackLower.startsWith(rt) || rt.startsWith(sessTrackLower);
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
      console.log(
        `[checkin-alerts] backfill session=${race.sessionId} scanned=${billIds.length} added=${added}`,
      );
    }
    return { added, scanned: billIds.length };
  } catch (err) {
    console.error(
      `[checkin-alerts] backfillExpressSessionIndex error for session=${race.sessionId}:`,
      err,
    );
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
    await logSms({
      ts,
      phone: toFormatted || to,
      source: "checkin-cron",
      status: null,
      ok: false,
      error: "VOX_API_KEY missing",
      body,
      ...audit,
    });
    return false;
  }
  if (!toFormatted) {
    await logSms({
      ts,
      phone: to,
      source: "checkin-cron",
      status: null,
      ok: false,
      error: "invalid phone format",
      body,
      ...audit,
    });
    return false;
  }

  const result = await voxSend(toFormatted, body);
  if (result.ok) {
    await logSms({
      ts,
      phone: toFormatted,
      source: "checkin-cron",
      status: result.status,
      ok: true,
      body,
      provider: result.provider,
      failedOver: result.failedOver,
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
      audit: {
        sessionIds: audit.sessionIds,
        personIds: audit.personIds,
        memberCount: audit.memberCount,
      },
    });
    await logSms({
      ts,
      phone: toFormatted,
      source: "checkin-cron",
      status: result.status,
      ok: false,
      error: `[quota] queued for next reset window (${result.error || "429"})`,
      body,
      ...audit,
    });
    return false;
  }

  console.error(`[checkin-alerts] SMS ${result.status}: ${result.error}`);
  await logSms({
    ts,
    phone: toFormatted,
    source: "checkin-cron",
    status: result.status,
    ok: false,
    error: result.error || "",
    body,
    ...audit,
  });
  await queueRetry({
    cron: "checkin-cron",
    phone: toFormatted,
    body,
    audit,
    status: result.status,
    error: result.error || "",
  });
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
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return "";
  }
}

function raceHeader(race: CurrentRace): string {
  return `${race.heatNumber} - ${race.trackName} ${race.raceType} · ${timeET(race.scheduledStart)}`;
}

function racerLabel(m: { firstName: string; lastName: string }): string {
  return `${m.firstName} ${m.lastName}`.trim() || m.firstName || "Racer";
}

// ── SMS body builders ──────────────────────────────────────────────────────
// All bodies stay GSM-7 (ASCII only) so each SMS bills as 1 segment in
// the 160-char window. Previously these used " · " (middle dot,
// U+00B7) and " — " (em dash, U+2014) which forced UCS-2 encoding —
// 67 chars/segment — multiplying every check-in SMS by 2-4× at Vox.
// Same content, just plain hyphens / pipes instead of typographic
// punctuation. Trimmed the lockers reminder which lived purely to
// blow segment count anyway.

// Where the party checks in. Ultimate VIP combo parties meet in the infield
// VIP Room, everyone else at the Karting counter (owner 2026-08-01). Both
// strings MUST stay ASCII — see the GSM-7 block above.
const KARTING_WHERE_SMS = `Head to Karting (1st Floor) now:`;
const VIP_WHERE_SMS = `Meet us in the VIP Room in the infield (1st Floor):`;

function buildSingleSmsBody(
  race: CurrentRace,
  member: GroupTicketMember,
  shortUrl: string,
  vip = false,
): string {
  // URL embedded into the action line — keeping it on its own line
  // (the old shape) made some carriers / iOS render it as a separate
  // bubble or strip the link preview. Inline reads as one message.
  return [
    `FastTrax: NOW CHECKING IN`,
    `${race.raceType} Heat ${race.heatNumber} | ${timeET(race.scheduledStart)}`,
    racerLabel(member),
    vip ? VIP_WHERE_SMS : KARTING_WHERE_SMS,
    shortUrl,
    `Have this open for check-in`,
  ].join("\n");
}

function buildGroupSmsBody(members: GroupTicketMember[], shortUrl: string, vip = false): string {
  const bySession = new Map<string, GroupTicketMember[]>();
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  for (const m of sorted) {
    const k = String(m.sessionId);
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(m);
  }
  const lines: string[] = [`FastTrax: NOW CHECKING IN`];
  for (const group of bySession.values()) {
    const first = group[0];
    lines.push(
      `${first.heatNumber} - ${first.track} ${first.raceType} | ${timeET(first.scheduledStart)}`,
    );
    for (const m of group) lines.push(`- ${racerLabel(m)}`);
  }
  lines.push(vip ? VIP_WHERE_SMS : KARTING_WHERE_SMS);
  lines.push(shortUrl);
  lines.push(`Have this open for check-in`);
  return lines.join("\n");
}

/**
 * Guardian-flavored single-racer check-in SMS — heat just got called,
 * the parent needs to know whose race is up + send their kid to
 * Karting NOW. Action first, then per-kid line.
 */
function buildGuardianSingleSmsBody(
  member: GroupTicketMember,
  shortUrl: string,
  vip = false,
): string {
  return [
    `FastTrax: NOW CHECKING IN`,
    vip
      ? `Your racer's heat is up - meet us in the VIP Room in the infield (1st Floor):`
      : `Your racer's heat is up - head to Karting (1st Floor) now:`,
    shortUrl,
    `Have this open for check-in`,
    `${racerLabel(member)} | ${member.track} Heat ${member.heatNumber} | ${timeET(member.scheduledStart)}`,
  ].join("\n");
}

/**
 * Guardian-flavored multi-racer check-in SMS — only fires when
 * multiple kids' heats are called in the same cron tick (rare but
 * possible across tracks). Same urgency framing.
 */
function buildGuardianGroupSmsBody(
  members: GroupTicketMember[],
  shortUrl: string,
  vip = false,
): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const lines: string[] = [
    `FastTrax: NOW CHECKING IN`,
    vip
      ? `Your racers are up - meet us in the VIP Room in the infield (1st Floor):`
      : `Your racers are up - head to Karting (1st Floor) now:`,
    shortUrl,
    `Have this open for check-in`,
  ];
  for (const m of sorted) {
    lines.push(`${racerLabel(m)} | ${m.track} Heat ${m.heatNumber} | ${timeET(m.scheduledStart)}`);
  }
  return lines.join("\n");
}

// Email flavor of the where-to-go line. VIP drops the "skip guest services"
// clause — the VIP Room IS the check-in point for combo parties.
const KARTING_WHERE_EMAIL = `Head straight to the <strong>Karting counter on the 1st Floor</strong>. Skip guest services if you've already checked in.`;
const VIP_WHERE_EMAIL = `Meet us in the <strong>VIP Room in the infield on the 1st Floor</strong> — we'll check you in there.`;

function buildEmailHtml(
  race: CurrentRace,
  firstName: string,
  shortUrl: string,
  vip = false,
): string {
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
          <p style="margin:0 0 20px 0;font-size:15px;line-height:1.5">${vip ? VIP_WHERE_EMAIL : KARTING_WHERE_EMAIL}</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${shortUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">View Your E-Ticket</a>
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#888;text-align:center">Please have your e-ticket open and ready for check-in.</p>
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
  vip = false,
): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const heading =
    recipient === "guardian" ? `🏁 Your Racers Are Checking In` : `🏁 Your Heats Are Checking In`;
  const intro =
    recipient === "guardian"
      ? `Heads up — your racers' heats are now checking in.`
      : `Heads up — your heats are now checking in.`;
  const rows = sorted
    .map((m) => {
      return `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">
      <strong style="color:#1a1a1a">${racerLabel(m)}</strong>
      <span style="color:#555"> — ${m.track} ${m.raceType} Heat ${m.heatNumber}</span>
      <span style="color:#888"> · ${timeET(m.scheduledStart)}</span>
    </td></tr>`;
    })
    .join("");
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
          <p style="margin:0 0 20px 0;font-size:15px;line-height:1.5">${vip ? VIP_WHERE_EMAIL : KARTING_WHERE_EMAIL}</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${shortUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">View E-Tickets</a>
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#888;text-align:center">Please have your e-ticket open and ready for check-in.</p>
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
    pendingAssignment: c.pendingAssignment || undefined,
  };
}

function personDedupKey(c: Candidate): string {
  return `alert:checkin:${c.race.sessionId}:${c.participant.personId}`;
}

/**
 * Booking-memo trail for VIP check-in SMS (owner 2026-08-01): after a
 * successful VIP-flavored send, append one line per covered combo reservation
 * to its BMI project private log so the desk sees exactly what the guest was
 * told. Best-effort — a memo failure never fails the send path.
 */
async function logVipCheckinMemo(
  vipLegs: Map<string, VipComboPersonLeg>,
  members: Candidate[],
  phone: string,
): Promise<void> {
  try {
    const byReservation = new Map<number, { leg: VipComboPersonLeg; names: string[] }>();
    for (const c of members) {
      const leg = vipLegs.get(String(c.participant.personId));
      if (!leg) continue;
      const entry = byReservation.get(leg.reservationId) ?? { leg, names: [] };
      const name = `${c.participant.firstName || ""} ${c.participant.lastName || ""}`.trim();
      if (name) entry.names.push(name);
      byReservation.set(leg.reservationId, entry);
    }
    for (const { leg, names } of byReservation.values()) {
      await appendBookingMemoLine(
        {
          id: leg.reservationId,
          bmiBillId: leg.bmiBillId,
          bmiReservationNumber: leg.bmiReservationNumber,
          centerCode: leg.centerCode,
          productKind: leg.productKind,
        },
        `VIP check-in SMS sent to ${phone} (meet in the VIP Room, infield 1st floor)` +
          (names.length ? ` — ${names.join(", ")}` : ""),
      );
    }
  } catch (err) {
    console.warn("[checkin-alerts] VIP booking-memo log failed:", err);
  }
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  // Quiet hours — no e-ticket goes out after business hours; the
  // overnight clear purges anything queued. The evidence-based wallet
  // clear-down still runs first: evening heats routinely spill past
  // midnight (median 19.8 min late), and a pass stuck on "Check in now"
  // until the 3am failsafe is exactly what this per-minute clear exists
  // to prevent. Sends and race:called writes stay suppressed. dryRun
  // still passes for ops testing.
  if (!dryRun && inEticketQuietHours()) {
    await clearFinishedLicenceFields(req.nextUrl.origin).catch((err) => {
      console.error("[checkin-alerts] quiet-hours wallet clear failed:", err);
    });
    return NextResponse.json(
      { ok: true, skipped: "quiet-hours" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const started = Date.now();
  const now = Date.now();

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let groupedSmsSends = 0;
  let singleSmsSends = 0;
  let emailSends = 0;
  const sessionResults: { track: string; sessionId: number; reason?: string }[] = [];
  const retryStats = !dryRun
    ? await drainRetries("checkin-cron")
    : { attempted: 0, ok: 0, requeued: 0, dead: 0 };

  try {
    const races = await fetchCurrentRaces();
    const entries: [TrackKey, CurrentRace | null][] = [
      ["blue", races.blue],
      ["red", races.red],
      ["mega", races.mega],
    ];

    const candidates: Candidate[] = [];

    // CLEAR-DOWN FIRST, before writing any new status. A heat that has actually
    // started or ended stops being live regardless of how far off schedule it
    // ran — see licence-clear.ts for why elapsed time cannot answer this.
    await clearFinishedLicenceFields(req.nextUrl.origin)
      .then((r) => {
        if (r.checkinCleared || r.nextRaceCleared) {
          console.log(
            `[checkin-alerts] wallet cleared: ${r.checkinCleared} check-in, ${r.nextRaceCleared} next-race (of ${r.checked} live)`,
          );
        }
      })
      .catch(() => undefined);

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

      // STALENESS IS MEASURED FROM WHEN THE HEAT WAS CALLED, NOT WHEN IT WAS
      // SCHEDULED.
      //
      // This guard used to read `scheduledStart`, which silently deleted the
      // whole alert for any heat running more than 30 minutes behind. That is
      // not a rare edge: on 2026-08-06, 92 of 94 heats went off more than 5
      // minutes late (median 19.8, worst 41.0), and roughly 13 of them passed
      // the 30-minute mark — so those racers got no check-in SMS, no email and
      // no wallet push AT ALL, while the desk was actively calling them.
      //
      // `/races-current` hands us `calledAt` — the moment staff actually opened
      // check-in — so a heat 40 minutes behind schedule but called 90 seconds
      // ago is correctly fresh, and a heat called an hour ago is correctly
      // stale. Falls back to `scheduledStart` only if `calledAt` is absent.
      // Same principle as everywhere else in this feature: key off what
      // actually happened, never off the clock.
      const calledMs = new Date(race.calledAt ?? "").getTime();
      const freshnessMs = isNaN(calledMs) ? new Date(race.scheduledStart).getTime() : calledMs;
      if (!isNaN(freshnessMs) && freshnessMs < now - 30 * 60_000) {
        sessionResults.push({ track: trackKey, sessionId, reason: "stale" });
        continue;
      }

      // THE ALERT DEDUP GATES THE SMS/EMAIL, NOT THE WALLET.
      //
      // It used to `continue` here, which skipped the licence push along with
      // everything else. That made NEXT RACE reachable only on the FIRST tick a
      // heat was called — so a racer added to the roster a minute later, or a
      // heat RE-CALLED by staff, could never get it. Proven live on 2026-08-06:
      // re-calling Red Heat 60 (session 57900606) moved `calledAt` but wrote
      // nothing to any pass, because this key had been set 26 minutes earlier.
      //
      // The wallet does not need this guard and never did. A text costs money
      // and must go out once; a pass write is free, silent (no changeMessage on
      // nextRace) and already skipped by `updateLicencePass` when the value is
      // unchanged. So the dedup now suppresses only the paid channels, and the
      // pass is kept correct every tick the heat is open.
      const sessionKey = `alert:checkin:session:${sessionId}`;
      const alreadyAlerted = !dryRun && Boolean(await redis.get(sessionKey));
      if (alreadyAlerted) {
        sessionResults.push({ track: trackKey, sessionId, reason: "session-already-alerted" });
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
        sessionResults.push({
          track: trackKey,
          sessionId,
          note: `express-backfill: +${backfill.added}`,
        } as (typeof sessionResults)[number] & { note: string });
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
      //
      // null = we could not read the all-state roster, so case 2 is
      // unanswerable. Drop the express path for this session rather than send
      // on an unchecked list: an express holder who misses one check-in text
      // can still be walked up at the desk, whereas texting a racer staff have
      // just scratched is the failure we are here to prevent.
      const freshExpress = allPandoraPids
        ? expressHolders.filter((e) => !allPandoraPids.has(String(e.personId)))
        : [];
      if (!allPandoraPids && expressHolders.length > 0) {
        console.warn(
          `[checkin-alerts] session=${sessionId}: all-state roster unavailable, skipping ${expressHolders.length} express holder(s)`,
        );
        sessionResults.push({
          track: trackKey,
          sessionId,
          note: `express-skipped: roster unavailable (${expressHolders.length})`,
        } as (typeof sessionResults)[number] & { note: string });
      }

      const trackDisplay = trackFromName(race.trackName)?.display || race.trackName;

      // "CHECK IN NOW" onto any wallet licence on this roster.
      //
      // Sits alongside the SMS and email paths below as a THIRD channel, and
      // the cheapest by far: pass updates are free and unlimited, where a text
      // costs per message and this cron fires every minute against heats that
      // run every ~10. Its lock-screen alert is the field's changeMessage, so
      // the value has to read as a finished sentence — there is no REST call
      // for an arbitrary push.
      //
      // Safe at this cadence: updateLicencePasses resolves the whole roster's
      // pass-holders in ONE Neon query and pushes only when the value actually
      // changed, so a re-run against the same open heat is a no-op.
      // Awaited — a serverless handler is frozen when it returns, so a dangling
      // promise is killed mid-flight. See pre-race-tickets for the incident.
      //
      // NEXT RACE IS WRITTEN HERE TOO, and it is not belt-and-braces — it is the
      // only cron that can get this right for a late heat.
      //
      // pre-race-tickets drives NEXT RACE off the SCHEDULE and stops covering a
      // session 5 minutes after its scheduled start (WINDOW_SKEW_BEHIND_MS).
      // Measured on 2026-08-06: 92 of 94 heats (98%) started more than 5 minutes
      // late, median 19.8 min, worst 41 min. So for essentially every heat, the
      // pre-race window closes a quarter of an hour BEFORE the heat is called —
      // and any racer added in that gap gets "Check in now — Red Heat 60" on
      // their pass while NEXT RACE still reads "None in next 2 hrs". That is the
      // exact contradiction a racer reported on their own live pass (person
      // 409523, heat 60: scheduled 10:48 PM, actually called 11:00 PM).
      //
      // This cron reads /races-current — what is ACTUALLY happening, not what
      // was planned — so the heat being called IS the racer's next race by
      // definition, however far off schedule it went.
      //
      // COSTS NO EXTRA NOTIFICATION. `custom.nextRace` carries no changeMessage
      // on the template, deliberately (it moves for reasons the racer did not
      // cause), so writing it never raises a lock-screen alert. And
      // updateLicencePass skips a field whose value is unchanged, so once
      // pre-race has already written this heat the value matches and no PUT is
      // made at all. Shared `formatHeat` with pre-race-tickets for exactly that
      // reason: two formatters that drifted by one character would push a
      // pointless PUT for every racer, every minute.
      const heat = formatHeat({
        scheduledStart: race.scheduledStart,
        track: trackDisplay,
        heatNumber: race.heatNumber,
      });
      // "CHECK IN NOW" IS WRITTEN ONCE PER HEAT. NEXT RACE IS WRITTEN EVERY TICK.
      //
      // These two fields must NOT be treated the same, and getting that wrong
      // would be expensive.
      //
      // `custom.checkinStatus` carries a changeMessage ("FastTrax: %@"), so every
      // write of it is a lock-screen alert. `custom.nextRace` carries none, so
      // writing it is silent. That asymmetry is the whole design.
      //
      // THE OSCILLATION THIS PREVENTS. The clear-down at the top of this cron
      // wipes checkinStatus the moment BMI records `actualStart` — but the heat
      // stays in /races-current for roughly twenty minutes AFTER it is called.
      // So without this guard the two would fight, once a minute, for the whole
      // of that window: clear-down blanks it (alert), this loop re-asserts it
      // (alert), ~19 times per racer per heat. Apple warned us on 2026-08-06
      // that automatic updates for these passes were about to be DISABLED for
      // sending too many; a flood of that shape is what would finish the job.
      //
      // Re-asserting it would also be WRONG on its own terms: once the race has
      // started, "Check in now" is a lie, and the clear-down blanking it is the
      // correct end state. The first tick is the only one that has news.
      //
      // NEXT RACE keeps being written every tick precisely because it is silent
      // and idempotent — that is what lets a racer added to the roster late, or
      // a heat re-called by staff, still get it.
      const firstTick = !alreadyAlerted;
      await updateLicencePasses(
        participants.map((p) => ({
          personId: p.personId,
          ...(firstTick
            ? {
                checkinStatus:
                  `Check in now — ${trackDisplay} Heat ${race.heatNumber ?? ""}`.trim(),
                // Stamped so the clear-down knows WHICH heat this refers to.
                // Without it, "is this stale?" has no answer but elapsed time —
                // and time is wrong whenever a race runs late or early, which is
                // most of them.
                checkinSessionId: String(sessionId),
              }
            : {}),
          nextRace: heat.nextRace || NO_NEXT_RACE,
          raceLabel: heat.raceLabel || "—",
          nextRaceLong: heat.nextRaceLong || "—",
          nextRaceSessionId: String(sessionId),
        })),
      )
        .then((n) => {
          if (n) console.log(`[checkin-alerts] wallet check-in pushed to ${n} pass(es)`);
        })
        .catch(() => undefined);

      // PAID CHANNELS ONLY BELOW THIS LINE. The wallet is already up to date.
      //
      // A session that has had its texts and emails sent stops here: the pass
      // write above is free, silent and idempotent and must keep running for as
      // long as the heat is open, but an SMS costs money and must go out once.
      // Nobody gets a second text because of this, including on a re-call.
      if (alreadyAlerted) continue;

      for (const p of participants) {
        candidates.push({ race, trackDisplay, participant: p });
      }
      for (const p of freshExpress) {
        // Never on the Pandora roster → confirmed booking, assignment pending.
        candidates.push({ race, trackDisplay, participant: p, pendingAssignment: true });
      }
      sessionResults.push({ track: trackKey, sessionId });
    }

    // VIP combo badge — ONE batched Neon lookup for the whole called roster.
    // Pandora personId === booking_metadata.heats[].bmiPersonId (same join the
    // admin scanner uses). Fail-open: DB trouble → empty map → everyone gets
    // the generic Karting-counter copy, the alert itself never breaks.
    let vipLegs = new Map<string, VipComboPersonLeg>();
    if (candidates.length) {
      vipLegs = await vipComboPersonLegsOnDate(
        candidates.map((c) => String(c.participant.personId)),
        todayETYmd(),
      );
      for (const c of candidates) {
        c.isVip = vipLegs.has(String(c.participant.personId));
      }
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
    const noContact: Candidate[] = [];

    for (const c of candidates) {
      const resolved = pickContactWithGuardianFallback(c.participant);
      c.resolved = resolved ?? null;

      if (!resolved) {
        const racerPhone = canonicalizePhone(pickPhone(c.participant));
        const guardianPhone = canonicalizePhone(
          c.participant.guardian?.mobilePhone || c.participant.guardian?.homePhone || null,
        );
        if (racerPhone && !hasSmsConsent(c.participant)) {
          // Racer phone opted out → needs verbal OK (existing).
          if (!noConsentByPhone.has(racerPhone)) noConsentByPhone.set(racerPhone, []);
          noConsentByPhone.get(racerPhone)!.push(c);
        } else if (guardianPhone) {
          // Minor whose guardian has a phone the picker rejected (opted out) →
          // SAME verbal-OK surface, keyed on the guardian's number.
          if (!noConsentByPhone.has(guardianPhone)) noConsentByPhone.set(guardianPhone, []);
          noConsentByPhone.get(guardianPhone)!.push(c);
        } else {
          // No reachable phone for racer OR guardian → surface for desk follow-up.
          noContact.push(c);
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
      // Any VIP racer in the bucket → VIP Room copy. Combo parties book
      // together, so a mixed bucket is a same-party edge; VIP Room staff
      // redirect the stray case (owner 2026-08-01).
      const anyVip = all.some((c) => c.isVip);
      const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved
        ?.contactFirstName;

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
          pendingAssignment: c.pendingAssignment || undefined,
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
            ? buildGuardianSingleSmsBody(member, url, anyVip)
            : buildSingleSmsBody(c.race, member, url, anyVip);
          const ok = await sendSms(phone, body, {
            sessionIds: [c.race.sessionId],
            personIds: [c.participant.personId],
            memberCount: 1,
            shortCode: code,
            viaGuardian: isGuardianFlavored,
          });
          if (ok) {
            await redis.set(personDedupKey(c), "1", "EX", DEDUP_TTL);
            sent++;
            singleSmsSends++;
            sessionsWithSends.add(c.race.sessionId);
            if (anyVip) await logVipCheckinMemo(vipLegs, all, phone);
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
          ? buildGuardianGroupSmsBody(members, url, anyVip)
          : buildGroupSmsBody(members, url, anyVip);
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
          if (anyVip) await logVipCheckinMemo(vipLegs, all, phone);
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

    // No-reachable-contact audit — racers with no usable phone/email for
    // themselves OR a guardian. Previously skipped silently; mint a ticket so
    // the row shows the racer name + is resendable once staff collect a
    // contact, and log a skipped row with the reason. One per (session, person).
    for (const c of noContact) {
      const auditKey = `eticket-nocontact:checkin:${c.race.sessionId}:${c.participant.personId}`;
      if (dryRun || (await redis.get(auditKey))) continue;
      try {
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
        const { code, url } = await shortenUrl(`${BASE}/t/${ticketId}`);
        await logSms({
          ts: new Date().toISOString(),
          phone: "",
          source: "checkin-cron",
          status: null,
          ok: false,
          error: noContactReason(c.participant),
          body: buildSingleSmsBody(c.race, memberFromCandidate(c), url),
          sessionIds: [c.race.sessionId],
          personIds: [c.participant.personId],
          memberCount: 1,
          shortCode: code,
        });
        await redis.set(auditKey, "1", "EX", DEDUP_TTL);
      } catch (err) {
        console.error(
          `[checkin-alerts] no-contact audit log error for personId=${c.participant.personId}:`,
          err,
        );
      }
    }

    // Email path — bucket by destination email. Multiple racers (guardian
    // fallback OR shared family inbox) collapse into ONE combined email.
    for (const [emailKey, fresh] of freshEmailByEmail) {
      const all = allByEmail.get(emailKey) || fresh;
      const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
      const anyVip = all.some((c) => c.isVip);
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
            ? anyVip
              ? `Your racer's heat is checking in — meet us in the VIP Room (1st Floor)`
              : `Your racer's heat is checking in — head to Karting 1st Floor`
            : anyVip
              ? `Your heat is checking in — meet us in the VIP Room (1st Floor)`
              : `Your heat is checking in — head to Karting 1st Floor`;
          const html = isGuardianFlavored
            ? buildGroupEmailHtml([memberFromCandidate(c)], url, "guardian", anyVip)
            : buildEmailHtml(c.race, c.participant.firstName || "Racer", url, anyVip);
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
          console.error(
            `[checkin-alerts] email error for personId=${c.participant.personId}:`,
            err,
          );
          errors++;
        }
        continue;
      }

      // Multiple racers share this destination email — combined email.
      const members: GroupTicketMember[] = all.map(memberFromCandidate);
      if (dryRun) {
        const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
        console.log(
          `[checkin-alerts DRY] would email ${displayEmail} for ${members.length} members: ${names} (fresh=${fresh.length}${isGuardianFlavored ? ", via guardian" : ""})`,
        );
        continue;
      }

      try {
        const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved
          ?.contactFirstName;
        const groupId = await upsertGroupTicket({
          phone: "", // email-bucketed group has no phone
          locationId: FASTTRAX_LOCATION_ID,
          members,
          recipient: isGuardianFlavored ? "guardian" : "racer",
          guardianFirstName: isGuardianFlavored ? guardianFirstName : undefined,
        });
        const { url } = await shortenUrl(`${BASE}/g/${groupId}`);
        const subject = isGuardianFlavored
          ? anyVip
            ? `Your racers' heats are checking in — meet us in the VIP Room (1st Floor)`
            : `Your racers' heats are checking in — head to Karting 1st Floor`
          : anyVip
            ? `Your heats are checking in — meet us in the VIP Room (1st Floor)`
            : `Your heats are checking in — head to Karting 1st Floor`;
        const html = buildGroupEmailHtml(
          members,
          url,
          isGuardianFlavored ? "guardian" : "racer",
          anyVip,
        );
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
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
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
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates: 0,
      sent,
      skipped,
      errors,
      fatalError: err instanceof Error ? err.message : "cron error",
    });
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "cron error",
        sent,
        skipped,
        errors,
      },
      { status: 500 },
    );
  }
}
