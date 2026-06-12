/**
 * HP Arena pre-session e-ticket cron service — the arena sibling of
 * app/api/cron/pre-race-tickets/route.ts, parameterized for HeadPinz
 * Fort Myers. Called by the thin route shell at
 * app/api/cron/arena-tickets/route.ts.
 *
 * Mirrors the racing cron section-for-section (candidates → contact
 * resolution/bucketing → SMS → no-consent audit → email) and reuses
 * all its shared lib machinery: ticket store, contact picker with
 * guardian fallback, voxSend/retry/quota, sms-log, SendGrid,
 * move detection via the participant index.
 *
 * Arena seams (vs racing):
 *   - Location TXBSQN0FEKQ11, single resource "HP Arena" (covers both
 *     Nexus Laser Tag and Nexus Gel Blaster; activity classified from
 *     the session name — unrecognized session names are skipped).
 *   - HeadPinz identity: SMS from VOX_FROM_HEADPINZ_FM, links on
 *     HEADPINZ_BASE_URL, HP-branded bodies, SendGrid name "HeadPinz".
 *   - Tickets carry activity + brand so /t and /g render the HP views.
 *   - Source "arena-pre-cron", dedup alert:arena-pre:{sid}:{pid}.
 *   - No check-in alert flow — arena has no races-current equivalent
 *     (Pandora ask pending); the ticket pages poll BMI checkedIn.
 */
import redis from "@/lib/redis";
import { randomBytes } from "crypto";
import {
  upsertRaceTicket,
  upsertGroupTicket,
  getParticipantTicketRef,
  supersedeMovedTicket,
  type RaceTicket,
  type GroupTicketMember,
  type ParticipantTicketRef,
} from "@/lib/race-tickets";
import {
  canonicalizePhone,
  hasSmsConsent,
  pickContactWithGuardianFallback,
  pickPhone,
  type ContactCandidate,
  type Participant,
} from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import { queueRetry, voxSend } from "@/lib/sms-retry";
import { sendEmail as sendGridEmail } from "@/lib/sendgrid";
import {
  ARENA_RESOURCES,
  HEADPINZ_BASE_URL,
  HP_FM_LOCATION_ID,
  VOX_FROM_HEADPINZ_FM,
} from "./constants";
import { activityDisplay, classifyArenaSession, type ArenaActivity } from "./types";
import {
  buildArenaGroupMoveSmsBody,
  buildArenaGroupSmsBody,
  buildArenaGuardianGroupSmsBody,
  buildArenaGuardianSingleSmsBody,
  buildArenaSingleMoveSmsBody,
  buildArenaSingleSmsBody,
} from "./sms";
import { buildArenaEmailHtml, buildArenaGroupEmailHtml, buildArenaMoveEmailHtml } from "./email";

/** Self-fetch base for the Pandora proxies (cache layers live there). */
const API_BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const SHORT_TTL = 60 * 60 * 24 * 90; // 90 days
const DEDUP_TTL = 60 * 60 * 24; // 24 hours
const WINDOW_AHEAD_MS = 2 * 60 * 60 * 1000; // 2 hours
const WINDOW_SKEW_BEHIND_MS = 5 * 60 * 1000; // include sessions started <5 min ago

interface PandoraSession {
  sessionId: string;
  name: string;
  scheduledStart: string;
  type: string;
  heatNumber: number;
}

interface Candidate {
  session: PandoraSession;
  activity: ArenaActivity;
  participant: Participant;
  resolved?: ContactCandidate | null;
  moveFrom?: ParticipantTicketRef | null;
}

export interface ArenaCronSummary {
  candidates: number;
  sent: number;
  skipped: number;
  errors: number;
  groupedSmsSends: number;
  singleSmsSends: number;
  emailSends: number;
  movesDetected: number;
  /** Sessions on the HP Arena resource whose names didn't classify as
   *  laser tag / gel blaster (parties, events) — skipped, surfaced for
   *  observability. */
  unclassifiedSessions: string[];
}

function todayETRange(): { startDate: string; endDate: string } {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return { startDate: `${ymd}T00:00:00`, endDate: `${ymd}T23:59:59` };
}

