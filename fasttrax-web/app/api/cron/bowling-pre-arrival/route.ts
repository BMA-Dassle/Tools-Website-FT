import { NextRequest, NextResponse } from "next/server";
import {
  getReservationsNeedingPreArrival,
  markPreArrivalSent,
} from "@/lib/bowling-db";

/**
 * GET /api/cron/bowling-pre-arrival
 *
 * Runs every 2 minutes. Finds confirmed bowling reservations whose
 * booked_at is 28–32 minutes from now (ET) and sends a pre-arrival
 * SMS + email prompting guests to enter names, shoe sizes, and bumpers.
 *
 * Idempotent: pre_arrival_sent_at column prevents double-sends.
 */

// ── Config ──────────────────────────────────────────────────────────

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const VOX_API_KEY = process.env.VOX_API_KEY || "";

const CENTER_META: Record<
  string,
  { name: string; smsFrom: string }
> = {
  TXBSQN0FEKQ11: { name: "HeadPinz Fort Myers", smsFrom: "+12393022155" },
  PPTR5G2N0QXF7: { name: "HeadPinz Naples", smsFrom: "+12394553755" },
};

// ── Helpers ─────────────────────────────────────────────────────────

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
    source: "bowling-pre-arrival",
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
      source: "bowling-pre-arrival",
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
  confirmLink: string,
): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;padding:24px;">
<tr><td style="text-align:center;padding-bottom:20px;">
  <img src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/headpinz-logo-white-CgWYpNqb4lmSJrfHdvXQPMa1WNUjqU.png" alt="HeadPinz" width="160" style="display:inline-block;">
</td></tr>
<tr><td style="background:#141414;border-radius:12px;padding:28px 24px;border:1px solid rgba(255,255,255,0.06);">
  <h1 style="margin:0 0 8px;font-size:20px;color:#ffffff;text-align:center;">Your HeadPinz Experience<br>Is Almost Here! 🎳</h1>
  <p style="margin:0 0 20px;color:rgba(255,255,255,0.55);font-size:14px;text-align:center;line-height:1.5;">
    Hey ${guestName}! Your bowling at <strong style="color:#ffffff;">${centerName}</strong> is coming up at <strong style="color:#00E2E5;">${time}</strong>.
  </p>
  <p style="margin:0 0 20px;color:rgba(255,255,255,0.55);font-size:14px;text-align:center;line-height:1.5;">
    Let's get a few things done before you arrive — enter your names, shoe sizes, and let us know if you need bumpers.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <a href="${confirmLink}" style="display:inline-block;padding:14px 32px;background:#004AAD;color:#ffffff;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:0.5px;">Get Ready for Your Visit</a>
  </td></tr></table>
</td></tr>
<tr><td style="text-align:center;padding-top:16px;">
  <p style="margin:0;color:rgba(255,255,255,0.2);font-size:11px;">HeadPinz Entertainment — Part of FastTrax Entertainment</p>
</td></tr>
</table>
</body></html>`;
}

// ── Handler ─────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const invoker = req.headers.get("x-vercel-cron") ? "vercel-cron" : "manual";

  // Window: reservations 28–32 minutes from now
  const now = Date.now();
  const windowStart = new Date(now + 28 * 60_000);
  const windowEnd = new Date(now + 32 * 60_000);

  const reservations = await getReservationsNeedingPreArrival(windowStart, windowEnd);
  console.log(
    `[pre-arrival] invoker=${invoker} window=${windowStart.toISOString()}..${windowEnd.toISOString()} found=${reservations.length}`,
  );

  if (reservations.length === 0) {
    return NextResponse.json({ ok: true, invoker, sent: 0 });
  }

  const results: Array<{ id: number; guest: string; email: boolean; sms: boolean }> = [];

  for (const r of reservations) {
    if (dryRun) {
      results.push({ id: r.id, guest: r.guestName ?? "?", email: false, sms: false });
      continue;
    }

    const center = CENTER_META[r.centerCode] ?? CENTER_META.TXBSQN0FEKQ11;
    const time = formatTime(r.bookedAt);
    const siteUrl = "https://headpinz.com";
    // Always use the full URL for pre-arrival so the &names=1 param
    // survives (short URL server-side redirect would strip query params).
    const confirmLink = `${siteUrl}/hp/book/bowling/confirmation?neonId=${r.id}&names=1`;
    const guestFirst = (r.guestName ?? "").split(" ")[0] || "there";

    let emailOk = false;
    let smsOk = false;

    // Send email
    if (r.guestEmail) {
      try {
        const html = buildEmailHtml(guestFirst, time, center.name, confirmLink);
        emailOk = await sendEmail(
          r.guestEmail,
          `Your HeadPinz Experience Is Almost Here! 🎳`,
          html,
        );
      } catch (err) {
        console.warn(`[pre-arrival] email failed for neonId=${r.id}:`, err);
      }
    }

    // Send SMS
    if (r.guestPhone) {
      try {
        const normalized = normalizePhone(r.guestPhone);
        if (normalized.length >= 10) {
          const smsBody = `HeadPinz: Your bowling at ${time} is almost here! Get ready — enter names & shoe sizes before you arrive: ${confirmLink}`;
          smsOk = await sendSms(normalized, smsBody, center.smsFrom);
        }
      } catch (err) {
        console.warn(`[pre-arrival] sms failed for neonId=${r.id}:`, err);
      }
    }

    // Mark sent (even if one channel failed — don't re-send both)
    if (emailOk || smsOk) {
      await markPreArrivalSent(r.id);
    }

    results.push({ id: r.id, guest: r.guestName ?? "?", email: emailOk, sms: smsOk });
    console.log(`[pre-arrival] neonId=${r.id} ${r.guestName} email=${emailOk} sms=${smsOk}`);
  }

  return NextResponse.json({
    ok: true,
    invoker,
    dryRun,
    sent: results.filter((r) => r.email || r.sms).length,
    results,
  });
}
