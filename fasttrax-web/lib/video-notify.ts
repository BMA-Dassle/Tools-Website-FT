import { randomBytes } from "crypto";
import redis from "@/lib/redis";
import { voxSend } from "@/lib/sms-retry";
import { sendEmail as sendGridEmail } from "@/lib/sendgrid";
import { canonicalizePhone, hasSmsConsent, pickPhone, type Participant } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import type { VideoMatch } from "@/lib/video-match";
import type { CameraHistoryEntry } from "@/lib/camera-assign";

/**
 * "Your FastTrax race video is ready" notifications.
 *
 * Called by the video-match cron right after `saveVideoMatch()` succeeds.
 * Sends an SMS (if the racer has consented + we have a phone) and an
 * email (if we have an address). Both are best-effort and fire in
 * parallel; errors on one don't block the other.
 *
 * The match's `by-code` sentinel is what prevents duplicate
 * notifications across cron runs — it's set before this helper runs,
 * so if we crash mid-send the video won't get re-notified on the next
 * tick. A minor risk is losing the SMS if the process dies between
 * SET NX and voxSend; we log the failure so staff can see it and
 * manually resend via the e-ticket admin.
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const SHORT_TTL = 60 * 60 * 24 * 90; // 90 days — matches the pre-race cron's short URL TTL

/**
 * Create a short /s/{code} redirect pointing at the customer-facing
 * vt3.io URL so SMS clicks get tracked in our usual click analytics.
 * Returns the short URL; callers include it in SMS body instead of
 * the long vt3.io URL.
 */
async function shortenForSms(fullUrl: string): Promise<{ code: string; url: string }> {
  const code = randomBytes(4).toString("base64url").slice(0, 6);
  await redis.set(`short:${code}`, fullUrl, "EX", SHORT_TTL);
  return { code, url: `${BASE}/s/${code}` };
}

/** Build the SMS body. Mirrors the pre-race cron's terse style. */
function buildVideoSmsBody(entry: CameraHistoryEntry, shortUrl: string): string {
  const lines: string[] = [];
  lines.push(`FastTrax — your race video is ready!`);
  lines.push(``);
  const who = entry.firstName ? `${entry.firstName}, your ` : "Your ";
  const trackLabel = entry.track ? `${entry.track.replace(" Track", "")} Track` : "race";
  const heatLabel = entry.heatNumber ? ` Heat ${entry.heatNumber}` : "";
  lines.push(`${who}${trackLabel}${heatLabel} video is live.`);
  lines.push(``);
  lines.push(`Watch + share: ${shortUrl}`);
  return lines.join("\n");
}

/**
 * Build the HTML body. Matches the branded check-in template
 * (emails/race-day-instructions.html) — dark #000418 header with the
 * FastTrax logo, blue pill CTA, cyan-accented footer with address +
 * links. Keeps the FastTrax email family visually consistent so racers
 * recognize it the same as their race-day + confirmation emails.
 */
