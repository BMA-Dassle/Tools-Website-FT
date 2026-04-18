import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import redis from "@/lib/redis";
import { upsertRaceTicket, type RaceTicket } from "@/lib/race-tickets";
import { pickContactChannel, pickPhone, type Participant } from "@/lib/participant-contact";

/**
 * Flow B — "Now checking in" alert cron.
 *
 * Every minute:
 *   1. Pull /api/pandora/races-current  → { blue, red, mega } with sessionId etc.
 *   2. For each non-null track that we haven't alerted on yet:
 *      a. Pull session participants from Pandora
 *      b. For each participant:
 *           - Reuse or create an e-ticket record keyed by (sessionId, personId)
 *           - Dedupe per (sessionId, personId)
 *           - Send SMS if phone present, otherwise email
 *   3. Record dedup keys and return summary JSON
 *
 * Query params:
 *   ?dryRun=1  — log who would receive but don't send
 *
 * Auth: Vercel cron requests are trusted (same-origin). No secret required.
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const VOX_API_KEY = process.env.VOX_API_KEY || "";
const VOX_FROM = "+12394819666"; // FastTrax SMS sender
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const SHORT_TTL = 60 * 60 * 24 * 90; // 90 days
const DEDUP_TTL = 60 * 60 * 6;        // 6 hours

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

async function shortenUrl(fullUrl: string): Promise<string> {
  const code = randomBytes(4).toString("base64url").slice(0, 6);
  await redis.set(`short:${code}`, fullUrl, "EX", SHORT_TTL);
  return `${BASE}/s/${code}`;
}

/** Voxtelesys SMS — returns true on success. */
async function sendSms(to: string, body: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[checkin-alerts] VOX_API_KEY missing");
    return false;
  }
  const digits = to.replace(/\D/g, "");
  const toFormatted = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
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

/** SendGrid email fallback — returns true on success. */
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

function buildSmsBody(race: CurrentRace, shortUrl: string): string {
  // Target <= 160 chars
  return `FastTrax: Now checking in ${race.trackName} ${race.raceType} Race ${race.heatNumber}. Head to 1st Floor Karting now. Your e-ticket: ${shortUrl}`;
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

/** Parse track name from Pandora into TrackKey + canonical "Blue|Red|Mega" display. */
function trackFromName(name: string): { key: TrackKey; display: string } | null {
  const n = name.toLowerCase();
  if (n.includes("blue")) return { key: "blue", display: "Blue" };
  if (n.includes("red")) return { key: "red", display: "Red" };
  if (n.includes("mega")) return { key: "mega", display: "Mega" };
  return null;
}

export async function GET(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();
  const now = Date.now();

  const results: {
    track: string;
    sessionId: number;
    participantCount: number;
    sent: number;
    skipped: number;
    errors: number;
    reason?: string;
  }[] = [];

  try {
    const races = await fetchCurrentRaces();
    const entries: [TrackKey, CurrentRace | null][] = [
      ["blue", races.blue],
      ["red", races.red],
      ["mega", races.mega],
    ];

    for (const [trackKey, race] of entries) {
      if (!race) continue;
      const sessionId = race.sessionId;

      // Stale guard — skip if scheduledStart > 30 min in the past
      const scheduledMs = new Date(race.scheduledStart).getTime();
      if (!isNaN(scheduledMs) && scheduledMs < now - 30 * 60_000) {
        results.push({ track: trackKey, sessionId, participantCount: 0, sent: 0, skipped: 0, errors: 0, reason: "stale" });
        continue;
      }

      // Gross dedup per session — if we already processed this session, skip
      const sessionKey = `alert:checkin:session:${sessionId}`;
      if (!dryRun && (await redis.get(sessionKey))) {
        results.push({ track: trackKey, sessionId, participantCount: 0, sent: 0, skipped: 0, errors: 0, reason: "session-already-alerted" });
        continue;
      }

      const participants = await fetchParticipants(sessionId);
      if (participants.length === 0) {
        results.push({ track: trackKey, sessionId, participantCount: 0, sent: 0, skipped: 0, errors: 0, reason: "no-participants" });
        continue;
      }

      let sent = 0;
      let skipped = 0;
      let errors = 0;

      for (const p of participants) {
        const personKey = `alert:checkin:${sessionId}:${p.personId}`;
        if (!dryRun && (await redis.get(personKey))) {
          skipped++;
          continue;
        }

        // Decide channel first — respects acceptSmsCommercial / acceptMailCommercial
        const channel = pickContactChannel(p);
        if (channel.channel === "none") {
          console.log(`[checkin-alerts] skipping ${p.firstName} ${p.lastName} personId=${p.personId}: ${channel.reason}`);
          skipped++;
          continue;
        }

        // Prepare ticket (reuse if one already exists for this session/person)
        const ticket: RaceTicket = {
          sessionId,
          locationId: FASTTRAX_LOCATION_ID,
          personId: p.personId,
          firstName: p.firstName || "Racer",
          lastName: p.lastName || "",
          email: p.email || undefined,
          phone: pickPhone(p) || undefined,
          scheduledStart: race.scheduledStart,
          track: trackFromName(race.trackName)?.display || race.trackName,
          raceType: race.raceType,
          heatNumber: race.heatNumber,
        };

        if (dryRun) {
          console.log(`[checkin-alerts DRY] would ${channel.channel} ${p.firstName} ${p.lastName} sessionId=${sessionId}`);
          continue;
        }

        try {
          const ticketId = await upsertRaceTicket(ticket);
          const shortUrl = await shortenUrl(`${BASE}/t/${ticketId}`);

          let ok = false;
          if (channel.channel === "sms") {
            ok = await sendSms(channel.phone, buildSmsBody(race, shortUrl));
          } else {
            ok = await sendEmail(
              channel.email,
              "Your heat is checking in — head to Karting 1st Floor",
              buildEmailHtml(race, p.firstName || "Racer", shortUrl),
            );
          }

          if (ok) {
            await redis.set(personKey, "1", "EX", DEDUP_TTL);
            sent++;
          } else {
            errors++;
          }
        } catch (err) {
          console.error(`[checkin-alerts] error for personId=${p.personId}:`, err);
          errors++;
        }
      }

      // Session-level dedup only if we successfully sent at least one
      if (!dryRun && sent > 0) {
        await redis.set(sessionKey, "1", "EX", DEDUP_TTL);
      }

      results.push({ track: trackKey, sessionId, participantCount: participants.length, sent, skipped, errors });
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      elapsedMs: Date.now() - started,
      results,
    });
  } catch (err) {
    console.error("[checkin-alerts] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error", results },
      { status: 500 },
    );
  }
}
