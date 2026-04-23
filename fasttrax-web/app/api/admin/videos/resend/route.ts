import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { randomBytes } from "crypto";
import { getMatch, updateVideoMatch, saveVideoMatch, type VideoMatch } from "@/lib/video-match";
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
  const first = (m.firstName || "").trim();
  const greeting = first ? `${first}, your ` : "Your ";
  const trackLabel = m.track ? `${m.track.replace(" Track", "")} Track` : "race";
  const heatLabel = m.heatNumber ? ` Heat ${m.heatNumber}` : "";
  return [
    "FastTrax — your race video is ready!",
    "",
    `${greeting}${trackLabel}${heatLabel} video is live.`,
    "",
    `Watch + share: ${m.shortUrl}`,
  ].join("\n");
}

/**
 * Matches the branded race-day template — dark #000418 header with the
 * FastTrax logo, blue pill CTA, cyan-accented footer. Identical copy
 * of the auto-send flow in lib/video-notify.ts so a resend from the
 * admin is visually indistinguishable from the cron-fired one.
 */
function buildEmailHtml(m: {
  firstName?: string;
  track?: string;
  heatNumber?: number;
  raceType?: string;
  videoUrl: string;
  thumbnailUrl?: string;
}): string {
  const safe = (s: string) => s.replace(/[<>]/g, "");
  const firstName = safe(m.firstName || "Racer");
  const trackLabel = m.track ? safe(m.track.replace(" Track", "")) : "race";
  const heatLabel = m.heatNumber ? ` Heat ${m.heatNumber}` : "";
  const raceTypeLabel = m.raceType ? ` ${safe(m.raceType)}` : "";

  const thumb = m.thumbnailUrl
    ? `<tr>
  <td align="center" style="padding: 0 40px 20px 40px;">
    <a href="${m.videoUrl}" style="display:inline-block;text-decoration:none;border:0">
      <img src="${m.thumbnailUrl}" alt="Your race video preview"
           width="520"
           style="width:100%; max-width:520px; height:auto; border-radius:6px; display:block; border:0"/>
    </a>
  </td>
</tr>`
    : "";

  return `<!doctype html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Your FastTrax race video is ready</title>
</head>
<body style="margin:0;padding:0;background-color:#F2F3F5;-webkit-text-size-adjust:100%;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F2F3F5;">
  <tr><td align="center" style="padding:20px 10px;">

    <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E0E0E0;">

      <!-- HEADER -->
      <tr>
        <td align="center" style="padding:28px 40px;background-color:#000418;">
          <img src="https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png"
               alt="FastTrax Entertainment"
               style="max-width:180px;height:auto;display:block" />
        </td>
      </tr>

      <!-- HEADLINE -->
      <tr>
        <td align="center" style="padding:28px 40px 8px 40px;font-family:Arial,sans-serif;">
          <p style="margin:0 0 10px 0;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#004AAD;font-weight:bold;">
            Your Race Video
          </p>
          <h1 style="margin:0 0 6px 0;font-size:24px;color:#1A1A1A;letter-spacing:1px;text-transform:uppercase;">
            Hey ${firstName}!
          </h1>
          <p style="margin:0;font-size:15px;color:#555;line-height:1.6;">
            Your <strong style="color:#1A1A1A;">${trackLabel}${heatLabel}${raceTypeLabel}</strong> is ready to watch.
          </p>
        </td>
      </tr>

      ${thumb}

      <!-- CTA -->
      <tr>
        <td align="center" style="padding:${m.thumbnailUrl ? "4px" : "24px"} 40px 24px 40px;font-family:Arial,sans-serif;">
          <a href="${m.videoUrl}"
             style="display:inline-block;padding:14px 28px;background-color:#004AAD;color:#FFFFFF;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">
            Watch My Video
          </a>
          <p style="margin:14px 0 0 0;font-size:13px;color:#666;line-height:1.6;">
            Relive your run — share it, save it, race it back.
          </p>
        </td>
      </tr>

      <!-- BOOK ANOTHER -->
      <tr>
        <td align="center" style="padding:0 40px 28px 40px;font-family:Arial,sans-serif;">
          <a href="https://fasttraxent.com/book/race"
             style="display:inline-block;padding:12px 24px;background-color:#D71C1C;color:#FFFFFF;text-decoration:none;border-radius:555px;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">
            Book Another Race
          </a>
          <p style="margin:14px 0 0 0;font-size:12px;color:#999;">
            Questions? Call <strong style="color:#333;">(239) 481-9666</strong>
          </p>
        </td>
      </tr>

      <!-- FOOTER -->
      <tr>
        <td style="padding:20px 40px;background-color:#000418;font-family:Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="50%" style="font-size:11px;color:#8A8FA0;vertical-align:top;">
                <strong style="color:#FFFFFF;">FastTrax Entertainment</strong><br/>
                14501 Global Parkway<br/>
                Fort Myers, FL 33913
              </td>
              <td width="50%" align="right" style="font-size:11px;color:#8A8FA0;vertical-align:top;">
                <a href="https://fasttraxent.com" style="color:#00E2E5;text-decoration:none;">fasttraxent.com</a><br/>
                <a href="https://fasttraxent.com/racing" style="color:#00E2E5;text-decoration:none;">Racing Info</a><br/>
                <a href="https://fasttraxent.com/pricing" style="color:#00E2E5;text-decoration:none;">Pricing</a>
              </td>
            </tr>
          </table>
          <p style="margin:12px 0 0 0;font-size:10px;color:#555;text-align:center;">
            Thanks for racing with us.
          </p>
        </td>
      </tr>

    </table>

  </td></tr>
</table>
</body>
</html>`;
}

