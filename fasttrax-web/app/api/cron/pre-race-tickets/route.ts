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
import { sendEmail as sendGridEmail } from "@/lib/sendgrid";

/**
 * Flow A — Pre-race e-ticket cron.
 *
 * Every 2 min (see vercel.json), looks at all sessions starting in the next ~2 hours on the
 * operating tracks for today (Blue + Red on normal days, Mega only on Tuesdays),
 * and sends each participant an e-ticket.
 *
 * Participants sharing a phone number (family bookings) are bucketed so they
 * receive ONE SMS pointing to a combined /g/{id} page. Email recipients stay
 * one-per-person.
 *
 * ?dryRun=1  — log who would receive but don't send
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const VOX_API_KEY = process.env.VOX_API_KEY || "";
const VOX_FROM = "+12394819666"; // FastTrax SMS sender
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const SHORT_TTL = 60 * 60 * 24 * 90; // 90 days
const DEDUP_TTL = 60 * 60 * 24;       // 24 hours
const WINDOW_AHEAD_MS = 2 * 60 * 60 * 1000; // 2 hours
const WINDOW_SKEW_BEHIND_MS = 5 * 60 * 1000; // include heats that started <5 min ago

interface PandoraSession {
  sessionId: string;
  name: string;
  scheduledStart: string;
  type: string;
  heatNumber: number;
}

/** One fetched participant tied to the session it belongs to.
 *  `resolved` is the picker's verdict on who we'd actually deliver to —
 *  the racer themselves, or their guardian when the racer has no
 *  usable own contact (typical for minors). Filled in section 2 of
 *  the main loop; null when neither has anything reachable. */
interface Candidate {
  session: PandoraSession;
  trackDisplay: string;
  participant: Participant;
  resolved?: ContactCandidate | null;
}

function resourceToTrackDisplay(r: string): string {
  if (r.toLowerCase().startsWith("blue")) return "Blue";
  if (r.toLowerCase().startsWith("red")) return "Red";
  return "Mega";
}

function activeResourcesForToday(): string[] {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date());
  // Pandora's /bmi/sessions expects "Mega Track" (with suffix) — the
  // shorter "Mega" silently 404s, which is why this cron has been
  // sending 0 pre-race e-tickets on Tuesdays.
  if (weekday === "Tue") return ["Mega Track"];
  return ["Blue Track", "Red Track"];
}

function todayETRange(): { startDate: string; endDate: string } {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return {
    startDate: `${ymd}T00:00:00`,
    endDate: `${ymd}T23:59:59`,
  };
}

async function fetchSessions(resourceName: string): Promise<PandoraSession[]> {
  const { startDate, endDate } = todayETRange();
  // warm=1 → 30s upstream timeout. We're a cron, no user is
  // waiting, so let Pandora take its time — the whole point is
  // to populate the Redis cache so subsequent user-facing calls
  // (camera-assign auto-poll, e-ticket polls) hit the warmed
  // cache instead of paying the upstream cost themselves.
  const qs = new URLSearchParams({
    locationId: FASTTRAX_LOCATION_ID,
    resourceName,
    startDate,
    endDate,
    warm: "1",
  }).toString();
  const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? (data.data as PandoraSession[]) : [];
}

