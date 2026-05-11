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

const CENTER_META: Record<string, { name: string; smsFrom: string }> = {
  TXBSQN0FEKQ11: { name: "HeadPinz Fort Myers", smsFrom: "+12393022155" },
  PPTR5G2N0QXF7: { name: "HeadPinz Naples", smsFrom: "+12394553755" },
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
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;padding:24px;">
<tr><td style="text-align:center;padding-bottom:20px;">
  <img src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/headpinz-logo-white-CgWYpNqb4lmSJrfHdvXQPMa1WNUjqU.png" alt="HeadPinz" width="160" style="display:inline-block;">
</td></tr>
<tr><td style="background:#141414;border-radius:12px;padding:28px 24px;border:1px solid rgba(255,255,255,0.06);">
  <h1 style="margin:0 0 8px;font-size:22px;color:#ffffff;text-align:center;">Your Lane is Ready!</h1>
  <p style="margin:0 0 20px;color:rgba(255,255,255,0.55);font-size:14px;text-align:center;line-height:1.5;">
    Hey ${guestName}! ${laneLabel ? `<strong style="color:#4ade80;">${laneLabel}</strong> at ` : "Your lane at "}<strong style="color:#ffffff;">${centerName}</strong> is set up and waiting for you.
  </p>
  <p style="margin:0 0 20px;color:rgba(255,255,255,0.55);font-size:14px;text-align:center;line-height:1.5;">
    Check in from your phone to skip the line, or head to Guest Services when you arrive.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <a href="${checkinLink}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#ffffff;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:0.5px;">Check In Now</a>
  </td></tr></table>
</td></tr>
<tr><td style="text-align:center;padding-top:16px;">
  <p style="margin:0;color:rgba(255,255,255,0.2);font-size:11px;">HeadPinz Entertainment — Part of FastTrax Entertainment</p>
</td></tr>
</table>
</body></html>`;
}

// ── Public API ──────────────────────────────────────────────────────

export async function sendLaneReadyNotification(
  reservation: BowlingReservation,
  laneLabel?: string,
): Promise<{ smsOk: boolean; emailOk: boolean }> {
  const center = CENTER_META[reservation.centerCode] ?? CENTER_META.TXBSQN0FEKQ11;
  const time = formatTime(reservation.bookedAt);
  const guestFirst = (reservation.guestName ?? "").split(" ")[0] || "there";
  const rawPath = `/hp/book/bowling/checkin?neonId=${reservation.id}`;
  const shortCode = await shortenUrl(rawPath);
  const checkinLink = `${SITE_URL}/s/${shortCode}`;
  const lanePart = laneLabel ? ` ${laneLabel} is ready!` : " Your lane is ready!";

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
        const smsBody = `HeadPinz:${lanePart} Check in now: ${checkinLink}`;
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
