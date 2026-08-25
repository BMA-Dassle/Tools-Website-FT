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
 *   - Multi-center: runs the FULL pipeline once per center (FM + Naples,
 *     see ./centers.ts) so phone/email buckets — and therefore group
 *     tickets — never mix locations. Resource "HP Arena" at both centers
 *     covers Nexus Laser Tag AND Nexus Gel Blaster; activity classified
 *     from the session name — unrecognized session names are skipped.
 *   - Naples runs its own BMI server, so every key built from its BMI
 *     ids carries a location segment (bmiKeyScope); FM keys keep their
 *     legacy shape.
 *   - HeadPinz identity: SMS from the center's DID, links on
 *     HEADPINZ_BASE_URL, HP-branded bodies, SendGrid name "HeadPinz".
 *   - Tickets carry activity + brand so /t and /g render the HP views.
 *   - Source "arena-pre-cron", dedup alert:arena-pre:{scope}{sid}:{pid}.
 *   - No check-in alert flow here — see ./checkin-alerts.ts.
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
  noContactReason,
  pickContactWithGuardianFallback,
  pickPhone,
  type ContactCandidate,
  type Participant,
} from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import { bmiKeyScope } from "@/lib/bmi-key-scope";
import { heldUntilMorning } from "~/features/eticket/quiet-hours";
import { HEADPINZ_BASE_URL } from "./constants";
import { activeArenaCenters, type ArenaCenter } from "./centers";
import { sendArenaEmail, sendArenaSms, type ArenaSmsAudit } from "./send";
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
  /** Sessions withheld by the 9am ET morning floor — counted rather than
   *  dropped silently, so a run that sends nothing at 8am is readable. */
  heldForMorning: number;
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