async function fetchParticipants(sessionId: string | number): Promise<Participant[]> {
  // warm=1 → 30s upstream timeout (cron warm-up path — see fetchSessions).
  const res = await fetch(
    `${BASE}/api/pandora/session-participants?locationId=${FASTTRAX_LOCATION_ID}&sessionId=${sessionId}&warm=1`,
    {
      cache: "no-store",
      // Server-only call — pass the internal trust header so the
      // proxy returns the FULL participant payload (firstName,
      // lastName, email, phone) needed to address SMS/email. Browser
      // calls from the public e-ticket page never include this
      // header and get a personId-only payload (PII redacted).
      headers: { "x-pandora-internal": process.env.SWAGGER_ADMIN_KEY || "" },
    },
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? (data.data as Participant[]) : [];
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
  /** True when this SMS was routed via guardian fallback (minor with
   *  no usable own contact). Surfaces on the SMS log so the admin
   *  board can render the "↻ via guardian" badge. */
  viaGuardian?: boolean;
}

async function sendSms(to: string, body: string, audit: SmsAudit): Promise<boolean> {
  const ts = new Date().toISOString();
  const toFormatted = canonicalizePhone(to);
  if (!VOX_API_KEY) {
    console.error("[pre-race] VOX_API_KEY missing");
    await logSms({ ts, phone: toFormatted || to, source: "pre-race-cron", status: null, ok: false, error: "VOX_API_KEY missing", body, ...audit });
    return false;
  }
  if (!toFormatted) {
    await logSms({ ts, phone: to, source: "pre-race-cron", status: null, ok: false, error: "invalid phone format", body, ...audit });
    return false;
  }

  const result = await voxSend(toFormatted, body);
  if (result.ok) {
    await logSms({
      ts, phone: toFormatted, source: "pre-race-cron",
      status: result.status, ok: true, body,
      provider: result.provider, failedOver: result.failedOver,
      // Carry the Vox messageId so the webhook can correlate the
      // delivery callback back to this log entry. Without it the
      // entry stays YELLOW "sent" forever even after the carrier
      // confirms delivery.
      providerMessageId: result.voxId,
      ...audit,
    });
    return true;
  }

  // Quota / daily-limit hit (or pre-empted by the cooldown flag) —
  // route to the long-lived quota queue, not the 3-attempt retry queue.
  if (result.skipped || result.quotaHit) {
    const { quotaEnqueue } = await import("@/lib/sms-quota");
    await quotaEnqueue({
      phone: toFormatted,
      body,
      source: "pre-race-cron",
      queuedAt: ts,
      shortCode: audit.shortCode,
      audit: { sessionIds: audit.sessionIds, personIds: audit.personIds, memberCount: audit.memberCount },
    });
    await logSms({
      ts, phone: toFormatted, source: "pre-race-cron",
      status: result.status, ok: false,
      error: `[quota] queued for next reset window (${result.error || "429"})`,
      body, ...audit,
    });
    return false;
  }

  console.error(`[pre-race] SMS ${result.status}: ${result.error}`);
  await logSms({ ts, phone: toFormatted, source: "pre-race-cron", status: result.status, ok: false, error: result.error || "", body, ...audit });
  // Queue for retry so 429 bursts + transient failures self-heal on next cron tick.
  await queueRetry({ cron: "pre-race-cron", phone: toFormatted, body, audit, status: result.status, error: result.error || "" });
  return false;
}

// Retry drain is centralized in lib/sms-retry.ts so the sweep cron can
// reuse it without duplicating Voxtelesys send + dedup-setting logic.

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const result = await sendGridEmail({ to, subject, html });
  if (!result.ok) {
    console.error("[pre-race] Email error:", result.status, result.error);
    return false;
  }
  return true;
}

function formatTimeET(iso: string): string {
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

// IMPORTANT_INFO boilerplate moved to the e-ticket page itself
// (app/t/[id] and /g/[id]). The SMS body now stays under 2 segments
// (~280 chars) so carriers don't reject as A2P spam — Vox returns
// `code 4505: carrier rejected message too long` on 11+ segment
// bodies, which was silently dropping e-tickets to a chunk of
// recipients. Customers see the full race info when they open the
// link, which is the expected flow anyway.
const SHORT_CTA = `Open this for check-in info ↑`;

function racerLabel(m: { firstName: string; lastName: string }): string {
  return `${m.firstName} ${m.lastName}`.trim() || m.firstName || "Racer";
}

function buildSingleSmsBody(sessionName: string, member: GroupTicketMember, shortUrl: string): string {
  return [
    `FastTrax e-ticket`,
    `Session ${sessionName} at ${formatTimeET(member.scheduledStart)}`,
    racerLabel(member),
    ``,
    shortUrl,
    SHORT_CTA,
  ].join("\n");
}

function buildGroupSmsBody(members: GroupTicketMember[], shortUrl: string): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const bySession = new Map<string, GroupTicketMember[]>();
  for (const m of sorted) {
    const k = String(m.sessionId);
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(m);
  }
  const lines: string[] = [`FastTrax e-tickets`];
  const sessionBlocks: string[][] = [];
  for (const group of bySession.values()) {
    const first = group[0];
    const heatName = `${first.heatNumber} - ${first.track} ${first.raceType}`;
    const block = [`Session ${heatName} at ${formatTimeET(first.scheduledStart)}`];
    for (const m of group) block.push(`- ${racerLabel(m)}`);
    sessionBlocks.push(block);
  }
  // Blank line separating each session block
  for (let i = 0; i < sessionBlocks.length; i++) {
    if (i > 0) lines.push(``);
    lines.push(...sessionBlocks[i]);
  }
  lines.push(``);
  lines.push(shortUrl);
  lines.push(SHORT_CTA);
  return lines.join("\n");
}

