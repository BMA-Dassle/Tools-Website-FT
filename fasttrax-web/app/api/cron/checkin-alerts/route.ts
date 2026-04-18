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
}

async function fetchCurrentRaces(): Promise<CurrentRaces> {
  const res = await fetch(`${BASE}/api/pandora/races-current`, { cache: "no-store" });
  if (!res.ok) return { blue: null, red: null, mega: null };
  return (await res.json()) as CurrentRaces;
}

async function fetchParticipants(sessionId: number): Promise<Participant[]> {
  const res = await fetch(
    `${BASE}/api/pandora/session-participants?locationId=${FASTTRAX_LOCATION_ID}&sessionId=${sessionId}`,
    { cache: "no-store" },
  );
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? (data.data as Participant[]) : [];
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

async function shortenUrl(fullUrl: string): Promise<string> {
  const code = randomBytes(4).toString("base64url").slice(0, 6);
  await redis.set(`short:${code}`, fullUrl, "EX", SHORT_TTL);
  return `${BASE}/s/${code}`;
}

async function sendSms(to: string, body: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[checkin-alerts] VOX_API_KEY missing");
    return false;
  }
  const toFormatted = canonicalizePhone(to);
  if (!toFormatted) return false;

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
      console.error(`[checkin-alerts] SMS ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[checkin-alerts] SMS error:", err);
    return false;
  }
}

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
    `Head to Karting · 1st Floor NOW`,
    ``,
    shortUrl,
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
  const blocks: string[][] = [];
  for (const group of bySession.values()) {
    const first = group[0];
    const block = [`${first.heatNumber} - ${first.track} ${first.raceType} · ${timeET(first.scheduledStart)}`];
    for (const m of group) block.push(`- ${racerLabel(m)}`);
    blocks.push(block);
  }
  // Blank line between session blocks + before the call-to-action + url
  for (let i = 0; i < blocks.length; i++) {
    lines.push(``);
    lines.push(...blocks[i]);
  }
  lines.push(``);
  lines.push(`Head to Karting · 1st Floor NOW`);
  lines.push(``);
  lines.push(shortUrl);
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

      const [participants, expressHolders] = await Promise.all([
        fetchParticipants(sessionId),
        fetchExpressParticipants(sessionId),
      ]);

      if (participants.length === 0 && expressHolders.length === 0) {
        sessionResults.push({ track: trackKey, sessionId, reason: "no-participants" });
        continue;
      }

      // Dedupe express holders against the Pandora roster — if someone is
      // already scheduled into the session in Pandora, don't double-process.
      const pandoraPids = new Set(participants.map((p) => String(p.personId)));
      const freshExpress = expressHolders.filter((e) => !pandoraPids.has(String(e.personId)));

      const trackDisplay = trackFromName(race.trackName)?.display || race.trackName;
      for (const p of participants) {
        candidates.push({ race, trackDisplay, participant: p });
      }
      for (const p of freshExpress) {
        candidates.push({ race, trackDisplay, participant: p });
      }
      sessionResults.push({ track: trackKey, sessionId });
    }

    // Bucket fresh SMS candidates by canonical phone; collect email separately.
    const freshSmsByPhone = new Map<string, Candidate[]>();
    const allByPhone = new Map<string, Candidate[]>();
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
      const phone = channel.phone;
      if (!allByPhone.has(phone)) allByPhone.set(phone, []);
      allByPhone.get(phone)!.push(c);

      const already = !dryRun && (await redis.get(personDedupKey(c)));
      if (already) {
        skipped++;
        continue;
      }
      if (!freshSmsByPhone.has(phone)) freshSmsByPhone.set(phone, []);
      freshSmsByPhone.get(phone)!.push(c);
    }

    // Session-level locks to set after successful grouped/single sends per session.
    const sessionsWithSends = new Set<number>();

    // SMS path — single vs grouped.
    for (const [phone, fresh] of freshSmsByPhone) {
      const all = allByPhone.get(phone) || fresh;

      // Phone-level consent gate: skip only if EVERY member at this phone has
      // explicitly opted out. One consenting family member covers opted-out
      // racers on the same line.
      const householdConsented = all.some((c) => hasSmsConsent(c.participant));
      if (!householdConsented) {
        skipped += fresh.length;
        continue;
      }

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
        };

        if (dryRun) {
          console.log(
            `[checkin-alerts DRY] would sms ${phone} (1 racer: ${c.participant.firstName} ${c.participant.lastName}, session=${c.race.sessionId})`,
          );
          continue;
        }

        try {
          const ticketId = await upsertRaceTicket(ticket);
          const shortUrl = await shortenUrl(`${BASE}/t/${ticketId}`);
          const ok = await sendSms(
            phone,
            buildSingleSmsBody(c.race, memberFromCandidate(c), shortUrl),
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

      // Grouped
      const members: GroupTicketMember[] = all.map(memberFromCandidate);
      if (dryRun) {
        const names = members.map((m) => `${m.firstName} ${m.lastName}`).join(", ");
        console.log(
          `[checkin-alerts DRY] would sms ${phone} for ${members.length} members: ${names} (fresh=${fresh.length})`,
        );
        continue;
      }

      try {
        const groupId = await upsertGroupTicket({
          phone,
          locationId: FASTTRAX_LOCATION_ID,
          members,
        });
        const shortUrl = await shortenUrl(`${BASE}/g/${groupId}`);
        const ok = await sendSms(phone, buildGroupSmsBody(members, shortUrl));
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

    // Email path — one per person.
    for (const c of emailCandidates) {
      const key = personDedupKey(c);
      if (!dryRun && (await redis.get(key))) {
        skipped++;
        continue;
      }
      const channel = pickContactChannel(c.participant);
      if (channel.channel !== "email") continue;

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

      if (dryRun) {
        console.log(
          `[checkin-alerts DRY] would email ${channel.email} (${c.participant.firstName} ${c.participant.lastName}, session=${c.race.sessionId})`,
        );
        continue;
      }

      try {
        const ticketId = await upsertRaceTicket(ticket);
        const shortUrl = await shortenUrl(`${BASE}/t/${ticketId}`);
        const ok = await sendEmail(
          channel.email,
          "Your heat is checking in — head to Karting 1st Floor",
          buildEmailHtml(c.race, c.participant.firstName || "Racer", shortUrl),
        );
        if (ok) {
          await redis.set(key, "1", "EX", DEDUP_TTL);
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
    }

    // Session-level dedup — one key per session that had a successful send.
    if (!dryRun) {
      for (const sid of sessionsWithSends) {
        await redis.set(`alert:checkin:session:${sid}`, "1", "EX", DEDUP_TTL);
      }
    }

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
    });
  } catch (err) {
    console.error("[checkin-alerts] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error", sent, skipped, errors },
      { status: 500 },
    );
  }
}
