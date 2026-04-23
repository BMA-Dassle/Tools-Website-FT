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
 * Build the HTML body. Mirrors the pre-race e-ticket template in
 * app/api/cron/pre-race-tickets/route.ts — same 520px card, red
 * header band, coral pill CTA — so branding stays consistent.
 */
function buildVideoEmailHtml(entry: CameraHistoryEntry, videoUrl: string, thumbnailUrl?: string): string {
  const firstName = (entry.firstName || "Racer").replace(/[<>]/g, "");
  const trackLabel = entry.track ? entry.track.replace(" Track", "") : "race";
  const heatLabel = entry.heatNumber ? ` Heat ${entry.heatNumber}` : "";
  const raceTypeLabel = entry.raceType ? ` ${entry.raceType}` : "";
  const thumb = thumbnailUrl
    ? `<p style="text-align:center;margin:0 0 18px 0">
         <a href="${videoUrl}" style="display:inline-block">
           <img src="${thumbnailUrl}" alt="" width="464" style="width:100%;max-width:464px;border-radius:10px;display:block;border:0" />
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
            <a href="${videoUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">Watch My Video</a>
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
