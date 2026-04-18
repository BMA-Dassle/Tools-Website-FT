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
  pickPhone,
  type Participant,
} from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";

/**
 * Flow A — Pre-race e-ticket cron.
 *
 * Every 10 min, looks at all sessions starting in the next ~2 hours on the
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
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
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

/** One fetched participant tied to the session it belongs to. */
interface Candidate {
  session: PandoraSession;
  trackDisplay: string;
  participant: Participant;
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
  if (weekday === "Tue") return ["Mega"];
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
  const qs = new URLSearchParams({
    locationId: FASTTRAX_LOCATION_ID,
    resourceName,
    startDate,
    endDate,
  }).toString();
  const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? (data.data as PandoraSession[]) : [];
}

async function fetchParticipants(sessionId: string | number): Promise<Participant[]> {
  const res = await fetch(
    `${BASE}/api/pandora/session-participants?locationId=${FASTTRAX_LOCATION_ID}&sessionId=${sessionId}`,
    { cache: "no-store" },
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

  try {
    const res = await fetch("https://smsapi.voxtelesys.net/api/v2/sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${VOX_API_KEY}`,
      },
      body: JSON.stringify({ to: toFormatted, from: VOX_FROM, body }),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 500);
      console.error(`[pre-race] SMS ${res.status}: ${errText}`);
      await logSms({ ts, phone: toFormatted, source: "pre-race-cron", status: res.status, ok: false, error: errText, body, ...audit });
      return false;
    }
    await logSms({ ts, phone: toFormatted, source: "pre-race-cron", status: res.status, ok: true, body, ...audit });
    return true;
  } catch (err) {
    console.error("[pre-race] SMS error:", err);
    await logSms({ ts, phone: toFormatted, source: "pre-race-cron", status: null, ok: false, error: err instanceof Error ? err.message : "network error", body, ...audit });
    return false;
  }
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.error("[pre-race] SENDGRID_API_KEY missing");
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
    console.error("[pre-race] Email error:", err);
    return false;
  }
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

const IMPORTANT_INFO = [
  `PLEASE READ — IMPORTANT RACE INFO`,
  ``,
  `The time on your ticket is your CHECK-IN CUT-OFF. Arrive at the Karting check-in desk on the 1st Floor at least 5 min early. Miss check-in and we may not be able to reschedule — missed races are non-refundable.`,
  ``,
  `Allow ~30 min from check-in to race time for briefing, helmet fitting, and prep. Lockers are in the briefing rooms. NO LOOSE ITEMS on the track.`,
  ``,
  `This is live racing — yellow flags or track conditions may cause delays. We'll announce upcoming races.`,
].join("\n");

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
    ``,
    IMPORTANT_INFO,
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
  lines.push(``);
  lines.push(IMPORTANT_INFO);
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

