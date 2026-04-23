import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { randomBytes } from "crypto";
import { getMatch, updateVideoMatch } from "@/lib/video-match";
import { voxSend } from "@/lib/sms-retry";
import { sendEmail as sendGridEmail } from "@/lib/sendgrid";
import { canonicalizePhone } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";

/**
 * POST /api/admin/videos/resend
 *
 * Body:
 *   {
 *     sessionId: string | number;      // required
 *     personId: string | number;       // required
 *     channel: "sms" | "email" | "both";  // required
 *     overridePhone?: string;          // optional — send SMS here instead
 *     overrideEmail?: string;          // optional — send email here instead
 *   }
 *
 * Loads the saved match record, rebuilds the exact SMS body + email
 * HTML the cron would have sent, fires to the override (if any) or the
 * snapshotted contact on the match record. Logs SMS with
 * source='admin-resend' for audit (same pattern as the eTickets
 * resend).
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

function buildSmsBody(m: {
  firstName?: string;
  track?: string;
  heatNumber?: number;
  shortUrl: string;
}): string {
  const who = m.firstName ? `${m.firstName}, your ` : "Your ";
  const trackLabel = m.track ? `${m.track.replace(" Track", "")} Track` : "race";
  const heatLabel = m.heatNumber ? ` Heat ${m.heatNumber}` : "";
  return [
    "FastTrax — your race video is ready!",
    "",
    `${who}${trackLabel}${heatLabel} video is live.`,
    "",
    `Watch + share: ${m.shortUrl}`,
  ].join("\n");
}

function buildEmailHtml(m: {
  firstName?: string;
  track?: string;
  heatNumber?: number;
  raceType?: string;
  videoUrl: string;
  thumbnailUrl?: string;
}): string {
  const firstName = (m.firstName || "Racer").replace(/[<>]/g, "");
  const trackLabel = m.track ? m.track.replace(" Track", "") : "race";
  const heatLabel = m.heatNumber ? ` Heat ${m.heatNumber}` : "";
  const raceTypeLabel = m.raceType ? ` ${m.raceType}` : "";
  const thumb = m.thumbnailUrl
    ? `<p style="text-align:center;margin:0 0 18px 0">
         <a href="${m.videoUrl}" style="display:inline-block">
           <img src="${m.thumbnailUrl}" alt="" width="464" style="width:100%;max-width:464px;border-radius:10px;display:block;border:0" />
         </a>
       </p>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#E41C1D;padding:22px 28px;color:#fff;text-align:center">
          <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;opacity:0.9">FastTrax Entertainment</p>
          <h1 style="margin:0;font-size:26px;letter-spacing:-0.5px">Your Race Video</h1>
        </td></tr>
        <tr><td style="padding:26px 28px">
          <p style="margin:0 0 12px 0;font-size:16px;line-height:1.5">Hey ${firstName} — your <strong>${trackLabel}${heatLabel}${raceTypeLabel}</strong> video is ready to watch and share.</p>
          ${thumb}
          <p style="text-align:center;margin:24px 0 6px 0">
            <a href="${m.videoUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">Watch My Video</a>
          </p>
          <p style="margin:16px 0 0 0;font-size:13px;line-height:1.5;color:#555;text-align:center">
            Relive your run — share it, save it, race it back.
          </p>
          <p style="margin:24px 0 0 0;font-size:12px;color:#888;text-align:center">14501 Global Parkway, Fort Myers FL 33913</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

type Body = {
  sessionId?: string | number;
  personId?: string | number;
  channel?: "sms" | "email" | "both";
  overridePhone?: string;
  overrideEmail?: string;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const sessionId = body.sessionId;
  const personId = body.personId;
  const channel = body.channel;

  if (!sessionId || !personId) return NextResponse.json({ error: "sessionId + personId required" }, { status: 400 });
  if (channel !== "sms" && channel !== "email" && channel !== "both") {
    return NextResponse.json({ error: "channel must be sms|email|both" }, { status: 400 });
  }

  const match = await getMatch(sessionId, personId);
  if (!match) return NextResponse.json({ error: "match not found" }, { status: 404 });

  const result: {
    sms?: { ok: boolean; status: number | null; sentTo?: string; error?: string };
    email?: { ok: boolean; status: number | null; sentTo?: string; error?: string };
  } = {};

  // SMS ────────────────────────────────────────────────────────────────
  if (channel === "sms" || channel === "both") {
    const rawPhone = (body.overridePhone || match.phone || match.mobilePhone || match.homePhone || "").trim();
    const phone = canonicalizePhone(rawPhone);
    if (!phone) {
      result.sms = {
        ok: false,
        status: null,
        error: `Invalid phone: ${rawPhone || "(none)"}`,
      };
    } else {
      const shortUrl = await shortenForSms(match.customerUrl);
      const smsBody = buildSmsBody({
        firstName: match.firstName,
        track: match.track,
        heatNumber: match.heatNumber,
        shortUrl,
      });
      const ts = new Date().toISOString();
      try {
        const send = await voxSend(phone, smsBody);
        result.sms = { ok: send.ok, status: send.status, sentTo: phone, error: send.ok ? undefined : send.error };
        await logSms({
          ts, phone,
          source: "admin-resend",
          status: send.status, ok: send.ok,
          error: send.ok ? undefined : (send.error || "").slice(0, 500),
          body: smsBody,
          sessionIds: [match.sessionId],
          personIds: [match.personId],
          memberCount: 1,
          shortCode: match.videoCode,
        });
      } catch (err) {
        result.sms = { ok: false, status: null, error: err instanceof Error ? err.message : "send error" };
      }
    }
  }

  // Email ──────────────────────────────────────────────────────────────
  if (channel === "email" || channel === "both") {
    const to = (body.overrideEmail || match.email || "").trim();
    if (!to) {
      result.email = { ok: false, status: null, error: "No email on file; supply overrideEmail" };
    } else {
      const html = buildEmailHtml({
        firstName: match.firstName,
        track: match.track,
        heatNumber: match.heatNumber,
        raceType: match.raceType,
        videoUrl: match.customerUrl,
        thumbnailUrl: match.thumbnailUrl,
      });
      try {
        const send = await sendGridEmail({
          to,
          toName: `${match.firstName || ""} ${match.lastName || ""}`.trim() || undefined,
          subject: "Your FastTrax race video is ready",
          html,
        });
        result.email = { ok: send.ok, status: send.status, sentTo: to, error: send.ok ? undefined : send.error };
      } catch (err) {
        result.email = { ok: false, status: null, error: err instanceof Error ? err.message : "email error" };
      }
    }
  }

  // Patch the match record with the most recent notify status (so the
  // admin UI reflects the resend outcome right away).
  const nowIso = new Date().toISOString();
  if (result.sms) {
    match.notifySmsOk = result.sms.ok;
    match.notifySmsError = result.sms.ok ? undefined : result.sms.error;
    match.notifySmsSentTo = result.sms.sentTo;
    match.notifySmsSentAt = nowIso;
  }
  if (result.email) {
    match.notifyEmailOk = result.email.ok;
    match.notifyEmailError = result.email.ok ? undefined : result.email.error;
    match.notifyEmailSentTo = result.email.sentTo;
    match.notifyEmailSentAt = nowIso;
  }
  await updateVideoMatch(match).catch(() => void 0);

  return NextResponse.json({ ok: true, result, match });
}