function buildVideoEmailHtml(entry: CameraHistoryEntry, videoUrl: string, thumbnailUrl?: string): string {
  const safe = (s: string) => s.replace(/[<>]/g, "");
  const firstName = safe(entry.firstName || "Racer");
  const trackLabel = entry.track ? safe(entry.track.replace(" Track", "")) : "race";
  const heatLabel = entry.heatNumber ? ` Heat ${entry.heatNumber}` : "";
  const raceTypeLabel = entry.raceType ? ` ${safe(entry.raceType)}` : "";

  const thumb = thumbnailUrl
    ? `<tr>
  <td align="center" style="padding: 0 40px 20px 40px;">
    <a href="${videoUrl}" style="display:inline-block;text-decoration:none;border:0">
      <img src="${thumbnailUrl}" alt="Your race video preview"
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

      <!-- THUMBNAIL -->
      ${thumb}

      <!-- CTA -->
      <tr>
        <td align="center" style="padding:${thumbnailUrl ? "4px" : "24px"} 40px 24px 40px;font-family:Arial,sans-serif;">
          <a href="${videoUrl}"
             style="display:inline-block;padding:14px 28px;background-color:#004AAD;color:#FFFFFF;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">
            Watch My Video
          </a>
          <p style="margin:14px 0 0 0;font-size:13px;color:#666;line-height:1.6;">
            Relive your run — share it, save it, race it back.
          </p>
        </td>
      </tr>

      <!-- BOOK ANOTHER / HELP -->
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

/** Build a minimal Participant-ish object so the existing
 *  `pickPhone` / `hasSmsConsent` helpers work without us reimplementing
 *  the field-preference logic. */
function entryAsParticipant(entry: CameraHistoryEntry): Participant {
  return {
    personId: entry.personId,
    firstName: entry.firstName || "",
    lastName: entry.lastName || "",
    email: entry.email ?? null,
    mobilePhone: entry.mobilePhone ?? null,
    homePhone: entry.homePhone ?? null,
    phone: entry.phone ?? null,
    acceptSmsCommercial: entry.acceptSmsCommercial,
    acceptSmsScores: entry.acceptSmsScores,
  } as Participant;
}

export interface NotifyResult {
  sms: { attempted: boolean; ok?: boolean; status?: number | null; error?: string; sentTo?: string };
  email: { attempted: boolean; ok?: boolean; status?: number | null; error?: string; sentTo?: string };
}

/**
 * Fire the SMS + email for one completed video match. The caller
 * passes both the saved `VideoMatch` and the `CameraHistoryEntry`
 * because the latter still carries the contact fields that the
 * match record doesn't need to duplicate.
 */
export async function notifyVideoReady(
  match: VideoMatch,
  entry: CameraHistoryEntry,
): Promise<NotifyResult> {
  const result: NotifyResult = {
    sms: { attempted: false },
    email: { attempted: false },
  };

  // ── SMS ────────────────────────────────────────────────────────────
  const participant = entryAsParticipant(entry);
  const rawPhone = pickPhone(participant);
  const consent = hasSmsConsent(participant);
  const phone = rawPhone ? canonicalizePhone(rawPhone) : "";

  if (consent && phone) {
    result.sms.attempted = true;
    const { url: shortUrl } = await shortenForSms(match.customerUrl);
    const body = buildVideoSmsBody(entry, shortUrl);
    const ts = new Date().toISOString();
    try {
      const send = await voxSend(phone, body);
      result.sms.ok = send.ok;
      result.sms.status = send.status;
      result.sms.sentTo = phone;
      if (!send.ok) result.sms.error = send.error;
      await logSms({
        ts,
        phone,
        source: "video-match",
        status: send.status,
        ok: send.ok,
        error: send.ok ? undefined : (send.error || "").slice(0, 500),
        body,
        sessionIds: [match.sessionId],
        personIds: [match.personId],
        memberCount: 1,
        shortCode: match.videoCode,
      });
    } catch (err) {
      result.sms.ok = false;
      result.sms.error = err instanceof Error ? err.message : "send error";
      await logSms({
        ts,
        phone,
        source: "video-match",
        status: null,
        ok: false,
        error: (result.sms.error || "").slice(0, 500),
        body,
        sessionIds: [match.sessionId],
        personIds: [match.personId],
        memberCount: 1,
        shortCode: match.videoCode,
      });
    }
  } else if (!consent && phone) {
    // Consent gate. Log once so staff can see it in the SMS admin and
    // manually resend after getting verbal OK (same UX as eTickets).
    const ts = new Date().toISOString();
    await logSms({
      ts,
      phone,
      source: "video-match",
      status: null,
      ok: false,
      error: "SMS not opted in",
      body: `(would-be video notification for ${entry.firstName || "racer"})`,
      sessionIds: [match.sessionId],
      personIds: [match.personId],
      memberCount: 1,
      shortCode: match.videoCode,
    });
  }

  // ── Email ──────────────────────────────────────────────────────────
  const to = (entry.email || "").trim();
  if (to) {
    result.email.attempted = true;
    const subject = `Your FastTrax race video is ready`;
    const html = buildVideoEmailHtml(entry, match.customerUrl, match.thumbnailUrl);
    try {
      const send = await sendGridEmail({
        to,
        toName: `${entry.firstName || ""} ${entry.lastName || ""}`.trim() || undefined,
        subject,
        html,
        // BCC the vendor audit inbox — matches the booking-confirmation
        // email's pattern. Gives staff a grep-able archive of every
        // racer-facing outbound.
        bcc: "vendorcases@dassle.us",
      });
      result.email.ok = send.ok;
      result.email.status = send.status;
      result.email.sentTo = to;
      if (!send.ok) result.email.error = send.error;
    } catch (err) {
      result.email.ok = false;
      result.email.error = err instanceof Error ? err.message : "email error";
    }
  }

  return result;
}