async function fetchSessions(center: ArenaCenter, resourceName: string): Promise<PandoraSession[]> {
  const { startDate, endDate } = todayETRange();
  // warm=1 → 45s upstream timeout; we're a cron, no user waits, and the
  // fetch populates the shared Redis cache the ticket pages read.
  const qs = new URLSearchParams({
    locationId: center.locationId,
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

async function fetchParticipants(
  center: ArenaCenter,
  sessionId: string | number,
): Promise<Participant[]> {
  const res = await fetch(
    `${API_BASE}/api/pandora/session-participants?locationId=${center.locationId}&sessionId=${sessionId}&warm=1`,
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

/** Send paths extracted to ./send.ts so the check-in alert cron shares
 *  the exact HP sender / retry / quota wiring. */
function sendSms(
  center: ArenaCenter,
  to: string,
  body: string,
  audit: ArenaSmsAudit,
): Promise<boolean> {
  return sendArenaSms("arena-pre-cron", to, body, audit, {
    from: center.smsFrom,
    locationId: center.locationId,
  });
}

function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  return sendArenaEmail(to, subject, html);
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
  center: ArenaCenter,
  c: Candidate,
  viaGuardian?: boolean,
  guardianFirstName?: string,
): RaceTicket {
  return {
    sessionId: c.session.sessionId,
    locationId: center.locationId,
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

// Location-scoped: Naples BMI ids can collide numerically with FM's
// (separate BMI servers), so the scope segment keeps dedup state apart.
function dedupKey(center: ArenaCenter, c: Candidate): string {
  return `alert:arena-pre:${bmiKeyScope(center.locationId)}${c.session.sessionId}:${c.participant.personId}`;
}

/** Same move semantics as racing: the stable participantId was last
 *  notified about a DIFFERENT, still-upcoming session. The participant
 *  index is shared with racing (keyed by participantId — unique per BMI
 *  server, and location-scoped via bmiKeyScope across servers), so a
 *  cross-activity move within one server would also be caught, which is
 *  correct. */
async function detectMove(center: ArenaCenter, c: Candidate): Promise<ParticipantTicketRef | null> {
  const pid = c.participant.participantId;
  if (pid == null || !String(pid).trim()) return null;
  const ref = await getParticipantTicketRef(center.locationId, pid);
  if (!ref) return null;
  if (String(ref.sessionId) === String(c.session.sessionId)) return null;
  const oldStart = new Date(ref.scheduledStart).getTime();
  if (isNaN(oldStart) || oldStart <= Date.now()) return null;
  return ref;
}

/** Run every active center's pipeline and aggregate the summaries. Each
 *  center runs fully independently — buckets (and therefore group
 *  tickets) never mix locations, and a Pandora failure at one center
 *  can't starve the other. */
export async function runArenaTicketCron(opts: { dryRun: boolean }): Promise<ArenaCronSummary> {
  const totals: ArenaCronSummary = {
    candidates: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    groupedSmsSends: 0,
    singleSmsSends: 0,
    emailSends: 0,
    movesDetected: 0,
    heldForMorning: 0,
    unclassifiedSessions: [],
  };
  for (const center of activeArenaCenters()) {
    try {
      const s = await runArenaTicketCronForCenter(center, opts.dryRun);
      totals.candidates += s.candidates;
      totals.sent += s.sent;
      totals.skipped += s.skipped;
      totals.errors += s.errors;
      totals.groupedSmsSends += s.groupedSmsSends;
      totals.singleSmsSends += s.singleSmsSends;
      totals.emailSends += s.emailSends;
      totals.movesDetected += s.movesDetected;
      totals.heldForMorning += s.heldForMorning;
      totals.unclassifiedSessions.push(...s.unclassifiedSessions);
    } catch (err) {
      console.error(`[arena-pre] center ${center.key} run failed:`, err);
      totals.errors++;
    }
  }
  return totals;
}

async function runArenaTicketCronForCenter(
  center: ArenaCenter,
  dryRun: boolean,
): Promise<ArenaCronSummary> {
  const windowStart = Date.now() - WINDOW_SKEW_BEHIND_MS;
  const windowEnd = Date.now() + WINDOW_AHEAD_MS;

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let groupedSmsSends = 0;
  let singleSmsSends = 0;
  let emailSends = 0;
  let movesDetected = 0;
  let heldForMorning = 0;
  const unclassifiedSessions: string[] = [];

  // 1. Collect every (session, participant) pair in the window.
  const candidates: Candidate[] = [];
  for (const resourceName of center.resources) {
    const sessions = await fetchSessions(center, resourceName);
    const upcoming = sessions.filter((s) => {
      const ms = new Date(s.scheduledStart).getTime();
      return !isNaN(ms) && ms >= windowStart && ms <= windowEnd;
    });
    for (const session of upcoming) {
      const activity = classifyArenaSession(session.name);
      if (!activity) {
        // Party / event / unknown session type on the arena resource —
        // not ours to ticket. Surface for observability.
        unclassifiedSessions.push(`${center.key}: ${session.name}`);
        continue;
      }
      // THE MORNING FLOOR — the day's tickets wait for 9am ET, a session
      // starting before 9am never does. Belt-and-braces here: the two-hour
      // window above already means nothing daytime is visible before 9am, so
      // this only bites if that window ever widens the way racing's did on
      // 2026-08-19. It is the midnight laser-tag sessions this rail actually
      // serves that make the carve-out matter, so state it where they are.
      if (heldUntilMorning(session.scheduledStart)) {
        heldForMorning++;
        continue;
      }
      let participants: Participant[] = [];
      try {
        participants = await fetchParticipants(center, session.sessionId);
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
        // rejected (guardian opted out of SMS). Previously dropped silently;
        // route into the SAME "needs verbal OK" surface keyed on the
        // guardian's number so staff can collect consent + resend to them.
        if (!noConsentByPhone.has(guardianPhone)) noConsentByPhone.set(guardianPhone, []);
        noConsentByPhone.get(guardianPhone)!.push(c);
      } else {
        // No reachable phone for player OR guardian → surface so staff can
        // collect a contact at the desk instead of it vanishing.
        noContact.push(c);
      }
      skipped++;
      continue;
    }

    if (resolved.phone) {
      const phone = resolved.phone;
      if (!allByPhone.has(phone)) allByPhone.set(phone, []);
      allByPhone.get(phone)!.push(c);

      const alreadySent = !dryRun && (await redis.get(dedupKey(center, c)));
      if (alreadySent) {
        skipped++;
        continue;
      }
      c.moveFrom = await detectMove(center, c);
      if (c.moveFrom) movesDetected++;
      if (!freshSmsByPhone.has(phone)) freshSmsByPhone.set(phone, []);
      freshSmsByPhone.get(phone)!.push(c);
    } else if (resolved.email) {
      const emailKey = resolved.email.trim().toLowerCase();
      if (!allByEmail.has(emailKey)) allByEmail.set(emailKey, []);
      allByEmail.get(emailKey)!.push(c);

      const alreadySent = !dryRun && (await redis.get(dedupKey(center, c)));
      if (alreadySent) {
        skipped++;
        continue;
      }
      c.moveFrom = await detectMove(center, c);
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
        const ticket = ticketFromCandidate(center, c, isGuardianFlavored, guardianFirstName);
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
        const ok = await sendSms(center, phone, body, {
          sessionIds: [c.session.sessionId],
          personIds: [c.participant.personId],
          memberCount: 1,
          shortCode: code,
          viaGuardian: isGuardianFlavored,
        });
        if (ok) {
          await redis.set(dedupKey(center, c), "1", "EX", DEDUP_TTL);
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
        locationId: center.locationId,
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
      const ok = await sendSms(center, phone, body, {
        sessionIds: Array.from(new Set(members.map((m) => m.sessionId))),
        personIds: members.map((m) => m.personId),
        memberCount: members.length,
        shortCode: code,
        viaGuardian: isGuardianFlavored,
      });
      if (ok) {
        for (const c of fresh) {
          await redis.set(dedupKey(center, c), "1", "EX", DEDUP_TTL);
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
        const ticketId = await upsertRaceTicket(ticketFromCandidate(center, c));
        const shortened = await shortenUrl(`${HEADPINZ_BASE_URL}/t/${ticketId}`);
        shortCode = shortened.code;
        body = buildArenaSingleSmsBody(memberFromCandidate(c), shortened.url);
      } else {
        const groupMembers: GroupTicketMember[] = members.map(memberFromCandidate);
        const groupId = await upsertGroupTicket({
          phone,
          locationId: center.locationId,
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

  // 3c. No-reachable-contact audit — players with no usable phone/email for
  //     themselves OR a guardian (booked with no contact, or a guardian who
  //     has none / is fully opted out). Previously skipped silently with zero
  //     log trace, so a whole session could look like "nothing sent". Mint a
  //     ticket so the admin row shows the player name + is resendable once
  //     staff collect a contact at the desk, and log a skipped row with the
  //     reason. One row per (session, person), deduped for the operating window.
  for (const c of noContact) {
    const auditKey = `eticket-nocontact:arena-pre:${bmiKeyScope(center.locationId)}${c.session.sessionId}:${c.participant.personId}`;
    if (dryRun || (await redis.get(auditKey))) continue;
    try {
      const ticketId = await upsertRaceTicket(ticketFromCandidate(center, c));
      const { code, url } = await shortenUrl(`${HEADPINZ_BASE_URL}/t/${ticketId}`);
      await logSms({
        ts: new Date().toISOString(),
        phone: "",
        source: "arena-pre-cron",
        status: null,
        ok: false,
        error: noContactReason(c.participant),
        body: buildArenaSingleSmsBody(memberFromCandidate(c), url),
        sessionIds: [c.session.sessionId],
        personIds: [c.participant.personId],
        memberCount: 1,
        shortCode: code,
      });
      await redis.set(auditKey, "1", "EX", DEDUP_TTL);
    } catch (err) {
      console.error(
        `[arena-pre] no-contact audit log error for personId=${c.participant.personId}:`,
        err,
      );
    }
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
        const ticket = ticketFromCandidate(
          center,
          c,
          isGuardianFlavored,
          c.resolved?.contactFirstName,
        );
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
              center.address,
            )
          : isGuardianFlavored
            ? buildArenaGroupEmailHtml([memberFromCandidate(c)], url, "guardian", center.address)
            : buildArenaEmailHtml(
                c.participant.firstName || "Player",
                display,
                c.session.scheduledStart,
                url,
                center.address,
              );
        const ok = await sendEmail(displayEmail, subject, html);
        if (ok) {
          await redis.set(dedupKey(center, c), "1", "EX", DEDUP_TTL);
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
        locationId: center.locationId,
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
            center.address,
          )
        : buildArenaGroupEmailHtml(
            members,
            url,
            isGuardianFlavored ? "guardian" : "racer",
            center.address,
          );
      const ok = await sendEmail(displayEmail, subject, html);
      if (ok) {
        for (const c of fresh) {
          await redis.set(dedupKey(center, c), "1", "EX", DEDUP_TTL);
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
    heldForMorning,
    unclassifiedSessions,
  };
}
