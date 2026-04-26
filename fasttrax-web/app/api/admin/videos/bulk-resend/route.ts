import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { randomBytes } from "crypto";
import { listMatchesInRange, updateVideoMatch, type VideoMatch } from "@/lib/video-match";
import { voxSend } from "@/lib/sms-retry";
import { pickVideoContact, type Participant } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import { quotaEnqueue } from "@/lib/sms-quota";

/**
 * POST /api/admin/videos/bulk-resend
 *
 * Body: { minutes?: number, dryRun?: boolean }
 *   minutes — how far back to look (default 60, max 1440 = 24h)
 *   dryRun  — preview the candidate set without sending
 *
 * Resends the video-ready SMS for every match record whose `matchedAt`
 * falls within the lookback window AND has a phone on file. Skips:
 *   - manual-send synthetic records (sessionId === "manual")
 *   - matches with no phone / pending VT3 upload (no SMS to retry)
 *   - matches with notifySmsError === "SMS not opted in" (consent gate;
 *     those need verbal opt-in, not a blanket re-fire)
 *
 * Each successful re-send patches the match record's notifySms* fields
 * so the videos board flips chips green on the next 2-min refresh.
 * Quota errors funnel into the long-lived sms:quota:queue (same as the
 * cron's primary fire path) so they self-deliver once Vox / Twilio
 * are healthy again.
 *
 * Auth: middleware gates /api/admin/videos/* on ADMIN_CAMERA_TOKEN.
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const SHORT_TTL = 60 * 60 * 24 * 90;

async function shortenForSms(fullUrl: string): Promise<string> {
  const code = randomBytes(4).toString("base64url").slice(0, 6);
  await redis.set(`short:${code}`, fullUrl, "EX", SHORT_TTL);
  return `${BASE}/s/${code}`;
}

function buildSmsBody(
  m: { firstName?: string; track?: string; heatNumber?: number; shortUrl: string },
  recipient: "racer" | "guardian" = "racer",
): string {
  const racerFirst = (m.firstName || "").trim();
  const trackLabel = m.track ? `${m.track.replace(" Track", "")} Track` : "race";
  const heatLabel = m.heatNumber ? ` Heat ${m.heatNumber}` : "";
  if (recipient === "guardian") {
    const racerName = racerFirst || "your racer";
    return [
      `FastTrax — race video ready for ${racerName}!`,
      "",
      `${racerName}'s ${trackLabel}${heatLabel} video is live.`,
      "",
      `Watch + share: ${m.shortUrl}`,
    ].join("\n");
  }
  const greeting = racerFirst ? `${racerFirst}, your ` : "Your ";
  return [
    "FastTrax — your race video is ready!",
    "",
    `${greeting}${trackLabel}${heatLabel} video is live.`,
    "",
    `Watch + share: ${m.shortUrl}`,
  ].join("\n");
}

/** Cast match → minimal Participant so pickVideoContact's racer→guardian
 *  fallback runs against this single object. */
function matchAsParticipant(m: VideoMatch): Participant {
  return {
    personId: m.personId,
    firstName: m.firstName || "",
    lastName: m.lastName || "",
    email: m.email ?? null,
    mobilePhone: m.mobilePhone ?? null,
    homePhone: m.homePhone ?? null,
    phone: m.phone ?? null,
    acceptSmsCommercial: m.acceptSmsCommercial,
    guardian: m.guardian ?? null,
  } as Participant;
}

interface BulkBody {
  minutes?: number;
  dryRun?: boolean;
}

