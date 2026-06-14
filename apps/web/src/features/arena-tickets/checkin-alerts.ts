/**
 * HP Arena "now checking in" alert service — the arena sibling of
 * app/api/cron/checkin-alerts/route.ts, enabled by Pandora's
 * GET /v2/bmi/sessions/current/{locationID} (live 2026-06-11: returns
 * recently-called arena sessions, populated from SessionAboutToStart
 * Firebird notifications, entries expiring ~20 min after call —
 * mirroring races/current).
 *
 * Every minute (once scheduled):
 *   1. Pull sessions/current for HP FM → called arena sessions.
 *   2. Write race:called:{sessionId} — open ticket pages poll
 *      /api/race-session-state and light the "checking in now" banner
 *      from this key (seam shipped with the launch build, no redeploy).
 *   3. For each called session not yet alerted, pull participants,
 *      bucket by phone/email with guardian fallback, send the urgent
 *      HP-branded SMS/email reusing the SAME /t/{id} ticket the
 *      pre-session cron minted (upsert is keyed on sessionId+personId).
 *
 * No express-lane path (racing-only concept). Dedup:
 *   alert:arena-checkin:{sid}:{pid} (6h) per person,
 *   alert:arena-checkin:session:{sid} (6h) per session.
 */
import redis from "@/lib/redis";
import { randomBytes } from "crypto";
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
  pickContactWithGuardianFallback,
  pickPhone,
  type ContactCandidate,
  type Participant,
} from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import { HEADPINZ_BASE_URL, HP_FM_LOCATION_ID } from "./constants";
import { activityDisplay, classifyArenaSession, type ArenaActivity } from "./types";
import { sendArenaEmail, sendArenaSms } from "./send";
import {
  buildArenaCheckinGroupSmsBody,
  buildArenaCheckinGuardianGroupSmsBody,
  buildArenaCheckinGuardianSingleSmsBody,
  buildArenaCheckinSingleSmsBody,
} from "./sms";
import { buildArenaCheckinEmailHtml } from "./email";

const API_BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const SHORT_TTL = 60 * 60 * 24 * 90;
const DEDUP_TTL = 60 * 60 * 6;

/** Shape from GET /v2/bmi/sessions/current/{locationID}. */
interface CalledArenaSession {
  sessionId: string;
  resourceName: string;
  /** Parsed from the session name — "Nexus Laser Tag" / "Nexus Gel Blaster". */
  type: string;
  heatNumber: number;
  scheduledStart: string | null;
  calledAt: string;
}

interface Candidate {
  session: CalledArenaSession;
  activity: ArenaActivity;
  participant: Participant;
  resolved?: ContactCandidate | null;
}

export interface ArenaCheckinSummary {
  calledSessions: { sessionId: string; name: string; reason?: string }[];
  candidates: number;
  sent: number;
  skipped: number;
  errors: number;
  groupedSmsSends: number;
  singleSmsSends: number;
  emailSends: number;
}