export async function GET(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();
  const windowStart = Date.now() - WINDOW_SKEW_BEHIND_MS;
  const windowEnd = Date.now() + WINDOW_AHEAD_MS;

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  let groupedSmsSends = 0;
  let singleSmsSends = 0;
  let emailSends = 0;

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

    // 2. Split into fresh SMS candidates (eligible for phone-grouping) and everyone else.
    //    "Everyone else" = email path, no-channel, or already-dedup'd SMS.
    const freshSmsByPhone = new Map<string, Candidate[]>();
    const allByPhone = new Map<string, Candidate[]>(); // for enriching group tickets with already-sent members
    const emailCandidates: Candidate[] = [];

    for (const c of candidates) {
      const channel = pickContactChannel(c.participant);
      if (channel.channel === "none") {
        skipped++;
        continue;
      }
      if (channel.channel === "email") {
        emailCandidates.push(c);
        continue;
      }
      // SMS — channel.phone is already canonical
      const phone = channel.phone;
      if (!allByPhone.has(phone)) allByPhone.set(phone, []);
      allByPhone.get(phone)!.push(c);

      const alreadySent = !dryRun && (await redis.get(dedupKey(c)));
      if (alreadySent) {
        skipped++;
        continue;
      }
      if (!freshSmsByPhone.has(phone)) freshSmsByPhone.set(phone, []);
      freshSmsByPhone.get(phone)!.push(c);
    }

    // 3. For each phone with at least one fresh SMS candidate, decide single vs group.
    for (const [phone, fresh] of freshSmsByPhone) {
      const all = allByPhone.get(phone) || fresh;

      // Phone-level consent gate: skip this phone only if EVERY person on it
      // has explicitly opted out. One consenting family member covers an
      // opted-out one on the same line.
      const householdConsented = all.some((c) => hasSmsConsent(c.participant));
      if (!householdConsented) {
        skipped += fresh.length;
        continue;
      }

      if (all.length === 1) {
        // Single-racer single-phone — existing path unchanged.
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
        };

        if (dryRun) {
          console.log(
            `[pre-race DRY] would sms ${phone} (1 racer: ${c.participant.firstName} ${c.participant.lastName}, session=${c.session.sessionId})`,
          );
          continue;
        }

        try {
          const ticketId = await upsertRaceTicket(ticket);
          const { code, url } = await shortenUrl(`${BASE}/t/${ticketId}`);
          const ok = await sendSms(
            phone,
            buildSingleSmsBody(c.session.name, memberFromCandidate(c), url),
            {
              sessionIds: [c.session.sessionId],
              personIds: [c.participant.personId],
              memberCount: 1,
              shortCode: code,
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

      // Multiple racers share this phone → send ONE grouped SMS + /g/{id} page.
      // Page shows the full picture (all heats today), so include already-sent members too.
      const members: GroupTicketMember[] = all.map(memberFromCandidate);

      if (dryRun) {
        const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
        console.log(`[pre-race DRY] would sms ${phone} for ${members.length} members: ${names} (fresh=${fresh.length})`);
        continue;
      }

      try {
        const groupId = await upsertGroupTicket({
          phone,
          locationId: FASTTRAX_LOCATION_ID,
          members,
        });
        const { code, url } = await shortenUrl(`${BASE}/g/${groupId}`);
        const ok = await sendSms(phone, buildGroupSmsBody(members, url), {
          sessionIds: Array.from(new Set(members.map((m) => m.sessionId))),
          personIds: members.map((m) => m.personId),
          memberCount: members.length,
          shortCode: code,
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

    // 4. Email path — one per person, no grouping. Dedup key is shared with SMS path.
    for (const c of emailCandidates) {
      const key = dedupKey(c);
      if (!dryRun && (await redis.get(key))) {
        skipped++;
        continue;
      }

      const channel = pickContactChannel(c.participant);
      if (channel.channel !== "email") continue; // sanity

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

      if (dryRun) {
        console.log(
          `[pre-race DRY] would email ${channel.email} (${c.participant.firstName} ${c.participant.lastName}, session=${c.session.sessionId})`,
        );
        continue;
      }

      try {
        const ticketId = await upsertRaceTicket(ticket);
        const { url } = await shortenUrl(`${BASE}/t/${ticketId}`);
        const ok = await sendEmail(
          channel.email,
          `Your FastTrax e-ticket · ${c.session.type} Race on ${c.trackDisplay} Track`,
          buildEmailHtml(c.participant.firstName || "Racer", c.trackDisplay, c.session.type, c.session.scheduledStart, url),
        );
        if (ok) {
          await redis.set(key, "1", "EX", DEDUP_TTL);
          sent++;
          emailSends++;
        } else {
          errors++;
        }
      } catch (err) {
        console.error(`[pre-race] email error for personId=${c.participant.personId}:`, err);
        errors++;
      }
    }

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
    });
  } catch (err) {
    console.error("[pre-race] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error", sent, skipped, errors },
      { status: 500 },
    );
  }
}