export async function POST(req: NextRequest) {
  let body: BulkBody;
  try { body = await req.json().catch(() => ({})); }
  catch { body = {}; }

  const minutes = Math.max(1, Math.min(1440, Number(body.minutes) || 60));
  const dryRun = !!body.dryRun;

  const endMs = Date.now();
  const startMs = endMs - minutes * 60_000;

  const matches = await listMatchesInRange({ startMs, endMs, limit: 1000 });

  // Filter to candidates we'd actually re-fire SMS for. Reasons we skip
  // surface in the response so staff can see what was touched vs. not.
  // Note: we don't pre-skip on "no phone" anymore — pickVideoContact
  // can fall back to the guardian for minor racers, so a record with
  // no racer phone may still be eligible if guardian.mobilePhone is on
  // file. We resolve the contact per-record below and skip there.
  const candidates: VideoMatch[] = [];
  const skipped: { match: VideoMatch; reason: string }[] = [];
  for (const m of matches) {
    if (m.sessionId === "manual") {
      skipped.push({ match: m, reason: "manual-send record" });
      continue;
    }
    if (m.pendingNotify) {
      skipped.push({ match: m, reason: "pending VT3 upload" });
      continue;
    }
    candidates.push(m);
  }

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      windowMinutes: minutes,
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      candidates: candidates.length,
      skipped: skipped.length,
      candidateSample: candidates.slice(0, 20).map((m) => ({
        videoCode: m.videoCode,
        phone: m.phone || m.mobilePhone,
        firstName: m.firstName,
        track: m.track,
        heatNumber: m.heatNumber,
        priorSms: m.notifySmsOk,
      })),
      skipReasons: skipped.reduce((acc, s) => {
        acc[s.reason] = (acc[s.reason] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });
  }

  let sent = 0;
  let queued = 0;
  let failed = 0;
  let stoppedOnQuota = false;

  for (const match of candidates) {
    // Pick recipient (racer-first, guardian-fallback). When no contact
    // is available on either, this is just a no-op skip — counts as
    // "failed" with reason "no contact".
    const candidate = pickVideoContact(matchAsParticipant(match));
    if (!candidate || !candidate.phone) {
      failed++;
      continue;
    }
    const phone = candidate.phone;
    const recipient = candidate.recipient;

    const shortUrl = await shortenForSms(match.customerUrl);
    const smsBody = buildSmsBody({
      firstName: match.firstName,
      track: match.track,
      heatNumber: match.heatNumber,
      shortUrl,
    }, recipient);
    const ts = new Date().toISOString();
    const send = await voxSend(phone, smsBody);

    if (send.ok) {
      sent++;
      match.notifySmsOk = true;
      match.notifySmsError = undefined;
      match.notifySmsSentTo = phone;
      match.notifySmsSentAt = ts;
      await updateVideoMatch(match).catch(() => void 0);
      await logSms({
        ts, phone,
        source: "admin-resend",
        status: send.status, ok: true,
        body: smsBody,
        sessionIds: [match.sessionId],
        personIds: [match.personId],
        memberCount: 1,
        shortCode: match.videoCode,
        provider: send.provider,
        failedOver: send.failedOver,
      });
    } else if (send.skipped || send.quotaHit) {
      // Quota — push onto the long-lived queue. The every-minute sweep
      // will deliver it once the cooldown elapses. Mark the record so
      // the board shows grey "queued".
      await quotaEnqueue({
        phone,
        body: smsBody,
        source: "admin-resend",
        queuedAt: ts,
        shortCode: match.videoCode,
        audit: {
          sessionIds: [match.sessionId],
          personIds: [match.personId],
          memberCount: 1,
        },
      });
      queued++;
      stoppedOnQuota = true;
      match.notifySmsOk = false;
      match.notifySmsError = `[quota] queued for next reset window (${send.error || "429"})`;
      match.notifySmsSentTo = phone;
      match.notifySmsSentAt = ts;
      await updateVideoMatch(match).catch(() => void 0);
      await logSms({
        ts, phone,
        source: "admin-resend",
        status: send.status, ok: false,
        error: match.notifySmsError,
        body: smsBody,
        sessionIds: [match.sessionId],
        personIds: [match.personId],
        memberCount: 1,
        shortCode: match.videoCode,
      });
      // Don't keep hammering — the cooldown flag is now set, every
      // subsequent voxSend in this loop will short-circuit anyway.
      // Push the rest straight to the queue without trying.
      const rest = candidates.slice(candidates.indexOf(match) + 1);
      for (const m of rest) {
        const c = pickVideoContact(matchAsParticipant(m));
        if (!c || !c.phone) { failed++; continue; }
        const sUrl = await shortenForSms(m.customerUrl);
        const sBody = buildSmsBody({ firstName: m.firstName, track: m.track, heatNumber: m.heatNumber, shortUrl: sUrl }, c.recipient);
        const tts = new Date().toISOString();
        await quotaEnqueue({
          phone: c.phone, body: sBody, source: "admin-resend", queuedAt: tts,
          shortCode: m.videoCode,
          audit: { sessionIds: [m.sessionId], personIds: [m.personId], memberCount: 1 },
        });
        queued++;
        m.notifySmsOk = false;
        m.notifySmsError = "[quota] queued for next reset window";
        m.notifySmsSentTo = c.phone;
        m.notifySmsSentAt = tts;
        await updateVideoMatch(m).catch(() => void 0);
      }
      break;
    } else {
      failed++;
      match.notifySmsOk = false;
      match.notifySmsError = (send.error || "send failed").slice(0, 500);
      match.notifySmsSentTo = phone;
      match.notifySmsSentAt = ts;
      await updateVideoMatch(match).catch(() => void 0);
      await logSms({
        ts, phone,
        source: "admin-resend",
        status: send.status, ok: false,
        error: match.notifySmsError,
        body: smsBody,
        sessionIds: [match.sessionId],
        personIds: [match.personId],
        memberCount: 1,
        shortCode: match.videoCode,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    windowMinutes: minutes,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    candidates: candidates.length,
    sent,
    queued,
    failed,
    stoppedOnQuota,
    skipped: skipped.length,
    skipReasons: skipped.reduce((acc, s) => {
      acc[s.reason] = (acc[s.reason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  });
}
