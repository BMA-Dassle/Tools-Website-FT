/**
 * Lane-ready notification — sends SMS + email when bowling lanes are ready.
 *
 * Shared between:
 *   1. Webhook handler (instant, on Arrived/Running events)
 *   2. Pre-arrival cron (fallback, polls QAMF lane status every 2 min)
 *
 * Idempotent: calls markLaneReadySent() which uses a conditional UPDATE.
 */

import { type BowlingReservation, markLaneReadySent } from "@/lib/bowling-db";
import { shortenUrl } from "@/lib/short-url";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const VOX_API_KEY = process.env.VOX_API_KEY || "";
const SITE_URL = "https://headpinz.com";

/**
 * Per-center display name + outbound SMS From number.
 * Exported so other features (guest survey, etc.) can reuse without duplicating.
 */
export const CENTER_META: Record<string, { name: string; smsFrom: string }> = {
  TXBSQN0FEKQ11: { name: "HeadPinz Fort Myers", smsFrom: "+12393022155" },
  PPTR5G2N0QXF7: { name: "HeadPinz Naples", smsFrom: "+12394553755" },
  // FastTrax racing — Square location id LAB52GY480CJF (see
  // race-credit-redeem.ts). smsFrom is the default VOX_FROM the race-video
  // text already sends from, so the +15-min racing survey arrives from the
  // same number the racer just received their video on.
  LAB52GY480CJF: { name: "FastTrax", smsFrom: "+12394819666" },
};

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) return false;
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: "HeadPinz Entertainment" },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });
  return res.ok;
}

async function sendSms(to: string, body: string, fromNumber: string): Promise<boolean> {
  if (!VOX_API_KEY) return false;
  const toFormatted = to.length === 10 ? `+1${to}` : `+${to}`;
  const { voxSend } = await import("@/lib/sms-retry");
  const { logSms } = await import("@/lib/sms-log");
  const result = await voxSend(toFormatted, body, { fromOverride: fromNumber });

  await logSms({
    ts: new Date().toISOString(),
    phone: toFormatted,
    source: "bowling-lane-ready",
    status: result.status,
    ok: result.ok,
    body,
    provider: result.provider,
    failedOver: result.failedOver,
    providerMessageId: result.voxId || result.twilioSid,
  }).catch(() => void 0);

  if (result.ok) return true;

  // Queue for retry on quota hit
  if (result.skipped || result.quotaHit) {
    const { quotaEnqueue } = await import("@/lib/sms-quota");
    await quotaEnqueue({
      phone: toFormatted,
      body,
      from: fromNumber,
      source: "bowling-lane-ready",
      queuedAt: new Date().toISOString(),
    });
    return true; // will be delivered eventually
  }
  return false;
}