type Body = {
  /** Matched resend: provide sessionId + personId, we load the existing
   *  match record. */
  sessionId?: string | number;
  personId?: string | number;
  /** Unmatched / manual send: provide videoCode (the 10-char vt3 share
   *  code) plus the raw vt3 fields the admin client already has.
   *  A manual match record is created on successful send so the row
   *  flips to "matched" on next list refresh. */
  videoCode?: string;
  systemNumber?: string;     // video.system.name — the base/dock id
  cameraNumber?: number;     // video.camera — hardware camera id
  customerUrl?: string;
  thumbnailUrl?: string;
  capturedAt?: string;
  duration?: number;
  /** Racer identity for the manual match — optional. firstName renders
   *  in the SMS/email; if blank we fall back to a generic greeting. */
  firstName?: string;
  lastName?: string;

  channel?: "sms" | "email" | "both";
  overridePhone?: string;
  overrideEmail?: string;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const channel = body.channel;
  if (channel !== "sms" && channel !== "email" && channel !== "both") {
    return NextResponse.json({ error: "channel must be sms|email|both" }, { status: 400 });
  }

  // Branch: matched resend (existing flow) vs manual send for an
  // unmatched vt3 video. Matched path requires the racer's sessionId +
  // personId; manual path requires videoCode + at least overridePhone
  // (for SMS) / overrideEmail (for email).
  //
  // Fall-through: if sessionId+personId are provided but getMatch
  // returns null, AND a videoCode is also in the payload, treat as a
  // manual send. This keeps the UI working when the match-log is
  // stale or the match record was saved with empty identifiers.
  let match: VideoMatch | null = null;
  let isManualSend = false;

  if (body.sessionId && body.personId) {
    match = await getMatch(body.sessionId, body.personId);
    if (!match && !body.videoCode) {
      return NextResponse.json({ error: "match not found" }, { status: 404 });
    }
  }

  if (!match && body.videoCode) {
    isManualSend = true;
    // Build a minimal match record from what the client passed. We'll
    // save it after a successful send so the row transitions to matched.
    if (!body.customerUrl) body.customerUrl = `https://vt3.io/?code=${body.videoCode}`;
    if (!body.capturedAt) return NextResponse.json({ error: "capturedAt required for unmatched send" }, { status: 400 });
    if (channel !== "email" && !body.overridePhone) {
      return NextResponse.json({ error: "overridePhone required for SMS send on unmatched video" }, { status: 400 });
    }
    if (channel !== "sms" && !body.overrideEmail) {
      return NextResponse.json({ error: "overrideEmail required for email send on unmatched video" }, { status: 400 });
    }
    match = {
      // Synthetic key — sessionId "manual" + personId = videoCode so
      // the match record URI is unique and recognizable. Staff can see
      // "manually sent" history by grep-ing for matches with
      // sessionId='manual'.
      sessionId: "manual",
      personId: body.videoCode,
      firstName: body.firstName || "",
      lastName: body.lastName || "",
      systemNumber: body.systemNumber || "",
      cameraNumber: body.cameraNumber,
      videoId: 0,
      videoCode: body.videoCode,
      customerUrl: body.customerUrl,
      thumbnailUrl: body.thumbnailUrl,
      capturedAt: body.capturedAt,
      duration: body.duration,
      matchedAt: new Date().toISOString(),
      email: body.overrideEmail,
      phone: body.overridePhone,
    };
  }

  if (!match) {
    return NextResponse.json(
      { error: "provide either (sessionId+personId) for a matched resend, or videoCode+overrides for a manual send" },
      { status: 400 },
    );
  }

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
          // Same vendor archive inbox as the booking-confirmation and
          // auto-fired video emails.
          bcc: "vendorcases@dassle.us",
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

  if (isManualSend) {
    // Create a real match record so the row stops appearing in the
    // unmatched list on next refresh. saveVideoMatch uses a
    // video-match:by-code NX sentinel so even if the cron resolves the
    // same code a minute later, it won't override the manual send.
    await saveVideoMatch(match).catch(() => void 0);
  } else {
    await updateVideoMatch(match).catch(() => void 0);
  }

  return NextResponse.json({ ok: true, result, match });
}