async function fetchCalledSessions(): Promise<CalledArenaSession[]> {
  try {
    const res = await fetch(`${PANDORA_BASE}/v2/bmi/sessions/current/${HP_FM_LOCATION_ID}`, {
      headers: {
        Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data) ? (json.data as CalledArenaSession[]) : [];
  } catch (err) {
    console.error("[arena-checkin] sessions/current fetch failed:", err);
    return [];
  }
}

async function fetchParticipants(sessionId: string): Promise<Participant[]> {
  const res = await fetch(
    `${API_BASE}/api/pandora/session-participants?locationId=${HP_FM_LOCATION_ID}&sessionId=${sessionId}&warm=1`,
    {
      cache: "no-store",
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
  return { code, url: `${HEADPINZ_BASE_URL}/s/${code}` };
}

function sessionDisplayName(s: CalledArenaSession): string {
  return `${s.heatNumber} - ${s.type}`;
}

function memberFromCandidate(c: Candidate): GroupTicketMember {
  return {
    sessionId: c.session.sessionId,
    personId: c.participant.personId,
    participantId: c.participant.participantId,
    firstName: c.participant.firstName || "Player",
    lastName: c.participant.lastName || "",
    scheduledStart: c.session.scheduledStart || c.session.calledAt,
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
    scheduledStart: c.session.scheduledStart || c.session.calledAt,
    track: activityDisplay(c.activity),
    raceType: c.session.type,
    heatNumber: c.session.heatNumber,
    activity: c.activity,
    brand: "headpinz",
    viaGuardian: viaGuardian || undefined,
    guardianFirstName: viaGuardian ? guardianFirstName : undefined,
  };
}

function personDedupKey(c: Candidate): string {
  return `alert:arena-checkin:${c.session.sessionId}:${c.participant.personId}`;
}

export async function runArenaCheckinAlerts(opts: {
  dryRun: boolean;
}): Promise<ArenaCheckinSummary> {
  const { dryRun } = opts;
  const now = Date.now();

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let groupedSmsSends = 0;
  let singleSmsSends = 0;
  let emailSends = 0;
  const calledSessions: ArenaCheckinSummary["calledSessions"] = [];

  const called = await fetchCalledSessions();
  const candidates: Candidate[] = [];

  for (const session of called) {
    const name = sessionDisplayName(session);
    const activity = classifyArenaSession(session.type || "");
    if (!activity) {
      // Party / event session on the arena resource — flag the page
      // banner anyway (harmless: no arena ticket exists for it), but
      // don't SMS.
      calledSessions.push({ sessionId: session.sessionId, name, reason: "unclassified" });
      continue;
    }

    // Light the "checking in now" banner on any open ticket page for
    // this session. 12h TTL so the flag persists through the day.
    if (!dryRun) {
      await redis.set(`race:called:${session.sessionId}`, "1", "EX", 60 * 60 * 12);
    }

    // Stale guard — a called entry whose scheduled start is 30+ min
    // gone is operational noise, not an actionable alert.
    const scheduledMs = new Date(session.scheduledStart || session.calledAt).getTime();
    if (!isNaN(scheduledMs) && scheduledMs < now - 30 * 60_000) {
      calledSessions.push({ sessionId: session.sessionId, name, reason: "stale" });
      continue;
    }

    const sessionKey = `alert:arena-checkin:session:${session.sessionId}`;
    if (!dryRun && (await redis.get(sessionKey))) {
      calledSessions.push({ sessionId: session.sessionId, name, reason: "already-alerted" });
      continue;
    }

    const participants = await fetchParticipants(session.sessionId);
    if (participants.length === 0) {
      calledSessions.push({ sessionId: session.sessionId, name, reason: "no-participants" });
      continue;
    }
    for (const p of participants) {
      candidates.push({ session, activity, participant: p });
    }
    calledSessions.push({ sessionId: session.sessionId, name });
  }

  // Contact resolution + bucketing — same shape as the racing cron.
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
      const playerPhone = canonicalizePhone(pickPhone(c.participant));
      const guardianPhone = canonicalizePhone(
        c.participant.guardian?.mobilePhone || c.participant.guardian?.homePhone || null,
      );
      if (playerPhone && !hasSmsConsent(c.participant)) {
        // Player has a phone but opted out of marketing SMS → needs verbal OK.
        if (!noConsentByPhone.has(playerPhone)) noConsentByPhone.set(playerPhone, []);
        noConsentByPhone.get(playerPhone)!.push(c);
      } else if (guardianPhone) {
        // Minor whose only contact is a guardian with a phone the picker
        // rejected (guardian opted out of SMS). Route into the SAME "needs
        // verbal OK" surface keyed on the guardian's number.
        if (!noConsentByPhone.has(guardianPhone)) noConsentByPhone.set(guardianPhone, []);
        noConsentByPhone.get(guardianPhone)!.push(c);
      } else {
        // No reachable phone for player OR guardian → surface for desk follow-up.
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

  const sessionsWithSends = new Set<string>();

  // SMS path.
  for (const [phone, fresh] of freshSmsByPhone) {
    const all = allByPhone.get(phone) || fresh;
    const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
    const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved
      ?.contactFirstName;

    if (all.length === 1) {
      const c = fresh[0];
      if (dryRun) {
        console.log(
          `[arena-checkin DRY] would sms ${phone} (1 player: ${c.participant.firstName} ${c.participant.lastName}, session=${c.session.sessionId}${isGuardianFlavored ? ", via guardian" : ""})`,
        );
        continue;
      }
      try {
        const ticketId = await upsertRaceTicket(
          ticketFromCandidate(c, isGuardianFlavored, guardianFirstName),
        );
        const { code, url } = await shortenUrl(`${HEADPINZ_BASE_URL}/t/${ticketId}`);
        const member = memberFromCandidate(c);
        const body = isGuardianFlavored
          ? buildArenaCheckinGuardianSingleSmsBody(member, url)
          : buildArenaCheckinSingleSmsBody(member, url);
        const ok = await sendArenaSms("arena-checkin-cron", phone, body, {
          sessionIds: [c.session.sessionId],
          personIds: [c.participant.personId],
          memberCount: 1,
          shortCode: code,
          viaGuardian: isGuardianFlavored,
        });
        if (ok) {
          await redis.set(personDedupKey(c), "1", "EX", DEDUP_TTL);
          sessionsWithSends.add(String(c.session.sessionId));
          sent++;
          singleSmsSends++;
        } else {
          errors++;
        }
      } catch (err) {
        console.error(`[arena-checkin] single-sms error for phone=${phone}:`, err);
        errors++;
      }
      continue;
    }

    const members: GroupTicketMember[] = all.map(memberFromCandidate);
    if (dryRun) {
      const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
      console.log(
        `[arena-checkin DRY] would sms ${phone} for ${members.length} members: ${names} (fresh=${fresh.length}${isGuardianFlavored ? ", via guardian" : ""})`,
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
      const body = isGuardianFlavored
        ? buildArenaCheckinGuardianGroupSmsBody(members, url)
        : buildArenaCheckinGroupSmsBody(members, url);
      const ok = await sendArenaSms("arena-checkin-cron", phone, body, {
        sessionIds: Array.from(new Set(members.map((m) => m.sessionId))),
        personIds: members.map((m) => m.personId),
        memberCount: members.length,
        shortCode: code,
        viaGuardian: isGuardianFlavored,
      });
      if (ok) {
        for (const c of fresh) {
          await redis.set(personDedupKey(c), "1", "EX", DEDUP_TTL);
          sessionsWithSends.add(String(c.session.sessionId));
        }
        sent += fresh.length;
        groupedSmsSends++;
      } else {
        errors += fresh.length;
      }
    } catch (err) {
      console.error(`[arena-checkin] group-sms error for phone=${phone}:`, err);
      errors += fresh.length;
    }
  }

  // No-consent audit path — same "needs verbal OK" surface as pre-session.
  for (const [phone, members] of noConsentByPhone) {
    const consentSkipKey = `consent-skip:arena-checkin:${phone}`;
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
        body = buildArenaCheckinSingleSmsBody(memberFromCandidate(c), shortened.url);
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
        body = buildArenaCheckinGroupSmsBody(groupMembers, shortened.url);
      }
      await logSms({
        ts: new Date().toISOString(),
        phone,
        source: "arena-checkin-cron",
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
      console.error(`[arena-checkin] consent-skip log error for phone=${phone}:`, err);
    }
    skipped += members.length;
  }

  // No-reachable-contact audit — players with no usable phone/email for
  // themselves OR a guardian. Previously skipped silently; mint a ticket so
  // the row shows the name + is resendable after staff collect a contact, and
  // log a skipped row with the reason. One row per (session, person), deduped.
  for (const c of noContact) {
    const auditKey = `eticket-nocontact:arena-checkin:${c.session.sessionId}:${c.participant.personId}`;
    if (dryRun || (await redis.get(auditKey))) continue;
    try {
      const ticketId = await upsertRaceTicket(ticketFromCandidate(c));
      const { code, url } = await shortenUrl(`${HEADPINZ_BASE_URL}/t/${ticketId}`);
      await logSms({
        ts: new Date().toISOString(),
        phone: "",
        source: "arena-checkin-cron",
        status: null,
        ok: false,
        error: noContactReason(c.participant),
        body: buildArenaCheckinSingleSmsBody(memberFromCandidate(c), url),
        sessionIds: [c.session.sessionId],
        personIds: [c.participant.personId],
        memberCount: 1,
        shortCode: code,
      });
      await redis.set(auditKey, "1", "EX", DEDUP_TTL);
    } catch (err) {
      console.error(
        `[arena-checkin] no-contact audit log error for personId=${c.participant.personId}:`,
        err,
      );
    }
  }

  // Email path.
  for (const [emailKey, fresh] of freshEmailByEmail) {
    const all = allByEmail.get(emailKey) || fresh;
    const isGuardianFlavored = all.some((c) => c.resolved?.recipient === "guardian");
    const guardianFirstName = all.find((c) => c.resolved?.recipient === "guardian")?.resolved
      ?.contactFirstName;
    const displayEmail = fresh[0].resolved?.email || emailKey;
    const members: GroupTicketMember[] = all.map(memberFromCandidate);

    if (dryRun) {
      const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
      console.log(
        `[arena-checkin DRY] would email ${displayEmail} for ${members.length} member(s): ${names}${isGuardianFlavored ? " (via guardian)" : ""}`,
      );
      continue;
    }

    try {
      let url: string;
      if (all.length === 1) {
        const c = fresh[0];
        const ticketId = await upsertRaceTicket(
          ticketFromCandidate(c, isGuardianFlavored, c.resolved?.contactFirstName),
        );
        url = (await shortenUrl(`${HEADPINZ_BASE_URL}/t/${ticketId}`)).url;
      } else {
        const groupId = await upsertGroupTicket({
          phone: "", // email-bucketed group has no phone
          locationId: HP_FM_LOCATION_ID,
          members,
          recipient: isGuardianFlavored ? "guardian" : "racer",
          guardianFirstName: isGuardianFlavored ? guardianFirstName : undefined,
          brand: "headpinz",
        });
        url = (await shortenUrl(`${HEADPINZ_BASE_URL}/g/${groupId}`)).url;
      }
      const subject = isGuardianFlavored
        ? `Your players' session is checking in — head to the HP Arena desk`
        : `Your HP Arena session is checking in`;
      const html = buildArenaCheckinEmailHtml(
        members,
        url,
        isGuardianFlavored ? "guardian" : "racer",
      );
      const ok = await sendArenaEmail(displayEmail, subject, html);
      if (ok) {
        for (const c of fresh) {
          await redis.set(personDedupKey(c), "1", "EX", DEDUP_TTL);
          sessionsWithSends.add(String(c.session.sessionId));
        }
        sent += fresh.length;
        emailSends++;
      } else {
        errors += fresh.length;
      }
    } catch (err) {
      console.error(`[arena-checkin] email error for ${emailKey}:`, err);
      errors += fresh.length;
    }
  }

  // Session-level dedup — one key per session with a successful send.
  if (!dryRun) {
    for (const sid of sessionsWithSends) {
      await redis.set(`alert:arena-checkin:session:${sid}`, "1", "EX", DEDUP_TTL);
    }
  }

  return {
    calledSessions,
    candidates: candidates.length,
    sent,
    skipped,
    errors,
    groupedSmsSends,
    singleSmsSends,
    emailSends,
  };
}