function buildEmailHtml(
  guestName: string,
  time: string,
  centerName: string,
  laneLabel: string,
  checkinLink: string,
): string {
  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <style type="text/css">
    :root { color-scheme: light; supported-color-schemes: light; }
    body { margin: 0; padding: 0; background-color: #F2F3F5; -webkit-text-size-adjust: 100%; }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#F2F3F5;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F2F3F5;">
<tr>
<td align="center" style="padding: 20px 10px;">

<table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:8px; overflow:hidden; border: 1px solid #E0E0E0;">

<!-- HEADER LOGOS -->
<tr>
<td style="padding: 24px 40px; background-color: #000418;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="left" width="50%">
  <img src="https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/hp_logo%201.png" width="130" alt="HeadPinz" style="height:auto;" />
</td>
<td align="right" width="50%">
  <img src="https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png" width="130" alt="FastTrax" style="height:auto;" />
</td>
</tr>
</table>
</td>
</tr>

<!-- HEADLINE -->
<tr>
<td align="center" style="padding: 28px 40px 12px 40px; font-family: Arial, sans-serif;">
<h1 style="margin: 0 0 8px 0; font-size: 24px; color: #1A1A1A; letter-spacing: 1px; text-transform: uppercase;">
  Your Lane is Ready!
</h1>
</td>
</tr>

<!-- BODY -->
<tr>
<td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
<p style="margin: 0 0 16px; font-size: 15px; color: #333333; line-height: 1.6; text-align: center;">
  Hey ${guestName}! Your lane at <strong>${centerName}</strong> is set up and waiting for you.
</p>
<p style="margin: 0 0 24px; font-size: 15px; color: #333333; line-height: 1.6; text-align: center;">
  Check in and open your lane right from your phone — no need to wait in line!
</p>
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <a href="${checkinLink}" style="display:inline-block;padding:14px 32px;background-color:#004AAD;color:#FFFFFF;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Check In Now</a>
</td></tr></table>
</td>
</tr>

<!-- FOOTER -->
<tr>
<td style="padding: 16px 40px; border-top: 1px solid #E0E0E0;">
<p style="margin:0;color:#999999;font-size:11px;text-align:center;font-family:Arial,sans-serif;">HeadPinz Entertainment &mdash; Part of FastTrax Entertainment</p>
</td>
</tr>

</table>

</td>
</tr>
</table>
</body></html>`;
}

// ── Public API ──────────────────────────────────────────────────────

export async function sendLaneReadyNotification(
  reservation: BowlingReservation,
  laneLabel?: string,
): Promise<{ smsOk: boolean; emailOk: boolean }> {
  // If the reservation was just created (< 30s ago), delay so the booking
  // confirmation SMS/email arrives first. Without this, a booking within
  // 30 min of the current time can get the lane-ready SMS before the
  // confirmation because QAMF webhooks fire within seconds.
  const insertedMs = reservation.insertedAt ? new Date(reservation.insertedAt).getTime() : 0;
  const ageSec = (Date.now() - insertedMs) / 1000;
  if (ageSec > 0 && ageSec < 30) {
    console.log(
      `[lane-ready] neonId=${reservation.id} recent booking (${Math.round(ageSec)}s ago)` +
        ` — delaying 5s for confirmation to arrive first`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const center = CENTER_META[reservation.centerCode] ?? CENTER_META.TXBSQN0FEKQ11;
  const time = formatTime(reservation.bookedAt);
  const guestFirst = (reservation.guestName ?? "").split(" ")[0] || "there";
  const rawPath = `/hp/book/bowling/checkin?neonId=${reservation.id}`;
  const shortCode = await shortenUrl(rawPath);
  const checkinLink = `${SITE_URL}/s/${shortCode}`;
  // Don't include lane number — guests will walk to it before staff is ready
  const lanePart = " Your lane is ready! Check in and open your lane right from your phone!";

  let emailOk = false;
  let smsOk = false;

  // Send email
  if (reservation.guestEmail) {
    try {
      emailOk = await sendEmail(
        reservation.guestEmail,
        "Your Lane is Ready!",
        buildEmailHtml(guestFirst, time, center.name, laneLabel ?? "", checkinLink),
      );
    } catch (err) {
      console.warn(`[lane-ready] email failed neonId=${reservation.id}:`, err);
    }
  }

  // Send SMS
  if (reservation.guestPhone) {
    try {
      const normalized = normalizePhone(reservation.guestPhone);
      if (normalized.length >= 10) {
        const smsBody = `HeadPinz:${lanePart} ${checkinLink}`;
        smsOk = await sendSms(normalized, smsBody, center.smsFrom);
      }
    } catch (err) {
      console.warn(`[lane-ready] sms failed neonId=${reservation.id}:`, err);
    }
  }

  // Mark sent (even if one channel failed — don't double-send)
  if (emailOk || smsOk) {
    await markLaneReadySent(reservation.id);
    console.log(
      `[lane-ready] neonId=${reservation.id} ${reservation.guestName} email=${emailOk} sms=${smsOk}`,
    );
  }

  return { smsOk, emailOk };
}
