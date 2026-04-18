import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import redis from "@/lib/redis";
import { upsertRaceTicket, type RaceTicket } from "@/lib/race-tickets";
import { pickContactChannel, pickPhone, type Participant } from "@/lib/participant-contact";

/**
 * Flow A — Pre-race e-ticket cron.
 *
 * Every 10 min, looks at all sessions starting in the next ~2 hours on the
 * operating tracks for today (Blue + Red on normal days, Mega only on Tuesdays),
 * and sends each participant an e-ticket via SMS (priority) or email (fallback).
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
const WINDOW_SKEW_BEHIND_MS = 5 * 60 * 1000; // include heats that started <5 min ago (cron overlap grace)

interface PandoraSession {
  sessionId: string;
  name: string;
  scheduledStart: string;
  type: string;
  heatNumber: number;
}

/** "Blue Track" | "Red Track" | "Mega" → display name used in copy + ticket */
function resourceToTrackDisplay(r: string): string {
  if (r.toLowerCase().startsWith("blue")) return "Blue";
  if (r.toLowerCase().startsWith("red")) return "Red";
  return "Mega";
}

/** Resources to poll based on today's weekday in ET. Tuesday = Mega only. */
function activeResourcesForToday(): string[] {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date());
  if (weekday === "Tue") return ["Mega"];
  return ["Blue Track", "Red Track"];
}

/** Day start + day end in ET, in the YYYY-MM-DDTHH:MM:SS format the endpoint uses. */
function todayETRange(): { startDate: string; endDate: string } {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // YYYY-MM-DD
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

async function shortenUrl(fullUrl: string): Promise<string> {
  const code = randomBytes(4).toString("base64url").slice(0, 6);
  await redis.set(`short:${code}`, fullUrl, "EX", SHORT_TTL);
  return `${BASE}/s/${code}`;
}

async function sendSms(to: string, body: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[pre-race] VOX_API_KEY missing");
    return false;
  }
  const digits = to.replace(/\D/g, "");
  const toFormatted =
    digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : null;
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
      console.error(`[pre-race] SMS ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[pre-race] SMS error:", err);
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

function buildSmsBody(track: string, raceType: string, scheduledStart: string, shortUrl: string): string {
  const time = formatTimeET(scheduledStart);
  return `FastTrax: Your ${raceType} race on the ${track} Track is at ${time}. Arrive 30 min early. Your e-ticket: ${shortUrl}`;
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

export async function GET(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();
  const windowStart = Date.now() - WINDOW_SKEW_BEHIND_MS;
  const windowEnd = Date.now() + WINDOW_AHEAD_MS;

  const perTrack: {
    track: string;
    sessionsInWindow: number;
    sent: number;
    skipped: number;
    errors: number;
  }[] = [];

  try {
    const resources = activeResourcesForToday();

    for (const resourceName of resources) {
      const trackDisplay = resourceToTrackDisplay(resourceName);
      const sessions = await fetchSessions(resourceName);

      // Filter to the [now-5min, now+2h] window
      const upcoming = sessions.filter((s) => {
        const ms = new Date(s.scheduledStart).getTime();
        return !isNaN(ms) && ms >= windowStart && ms <= windowEnd;
      });

      let sent = 0;
      let skipped = 0;
      let errors = 0;

      for (const session of upcoming) {
        const sid = session.sessionId;
        let participants: Participant[] = [];
        try {
          participants = await fetchParticipants(sid);
        } catch {
          continue;
        }
        if (participants.length === 0) continue;

        for (const p of participants) {
          const personKey = `alert:pre-race:${sid}:${p.personId}`;
          if (!dryRun && (await redis.get(personKey))) {
            skipped++;
            continue;
          }

          // Decide channel first — respects acceptSmsCommercial / acceptMailCommercial
          const channel = pickContactChannel(p);
          if (channel.channel === "none") {
            skipped++;
            continue;
          }

          const ticket: RaceTicket = {
            sessionId: sid,
            locationId: FASTTRAX_LOCATION_ID,
            personId: p.personId,
            firstName: p.firstName || "Racer",
            lastName: p.lastName || "",
            email: p.email || undefined,
            phone: pickPhone(p) || undefined,
            scheduledStart: session.scheduledStart,
            track: trackDisplay,
            raceType: session.type,
            heatNumber: session.heatNumber,
          };

          if (dryRun) {
            console.log(
              `[pre-race DRY] would ${channel.channel} ${p.firstName} ${p.lastName} session=${sid} (${session.name} @ ${session.scheduledStart})`,
            );
            continue;
          }

          try {
            const ticketId = await upsertRaceTicket(ticket);
            const shortUrl = await shortenUrl(`${BASE}/t/${ticketId}`);

            let ok = false;
            if (channel.channel === "sms") {
              ok = await sendSms(channel.phone, buildSmsBody(trackDisplay, session.type, session.scheduledStart, shortUrl));
            } else {
              ok = await sendEmail(
                channel.email,
                `Your FastTrax e-ticket · ${session.type} Race on ${trackDisplay} Track`,
                buildEmailHtml(p.firstName || "Racer", trackDisplay, session.type, session.scheduledStart, shortUrl),
              );
            }

            if (ok) {
              await redis.set(personKey, "1", "EX", DEDUP_TTL);
              sent++;
            } else {
              errors++;
            }
          } catch (err) {
            console.error(`[pre-race] error for personId=${p.personId}:`, err);
            errors++;
          }
        }
      }

      perTrack.push({
        track: resourceName,
        sessionsInWindow: upcoming.length,
        sent,
        skipped,
        errors,
      });
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      elapsedMs: Date.now() - started,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      activeResources: resources,
      perTrack,
    });
  } catch (err) {
    console.error("[pre-race] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error", perTrack },
      { status: 500 },
    );
  }
}