async function fetchSessions(resourceName: string): Promise<PandoraSession[]> {
  const { startDate, endDate } = todayETRange();
  // warm=1 → 45s upstream timeout; we're a cron, no user waits, and the
  // fetch populates the shared Redis cache the ticket pages read.
  const qs = new URLSearchParams({
    locationId: HP_FM_LOCATION_ID,
    resourceName,
    startDate,
    endDate,
    warm: "1",
  }).toString();
  const res = await fetch(`${API_BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? (data.data as PandoraSession[]) : [];
}

async function fetchParticipants(sessionId: string | number): Promise<Participant[]> {
  const res = await fetch(
    `${API_BASE}/api/pandora/session-participants?locationId=${HP_FM_LOCATION_ID}&sessionId=${sessionId}&warm=1`,
    {
      cache: "no-store",
      // Server-only call — the internal trust header returns the FULL
      // participant payload (name, email, phone) needed to address
      // SMS/email. Browser calls never carry it (PII redacted).
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
  // Short links render under the HeadPinz domain so the customer never
  // sees a fasttraxent.com URL for an HP Arena ticket.
  return { code, url: `${HEADPINZ_BASE_URL}/s/${code}` };
}

interface SmsAudit {
  sessionIds: (string | number)[];
  personIds: (string | number)[];
  memberCount: number;
  shortCode?: string;
  viaGuardian?: boolean;
}

/** HP-branded send — voxSend with the HeadPinz sender, arena log
 *  source, and `from` carried into both the retry queue and the quota
 *  queue so a queued arena SMS never goes out from the FastTrax DID. */
async function sendSms(to: string, body: string, audit: SmsAudit): Promise<boolean> {
  const ts = new Date().toISOString();
  const toFormatted = canonicalizePhone(to);
  if (!toFormatted) {
    await logSms({
      ts,
      phone: to,
      source: "arena-pre-cron",
      status: null,
      ok: false,
      error: "invalid phone format",
      body,
      ...audit,
    });
    return false;
  }

  const result = await voxSend(toFormatted, body, {
    fromOverride: VOX_FROM_HEADPINZ_FM,
    fallbackPrefix: "HeadPinz: ",
  });
  if (result.ok) {
    await logSms({
      ts,
      phone: toFormatted,
      source: "arena-pre-cron",
      status: result.status,
      ok: true,
      body,
      provider: result.provider,
      failedOver: result.failedOver,
      providerMessageId: result.voxId,
      ...audit,
    });
    return true;
  }

  if (result.skipped || result.quotaHit) {
    const { quotaEnqueue } = await import("@/lib/sms-quota");
    await quotaEnqueue({
      phone: toFormatted,
      body,
      source: "arena-pre-cron",
      queuedAt: ts,
      shortCode: audit.shortCode,
      from: VOX_FROM_HEADPINZ_FM,
      fallbackPrefix: "HeadPinz: ",
      audit: {
        sessionIds: audit.sessionIds,
        personIds: audit.personIds,
        memberCount: audit.memberCount,
      },
    });
    await logSms({
      ts,
      phone: toFormatted,
      source: "arena-pre-cron",
      status: result.status,
      ok: false,
      error: `[quota] queued for next reset window (${result.error || "429"})`,
      body,
      ...audit,
    });
    return false;
  }

  console.error(`[arena-pre] SMS ${result.status}: ${result.error}`);
  await logSms({
    ts,
    phone: toFormatted,
    source: "arena-pre-cron",
    status: result.status,
    ok: false,
    error: result.error || "",
    body,
    ...audit,
  });
  await queueRetry({
    cron: "arena-pre-cron",
    phone: toFormatted,
    body,
    audit,
    status: result.status,
    error: result.error || "",
    from: VOX_FROM_HEADPINZ_FM,
  });
  return false;
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const result = await sendGridEmail({
    to,
    subject,
    html,
    from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com", name: "HeadPinz" },
  });
  if (!result.ok) {
    console.error("[arena-pre] Email error:", result.status, result.error);
    return false;
  }
  return true;
}

function memberFromCandidate(c: Candidate): GroupTicketMember {
  return {
    sessionId: c.session.sessionId,
    personId: c.participant.personId,
    participantId: c.participant.participantId,
    firstName: c.participant.firstName || "Player",
    lastName: c.participant.lastName || "",
    scheduledStart: c.session.scheduledStart,
    track: activityDisplay(c.activity),
    raceType: c.session.type,
    heatNumber: c.session.heatNumber,
    activity: c.activity,
  };
}

function ticketFromCandidate(
  c: Candidate,
  viaGuardian?: boolean,
  guardianFirstName?: string,
): RaceTicket {
  return {
    sessionId: c.session.sessionId,
    locationId: HP_FM_LOCATION_ID,
    personId: c.participant.personId,
    participantId: c.participant.participantId,
    firstName: c.participant.firstName || "Player",
    lastName: c.participant.lastName || "",
    email: c.participant.email || undefined,
    phone: pickPhone(c.participant) || undefined,
    scheduledStart: c.session.scheduledStart,
    track: activityDisplay(c.activity),
    raceType: c.session.type,
    heatNumber: c.session.heatNumber,
    activity: c.activity,
    brand: "headpinz",
    viaGuardian: viaGuardian || undefined,
    guardianFirstName: viaGuardian ? guardianFirstName : undefined,
  };
}

function dedupKey(c: Candidate): string {
  return `alert:arena-pre:${c.session.sessionId}:${c.participant.personId}`;
}

/** Same move semantics as racing: the stable participantId was last
 *  notified about a DIFFERENT, still-upcoming session. The participant
 *  index is shared with racing (keyed by participantId — globally
 *  unique per BMI server), so a cross-activity move would also be
 *  caught, which is correct. */
async function detectMove(c: Candidate): Promise<ParticipantTicketRef | null> {
  const pid = c.participant.participantId;
  if (pid == null || !String(pid).trim()) return null;
  const ref = await getParticipantTicketRef(pid);
  if (!ref) return null;
  if (String(ref.sessionId) === String(c.session.sessionId)) return null;
  const oldStart = new Date(ref.scheduledStart).getTime();
  if (isNaN(oldStart) || oldStart <= Date.now()) return null;
  return ref;
}

export async function runArenaTicketCron(opts: { dryRun: boolean }): Promise<ArenaCronSummary> {
  const { dryRun } = opts;
  const windowStart = Date.now() - WINDOW_SKEW_BEHIND_MS;
  const windowEnd = Date.now() + WINDOW_AHEAD_MS;

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let groupedSmsSends = 0;
  let singleSmsSends = 0;
  let emailSends = 0;
  let movesDetected = 0;
  const unclassifiedSessions: string[] = [];

  // 1. Collect every (session, participant) pair in the window.
  const candidates: Candidate[] = [];
  for (const resourceName of ARENA_RESOURCES) {
    const sessions = await fetchSessions(resourceName);
    const upcoming = sessions.filter((s) => {
      const ms = new Date(s.scheduledStart).getTime();
      return !isNaN(ms) && ms >= windowStart && ms <= windowEnd;
    });
    for (const session of upcoming) {
      const activity = classifyArenaSession(session.name);
      if (!activity) {
        // Party / event / unknown session type on the arena resource —
        // not ours to ticket. Surface for observability.
        unclassifiedSessions.push(session.name);
        continue;
      }
      let participants: Participant[] = [];
      try {
        participants = await fetchParticipants(session.sessionId);
      } catch {
        continue;
      }
      for (const p of participants) {
        candidates.push({ session, activity, participant: p });
      }
    }
  }

  // 2. Resolve contacts (player first, guardian fallback for minors),
  //    bucket by canonical phone / email. Same shape as racing.
  const freshSmsByPhone = new Map<string, Candidate[]>();
  const allByPhone = new Map<string, Candidate[]>();
  const freshEmailByEmail = new Map<string, Candidate[]>();
  const allByEmail = new Map<string, Candidate[]>();
  const noConsentByPhone = new Map<string, Candidate[]>();

  for (const c of candidates) {
    const resolved = pickContactWithGuardianFallback(c.participant);
    c.resolved = resolved ?? null;

    if (!resolved) {
      const playerPhone = canonicalizePhone(pickPhone(c.participant));
      if (playerPhone && !hasSmsConsent(c.participant)) {
        if (!noConsentByPhone.has(playerPhone)) noConsentByPhone.set(playerPhone, []);
        noConsentByPhone.get(playerPhone)!.push(c);
      }
      skipped++;
      continue;
    }

    if (resolved.phone) {
      const phone = resolved.phone;
      if (!allByPhone.has(phone)) allByPhone.set(phone, []);
      allByPhone.get(phone)!.push(c);

      const alreadySent = !dryRun && (await redis.get(dedupKey(c)));
      if (alreadySent) {
        skipped++;
        continue;
      }
      c.moveFrom = await detectMove(c);
      if (c.moveFrom) movesDetected++;
      if (!freshSmsByPhone.has(phone)) freshSmsByPhone.set(phone, []);
      freshSmsByPhone.get(phone)!.push(c);
    } else if (resolved.email) {
      const emailKey = resolved.email.trim().toLowerCase();
      if (!allByEmail.has(emailKey)) allByEmail.set(emailKey, []);
      allByEmail.get(emailKey)!.push(c);

      const alreadySent = !dryRun && (await redis.get(dedupKey(c)));
      if (alreadySent) {
        skipped++;
        continue;
      }
      c.moveFrom = await detectMove(c);
      if (c.moveFrom) movesDetected++;
      if (!freshEmailByEmail.has(emailKey)) freshEmailByEmail.set(emailKey, []);
      freshEmailByEmail.get(emailKey)!.push(c);
    } else {
      skipped++;
    }
  }

  // 3. SMS path.
  for (const [phone, fresh] of freshSmsByPhone) {
    const all = allByPhone.get(phone) || fresh;
    const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
    const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved
      ?.contactFirstName;

    if (all.length === 1) {
      const c = fresh[0];
      if (dryRun) {
        console.log(
          `[arena DRY] would sms ${phone} (1 player: ${c.participant.firstName} ${c.participant.lastName}, ${c.activity}, session=${c.session.sessionId}${isGuardianFlavored ? ", via guardian" : ""}${c.moveFrom ? `, MOVED from session ${c.moveFrom.sessionId}` : ""})`,
        );
        continue;
      }
      try {
        const ticket = ticketFromCandidate(c, isGuardianFlavored, guardianFirstName);
        const ticketId = await upsertRaceTicket(ticket);
        const { code, url } = await shortenUrl(`${HEADPINZ_BASE_URL}/t/${ticketId}`);
        const member = memberFromCandidate(c);
        if (c.moveFrom) {
          await supersedeMovedTicket(c.moveFrom, c.participant.participantId!, {
            ticketId,
            group: false,
            sessionId: ticket.sessionId,
            heatNumber: ticket.heatNumber,
            track: ticket.track,
            raceType: ticket.raceType,
            scheduledStart: ticket.scheduledStart,
          });
        }
        const body = c.moveFrom
          ? buildArenaSingleMoveSmsBody(member, c.moveFrom, url)
          : isGuardianFlavored
            ? buildArenaGuardianSingleSmsBody(member, url)
            : buildArenaSingleSmsBody(member, url);
        const ok = await sendSms(phone, body, {
          sessionIds: [c.session.sessionId],
          personIds: [c.participant.personId],
          memberCount: 1,
          shortCode: code,
          viaGuardian: isGuardianFlavored,
        });
        if (ok) {
          await redis.set(dedupKey(c), "1", "EX", DEDUP_TTL);
          sent++;
          singleSmsSends++;
        } else {
          errors++;
        }
      } catch (err) {
        console.error(`[arena-pre] single-sms error for phone=${phone}:`, err);
        errors++;
      }
      continue;
    }

    // Grouped SMS — one /g/{id} page for the whole bucket.
    const members: GroupTicketMember[] = all.map(memberFromCandidate);

    if (dryRun) {
      const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
      const moves = fresh.filter((c) => c.moveFrom);
      const moveNote = moves.length
        ? `, MOVES: ${moves.map((c) => `${c.participant.firstName}(${c.moveFrom!.sessionId}→${c.session.sessionId})`).join(", ")}`
        : "";
      console.log(
        `[arena DRY] would sms ${phone} for ${members.length} members: ${names} (fresh=${fresh.length}${isGuardianFlavored ? ", via guardian" : ""}${moveNote})`,
      );
      continue;
    }

    try {
      const groupId = await upsertGroupTicket({
        phone,
        locationId: HP_FM_LOCATION_ID,
        members,
        recipient: isGuardianFlavored ? "guardian" : "racer",
        guardianFirstName: isGuardianFlavored ? guardianFirstName : undefined,
        brand: "headpinz",
      });
      const { code, url } = await shortenUrl(`${HEADPINZ_BASE_URL}/g/${groupId}`);
      const anyMoved = fresh.some((c) => c.moveFrom);
      const entries = all.map((c) => ({
        member: memberFromCandidate(c),
        movedFrom: c.moveFrom ?? null,
      }));
      for (const c of fresh) {
        if (!c.moveFrom) continue;
        await supersedeMovedTicket(c.moveFrom, c.participant.participantId!, {
          ticketId: groupId,
          group: true,
          sessionId: c.session.sessionId,
          heatNumber: c.session.heatNumber,
          track: activityDisplay(c.activity),
          raceType: c.session.type,
          scheduledStart: c.session.scheduledStart,
        });
      }
      const body = anyMoved
        ? buildArenaGroupMoveSmsBody(entries, url, { guardian: isGuardianFlavored })
        : isGuardianFlavored
          ? buildArenaGuardianGroupSmsBody(members, url)
          : buildArenaGroupSmsBody(members, url);
      const ok = await sendSms(phone, body, {
        sessionIds: Array.from(new Set(members.map((m) => m.sessionId))),
        personIds: members.map((m) => m.personId),
        memberCount: members.length,
        shortCode: code,
        viaGuardian: isGuardianFlavored,
      });
      if (ok) {
        for (const c of fresh) {
          await redis.set(dedupKey(c), "1", "EX", DEDUP_TTL);
        }
        sent += fresh.length;
        groupedSmsSends++;
      } else {
        errors += fresh.length;
      }
    } catch (err) {
      console.error(`[arena-pre] group-sms error for phone=${phone}:`, err);
      errors += fresh.length;
    }
  }

  // 3b. No-consent audit path — "needs verbal OK" rows for the admin board.
  for (const [phone, members] of noConsentByPhone) {
    const consentSkipKey = `consent-skip:arena-pre:${phone}`;
    const already = !dryRun && (await redis.get(consentSkipKey));
    if (already || dryRun) {
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
        const ticketId = await upsertRaceTicket(ticketFromCandidate(c));
        const shortened = await shortenUrl(`${HEADPINZ_BASE_URL}/t/${ticketId}`);
        shortCode = shortened.code;
        body = buildArenaSingleSmsBody(memberFromCandidate(c), shortened.url);
      } else {
        const groupMembers: GroupTicketMember[] = members.map(memberFromCandidate);
        const groupId = await upsertGroupTicket({
          phone,
          locationId: HP_FM_LOCATION_ID,
          members: groupMembers,
          brand: "headpinz",
        });
        const shortened = await shortenUrl(`${HEADPINZ_BASE_URL}/g/${groupId}`);
        shortCode = shortened.code;
        body = buildArenaGroupSmsBody(groupMembers, shortened.url);
      }
      await logSms({
        ts: new Date().toISOString(),
        phone,
        source: "arena-pre-cron",
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
      console.error(`[arena-pre] consent-skip log error for phone=${phone}:`, err);
    }
    skipped += members.length;
  }

  // 4. Email path.
  for (const [emailKey, fresh] of freshEmailByEmail) {
    const all = allByEmail.get(emailKey) || fresh;
    const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
    const displayEmail = fresh[0].resolved?.email || emailKey;

    if (all.length === 1) {
      const c = fresh[0];
      if (dryRun) {
        console.log(
          `[arena DRY] would email ${displayEmail} (${c.participant.firstName} ${c.participant.lastName}, ${c.activity}, session=${c.session.sessionId}${isGuardianFlavored ? ", via guardian" : ""}${c.moveFrom ? `, MOVED from session ${c.moveFrom.sessionId}` : ""})`,
        );
        continue;
      }
      try {
        const ticket = ticketFromCandidate(c, isGuardianFlavored, c.resolved?.contactFirstName);
        const ticketId = await upsertRaceTicket(ticket);
        const { url } = await shortenUrl(`${HEADPINZ_BASE_URL}/t/${ticketId}`);
        if (c.moveFrom) {
          await supersedeMovedTicket(c.moveFrom, c.participant.participantId!, {
            ticketId,
            group: false,
            sessionId: ticket.sessionId,
            heatNumber: ticket.heatNumber,
            track: ticket.track,
            raceType: ticket.raceType,
            scheduledStart: ticket.scheduledStart,
          });
        }
        const display = activityDisplay(c.activity);
        const subject = c.moveFrom
          ? `Your HP Arena session time changed · ${display}`
          : isGuardianFlavored
            ? `E-ticket for ${c.participant.firstName || "your player"} · ${display} at HP Arena`
            : `Your HP Arena e-ticket · ${display}`;
        const html = c.moveFrom
          ? buildArenaMoveEmailHtml(
              [{ member: memberFromCandidate(c), movedFrom: c.moveFrom }],
              url,
              isGuardianFlavored ? "guardian" : "racer",
            )
          : isGuardianFlavored
            ? buildArenaGroupEmailHtml([memberFromCandidate(c)], url, "guardian")
            : buildArenaEmailHtml(
                c.participant.firstName || "Player",
                display,
                c.session.scheduledStart,
                url,
              );
        const ok = await sendEmail(displayEmail, subject, html);
        if (ok) {
          await redis.set(dedupKey(c), "1", "EX", DEDUP_TTL);
          sent++;
          emailSends++;
        } else {
          errors++;
        }
      } catch (err) {
        console.error(`[arena-pre] email error for personId=${c.participant.personId}:`, err);
        errors++;
      }
      continue;
    }

    const members: GroupTicketMember[] = all.map(memberFromCandidate);

    if (dryRun) {
      const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
      console.log(
        `[arena DRY] would email ${displayEmail} for ${members.length} members: ${names} (fresh=${fresh.length}${isGuardianFlavored ? ", via guardian" : ""})`,
      );
      continue;
    }

    try {
      const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved
        ?.contactFirstName;
      const groupId = await upsertGroupTicket({
        phone: "", // email-bucketed group has no phone
        locationId: HP_FM_LOCATION_ID,
        members,
        recipient: isGuardianFlavored ? "guardian" : "racer",
        guardianFirstName: isGuardianFlavored ? guardianFirstName : undefined,
        brand: "headpinz",
      });
      const { url } = await shortenUrl(`${HEADPINZ_BASE_URL}/g/${groupId}`);
      const anyMoved = fresh.some((c) => c.moveFrom);
      for (const c of fresh) {
        if (!c.moveFrom) continue;
        await supersedeMovedTicket(c.moveFrom, c.participant.participantId!, {
          ticketId: groupId,
          group: true,
          sessionId: c.session.sessionId,
          heatNumber: c.session.heatNumber,
          track: activityDisplay(c.activity),
          raceType: c.session.type,
          scheduledStart: c.session.scheduledStart,
        });
      }
      const subject = anyMoved
        ? `Your HP Arena session times changed`
        : isGuardianFlavored
          ? `E-tickets for your players`
          : `Your HP Arena e-tickets`;
      const html = anyMoved
        ? buildArenaMoveEmailHtml(
            all.map((c) => ({ member: memberFromCandidate(c), movedFrom: c.moveFrom ?? null })),
            url,
            isGuardianFlavored ? "guardian" : "racer",
          )
        : buildArenaGroupEmailHtml(members, url, isGuardianFlavored ? "guardian" : "racer");
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
      console.error(`[arena-pre] grouped-email error for ${emailKey}:`, err);
      errors += fresh.length;
    }
  }

  return {
    candidates: candidates.length,
    sent,
    skipped,
    errors,
    groupedSmsSends,
    singleSmsSends,
    emailSends,
    movesDetected,
    unclassifiedSessions,
  };
}