/**
 * Guardian-flavored single-racer SMS body — used when a minor without
 * their own contact has the SMS routed to a guardian. Per-line member
 * format matches the group body so the admin and the parent see a
 * consistent shape across "1 kid" and "2+ kids" cases.
 */
function buildGuardianSingleSmsBody(member: GroupTicketMember, shortUrl: string): string {
  const heatLabel = `${member.track} Heat ${member.heatNumber} at ${formatTimeET(member.scheduledStart)}`;
  return [
    "FastTrax e-ticket for your racer",
    "",
    `- ${member.firstName} — ${heatLabel}`,
    "",
    shortUrl,
    SHORT_CTA,
  ].join("\n");
}

/**
 * Guardian-flavored multi-racer SMS body — when 2+ kids share a
 * guardian phone (or any bucket where ANY member came in via guardian
 * fallback), we collapse into one combined SMS to the parent. Per-kid
 * lines, no greeting, terse — matches the user's chosen format.
 */
function buildGuardianGroupSmsBody(members: GroupTicketMember[], shortUrl: string): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const lines = ["FastTrax e-tickets for your racers", ""];
  for (const m of sorted) {
    const heatLabel = `${m.track} Heat ${m.heatNumber} at ${formatTimeET(m.scheduledStart)}`;
    lines.push(`- ${m.firstName} — ${heatLabel}`);
  }
  lines.push("");
  lines.push(shortUrl);
  lines.push(SHORT_CTA);
  return lines.join("\n");
}

function buildEmailHtml(firstName: string, track: string, raceType: string, scheduledStart: string, shortUrl: string): string {
  const time = formatTimeET(scheduledStart);
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#E41C1D;padding:22px 28px;color:#fff;text-align:center">
          <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;opacity:0.9">FastTrax Entertainment</p>
          <h1 style="margin:0;font-size:26px;letter-spacing:-0.5px">Your E-Ticket</h1>
        </td></tr>
        <tr><td style="padding:26px 28px">
          <p style="margin:0 0 12px 0;font-size:16px;line-height:1.5">Hey ${firstName} — your <strong>${raceType} race on the ${track} Track</strong> is coming up at <strong>${time}</strong>.</p>
          <p style="margin:0 0 20px 0;font-size:15px;line-height:1.5">Save this email or screenshot your e-ticket. Show the e-ticket screen at check-in — no paper ticket needed.</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${shortUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">View My E-Ticket</a>
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#888;text-align:center">14501 Global Parkway, Fort Myers FL 33913</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Grouped email body — used in two cases:
 *   1. Guardian fallback: 1+ kids routed to a parent's email
 *   2. Plain shared inbox: 2+ family members on the same email address
 *
 * Per-kid lines mirror the group SMS format. Subject/heading shifts
 * to "Your racers' e-tickets" when recipient="guardian".
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
    ? `Your racers' e-tickets`
    : `Your e-tickets`;
  const intro = recipient === "guardian"
    ? `Heads up — your racers are up soon.`
    : `Heads up — your races are coming up.`;
  const rows = sorted.map((m) => {
    const time = formatTimeET(m.scheduledStart);
    return `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">
      <strong style="color:#1a1a1a">${m.firstName}</strong>
      <span style="color:#555"> — ${m.track} Heat ${m.heatNumber} (${m.raceType})</span>
      <span style="color:#888"> · ${time}</span>
    </td></tr>`;
  }).join("");
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#E41C1D;padding:22px 28px;color:#fff;text-align:center">
          <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;opacity:0.9">FastTrax Entertainment</p>
          <h1 style="margin:0;font-size:26px;letter-spacing:-0.5px">${heading}</h1>
        </td></tr>
        <tr><td style="padding:26px 28px">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.5">${intro}</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;font-size:15px">${rows}</table>
          <p style="margin:0 0 20px 0;font-size:14px;line-height:1.5;color:#555">Save this email or screenshot the e-ticket page. Show the e-ticket screen at check-in — no paper ticket needed.</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${shortUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">View E-Tickets</a>
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#888;text-align:center">14501 Global Parkway, Fort Myers FL 33913</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function memberFromCandidate(c: Candidate): GroupTicketMember {
  return {
    sessionId: c.session.sessionId,
    personId: c.participant.personId,
    firstName: c.participant.firstName || "Racer",
    lastName: c.participant.lastName || "",
    scheduledStart: c.session.scheduledStart,
    track: c.trackDisplay,
    raceType: c.session.type,
    heatNumber: c.session.heatNumber,
  };
}

function dedupKey(c: Candidate): string {
  return `alert:pre-race:${c.session.sessionId}:${c.participant.personId}`;
}

// Concurrency lock key + TTL. With an every-minute schedule, a run that
// takes >60s would let the next run fire on top of it — wasteful Pandora
// fetches, and could create log-spam race conditions on the no-consent
// dedup path. The lock holds for up to 90s (enough for any healthy run);
// subsequent fires during that window return early with { locked: true }.
const CRON_LOCK_KEY = "cron-lock:pre-race";
const CRON_LOCK_TTL = 90;

export async function GET(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();
  const windowStart = Date.now() - WINDOW_SKEW_BEHIND_MS;
  const windowEnd = Date.now() + WINDOW_AHEAD_MS;

  // Concurrency guard — skip if a previous run hasn't finished.
  if (!dryRun) {
    // SET NX EX — only sets if key is absent, atomically.
    const acquired = await redis.set(CRON_LOCK_KEY, "1", "EX", CRON_LOCK_TTL, "NX");
    if (!acquired) {
      return NextResponse.json(
        { ok: true, locked: true, note: "previous run still in flight" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let groupedSmsSends = 0;
  let singleSmsSends = 0;
  let emailSends = 0;
  // Drain any retries due now — 429s and transient failures self-heal without
  // having to wait for the main scan to re-identify the racer as fresh.
  const retryStats = !dryRun ? await drainRetries("pre-race-cron") : { attempted: 0, ok: 0, requeued: 0, dead: 0 };

  try {
    const resources = activeResourcesForToday();

    // 1. Collect every (session, participant) pair in the window across all resources.
    const candidates: Candidate[] = [];
    for (const resourceName of resources) {
      const trackDisplay = resourceToTrackDisplay(resourceName);
      const sessions = await fetchSessions(resourceName);
      const upcoming = sessions.filter((s) => {
        const ms = new Date(s.scheduledStart).getTime();
        return !isNaN(ms) && ms >= windowStart && ms <= windowEnd;
      });
      for (const session of upcoming) {
        let participants: Participant[] = [];
        try {
          participants = await fetchParticipants(session.sessionId);
        } catch {
          continue;
        }
        for (const p of participants) {
          candidates.push({ session, trackDisplay, participant: p });
        }
      }
    }

    // 2. Resolve each candidate to a destination contact (racer first,
    //    guardian fallback for minors), then bucket:
    //      - SMS candidates by canonical destination phone
    //      - Email candidates by canonical destination email (NEW —
    //        also groups family members sharing an inbox, free win)
    //      - No-consent candidates by their racer phone (preserves
    //        the admin "needs verbal OK" surface)
    const freshSmsByPhone = new Map<string, Candidate[]>();
    const allByPhone = new Map<string, Candidate[]>(); // enrichment for /g/{id}
    const freshEmailByEmail = new Map<string, Candidate[]>();
    const allByEmail = new Map<string, Candidate[]>();
    const noConsentByPhone = new Map<string, Candidate[]>(); // racer-phone bucket for "needs verbal OK"

    for (const c of candidates) {
      const resolved = pickContactWithGuardianFallback(c.participant);
      c.resolved = resolved ?? null;

      if (!resolved) {
        // Picker returned null. Two sub-cases:
        //   (a) racer has a phone but explicitly opted out AND no
        //       guardian fallback → log "needs verbal OK" so admin
        //       can manually resend after verbal consent
        //   (b) no contact anywhere → silent skip
        const racerPhone = canonicalizePhone(pickPhone(c.participant));
        if (racerPhone && !hasSmsConsent(c.participant)) {
          if (!noConsentByPhone.has(racerPhone)) noConsentByPhone.set(racerPhone, []);
          noConsentByPhone.get(racerPhone)!.push(c);
        }
        skipped++;
        continue;
      }

      // Prefer SMS when destination phone is available; fall back to email.
      if (resolved.phone) {
        const phone = resolved.phone;
        if (!allByPhone.has(phone)) allByPhone.set(phone, []);
        allByPhone.get(phone)!.push(c);

        const alreadySent = !dryRun && (await redis.get(dedupKey(c)));
        if (alreadySent) {
          skipped++;
          continue;
        }
        if (!freshSmsByPhone.has(phone)) freshSmsByPhone.set(phone, []);
        freshSmsByPhone.get(phone)!.push(c);
      } else if (resolved.email) {
        // Canonicalize for bucketing — case-insensitive match across
        // typos like Mom@Gmail.com vs mom@gmail.com.
        const emailKey = resolved.email.trim().toLowerCase();
        if (!allByEmail.has(emailKey)) allByEmail.set(emailKey, []);
        allByEmail.get(emailKey)!.push(c);

        const alreadySent = !dryRun && (await redis.get(dedupKey(c)));
        if (alreadySent) {
          skipped++;
          continue;
        }
        if (!freshEmailByEmail.has(emailKey)) freshEmailByEmail.set(emailKey, []);
        freshEmailByEmail.get(emailKey)!.push(c);
      } else {
        // resolved was non-null but no usable phone/email — shouldn't
        // happen (picker returns null in that case), but defensive.
        skipped++;
      }
    }

    // 3. SMS — for each destination phone with at least one fresh
    //    candidate, decide single vs group, decide racer- vs guardian-
    //    flavored body, and send.
    for (const [phone, fresh] of freshSmsByPhone) {
      const all = allByPhone.get(phone) || fresh;

      // ANY member came in via guardian fallback → frame the whole
      // bucket as guardian-recipient. Mixed bucket (e.g. parent + kid
      // sharing the household phone, parent racing themselves) still
      // routes guardian-flavored since the bucket address IS the
      // parent and the body lists "your racers" (which includes them).
      const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
      const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved?.contactFirstName;

      if (all.length === 1) {
        // Single-racer single-phone path.
        const c = fresh[0];
        const ticket: RaceTicket = {
          sessionId: c.session.sessionId,
          locationId: FASTTRAX_LOCATION_ID,
          personId: c.participant.personId,
          firstName: c.participant.firstName || "Racer",
          lastName: c.participant.lastName || "",
          email: c.participant.email || undefined,
          phone: pickPhone(c.participant) || undefined,
          scheduledStart: c.session.scheduledStart,
          track: c.trackDisplay,
          raceType: c.session.type,
          heatNumber: c.session.heatNumber,
          viaGuardian: isGuardianFlavored || undefined,
          guardianFirstName: isGuardianFlavored ? guardianFirstName : undefined,
        };

        if (dryRun) {
          console.log(
            `[pre-race DRY] would sms ${phone} (1 racer: ${c.participant.firstName} ${c.participant.lastName}, session=${c.session.sessionId}${isGuardianFlavored ? ", via guardian" : ""})`,
          );
          continue;
        }

        try {
          const ticketId = await upsertRaceTicket(ticket);
          const { code, url } = await shortenUrl(`${BASE}/t/${ticketId}`);
          const member = memberFromCandidate(c);
          const body = isGuardianFlavored
            ? buildGuardianSingleSmsBody(member, url)
            : buildSingleSmsBody(c.session.name, member, url);
          const ok = await sendSms(
            phone,
            body,
            {
              sessionIds: [c.session.sessionId],
              personIds: [c.participant.personId],
              memberCount: 1,
              shortCode: code,
              viaGuardian: isGuardianFlavored,
            },
          );
          if (ok) {
            await redis.set(dedupKey(c), "1", "EX", DEDUP_TTL);
            sent++;
            singleSmsSends++;
          } else {
            errors++;
          }
        } catch (err) {
          console.error(`[pre-race] single-sms error for phone=${phone}:`, err);
          errors++;
        }
        continue;
      }

      // Multiple racers share this destination phone → ONE grouped SMS
      // + one /g/{id} page covering everyone in the bucket.
      const members: GroupTicketMember[] = all.map(memberFromCandidate);

      if (dryRun) {
        const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
        console.log(`[pre-race DRY] would sms ${phone} for ${members.length} members: ${names} (fresh=${fresh.length}${isGuardianFlavored ? ", via guardian" : ""})`);
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
          // Set dedup keys only for FRESH members — already-sent members keep their existing keys.
          for (const c of fresh) {
            await redis.set(dedupKey(c), "1", "EX", DEDUP_TTL);
          }
          sent += fresh.length;
          groupedSmsSends++;
        } else {
          errors += fresh.length;
        }
      } catch (err) {
        console.error(`[pre-race] group-sms error for phone=${phone}:`, err);
        errors += fresh.length;
      }
    }

    // 3b. No-consent path — log a "would-be SMS" entry so the admin
    //     UI can show "needs verbal OK" rows. These are racers whose
    //     own phone was opted out AND who had no guardian fallback.
    //     30-min log-dedup so we don't flood the SMS log every cron tick.
    for (const [phone, members] of noConsentByPhone) {
      const consentSkipKey = `consent-skip:pre-race:${phone}`;
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
        const sessionIds = Array.from(new Set(members.map((c) => c.session.sessionId)));
        const personIds = members.map((c) => c.participant.personId);
        let body: string;
        let shortCode: string;
        if (members.length === 1) {
          const c = members[0];
          const ticket: RaceTicket = {
            sessionId: c.session.sessionId,
            locationId: FASTTRAX_LOCATION_ID,
            personId: c.participant.personId,
            firstName: c.participant.firstName || "Racer",
            lastName: c.participant.lastName || "",
            email: c.participant.email || undefined,
            phone: pickPhone(c.participant) || undefined,
            scheduledStart: c.session.scheduledStart,
            track: c.trackDisplay,
            raceType: c.session.type,
            heatNumber: c.session.heatNumber,
          };
          const ticketId = await upsertRaceTicket(ticket);
          const shortened = await shortenUrl(`${BASE}/t/${ticketId}`);
          shortCode = shortened.code;
          body = buildSingleSmsBody(c.session.name, memberFromCandidate(c), shortened.url);
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
          source: "pre-race-cron",
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
        console.error(`[pre-race] consent-skip log error for phone=${phone}:`, err);
      }
      skipped += members.length;
    }

    // 4. Email path — bucket by destination email. Multiple recipients
    //    (guardian fallback OR shared family inbox) collapse into ONE
    //    combined email with a /g/{id} link covering all members.
    //    Dedup key still per (session, person) — guardian receiving a
    //    combined email for 3 kids sets 3 dedup keys.
    for (const [emailKey, fresh] of freshEmailByEmail) {
      const all = allByEmail.get(emailKey) || fresh;
      const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
      // Display address — preserve original casing from the picker
      // (or first candidate) for "to" header.
      const displayEmail = fresh[0].resolved?.email || emailKey;

      if (all.length === 1) {
        const c = fresh[0];
        const ticket: RaceTicket = {
          sessionId: c.session.sessionId,
          locationId: FASTTRAX_LOCATION_ID,
          personId: c.participant.personId,
          firstName: c.participant.firstName || "Racer",
          lastName: c.participant.lastName || "",
          email: c.participant.email || undefined,
          phone: pickPhone(c.participant) || undefined,
          scheduledStart: c.session.scheduledStart,
          track: c.trackDisplay,
          raceType: c.session.type,
          heatNumber: c.session.heatNumber,
          viaGuardian: isGuardianFlavored || undefined,
          guardianFirstName: isGuardianFlavored ? c.resolved?.contactFirstName : undefined,
        };

        if (dryRun) {
          console.log(
            `[pre-race DRY] would email ${displayEmail} (${c.participant.firstName} ${c.participant.lastName}, session=${c.session.sessionId}${isGuardianFlavored ? ", via guardian" : ""})`,
          );
          continue;
        }

        try {
          const ticketId = await upsertRaceTicket(ticket);
          const { url } = await shortenUrl(`${BASE}/t/${ticketId}`);
          const subject = isGuardianFlavored
            ? `E-ticket for ${c.participant.firstName || "your racer"} · ${c.session.type} Race on ${c.trackDisplay} Track`
            : `Your FastTrax e-ticket · ${c.session.type} Race on ${c.trackDisplay} Track`;
          const html = isGuardianFlavored
            ? buildGroupEmailHtml([memberFromCandidate(c)], url, "guardian")
            : buildEmailHtml(c.participant.firstName || "Racer", c.trackDisplay, c.session.type, c.session.scheduledStart, url);
          const ok = await sendEmail(displayEmail, subject, html);
          if (ok) {
            await redis.set(dedupKey(c), "1", "EX", DEDUP_TTL);
            sent++;
            emailSends++;
          } else {
            errors++;
          }
        } catch (err) {
          console.error(`[pre-race] email error for personId=${c.participant.personId}:`, err);
          errors++;
        }
        continue;
      }

      // Multiple racers share this destination email → one combined
      // email, /g/{id} page covering everyone.
      const members: GroupTicketMember[] = all.map(memberFromCandidate);

      if (dryRun) {
        const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
        console.log(`[pre-race DRY] would email ${displayEmail} for ${members.length} members: ${names} (fresh=${fresh.length}${isGuardianFlavored ? ", via guardian" : ""})`);
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
          ? `E-tickets for your racers`
          : `Your FastTrax e-tickets`;
        const html = buildGroupEmailHtml(members, url, isGuardianFlavored ? "guardian" : "racer");
        const ok = await sendEmail(displayEmail, subject, html);
        if (ok) {
          for (const c of fresh) {
            await redis.set(dedupKey(c), "1", "EX", DEDUP_TTL);
          }
          sent += fresh.length;
          emailSends++;
        } else {
          errors += fresh.length;
        }
      } catch (err) {
        console.error(`[pre-race] grouped-email error for ${emailKey}:`, err);
        errors += fresh.length;
      }
    }

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "pre-race",
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
    });

    return NextResponse.json({
      ok: true,
      dryRun,
      elapsedMs: Date.now() - started,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      activeResources: resources,
      candidates: candidates.length,
      sent,
      skipped,
      errors,
      groupedSmsSends,
      singleSmsSends,
      emailSends,
      retries: retryStats,
    });
  } catch (err) {
    console.error("[pre-race] error:", err);
    await logCronRun({
      ts: new Date().toISOString(),
      cron: "pre-race",
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
  } finally {
    // Release the concurrency lock so the next 1-min fire can start
    // immediately instead of waiting for the 90s TTL.
    if (!dryRun) {
      try { await redis.del(CRON_LOCK_KEY); } catch { /* best-effort */ }
    }
  }
}
