import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { createHmac, randomBytes } from "crypto";
import QRCode from "qrcode";
import redis from "@/lib/redis";

// ── Config ──────────────────────────────────────────────────────────────────

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FROM_NAME = process.env.SENDGRID_FROM_NAME || "FastTrax Entertainment";

const VOX_API_KEY = process.env.VOX_API_KEY || "";
const VOX_FROM = process.env.VOX_FROM_NUMBER || "+12394819666";

// ── Email template (loaded once at startup) ─────────────────────────────────

let emailTemplate: string | null = null;

function getEmailTemplate(): string {
  if (!emailTemplate) {
    const templatePath = join(process.cwd(), "emails", "booking-confirmation-waiver.html");
    emailTemplate = readFileSync(templatePath, "utf-8");
  }
  return emailTemplate;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

const HMAC_SECRET = process.env.BOOKING_HMAC_SECRET || process.env.SENDGRID_API_KEY || "fasttrax-booking-secret";

/** Create a signed confirmation URL so billId can't be guessed/tampered */
function signedConfirmationUrl(billId: string): string {
  const sig = createHmac("sha256", HMAC_SECRET).update(billId).digest("hex").slice(0, 16);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
  return `${base}/book/race/confirmation?billId=${encodeURIComponent(billId)}&sig=${sig}`;
}

/** Verify a signed billId (for the confirmation page to validate) */
export function verifyBillSignature(billId: string, sig: string): boolean {
  const expected = createHmac("sha256", HMAC_SECRET).update(billId).digest("hex").slice(0, 16);
  return sig === expected;
}

const SHORT_TTL = 90 * 24 * 60 * 60; // 90 days

/** Create a short URL via Redis and return the short link */
async function shortenUrl(url: string): Promise<string> {
  const code = randomBytes(4).toString("base64url").slice(0, 6);
  await redis.set(`short:${code}`, url, "EX", SHORT_TTL);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
  return `${base}/s/${code}`;
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.error("[booking-confirmation] No SENDGRID_API_KEY");
    return false;
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("[booking-confirmation] SendGrid error:", res.status, err);
    return false;
  }
  return true;
}

async function sendSms(to: string, body: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[booking-confirmation] Missing VOX_API_KEY");
    return false;
  }
  const toFormatted = to.length === 10 ? `+1${to}` : `+${to}`;

  const res = await fetch("https://smsapi.voxtelesys.net/api/v2/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${VOX_API_KEY}`,
    },
    body: JSON.stringify({
      to: toFormatted,
      from: VOX_FROM,
      body,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("[booking-confirmation] Voxtelesys error:", res.status, err);
    return false;
  }
  return true;
}

// ── POST handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      email,
      phone,
      firstName,
      smsOptIn,
      reservationNumber,
      reservationName,
      reservationDate,
      reservationTime,
      reservationSchedule,
      waiverUrl,
      reservationCode,
      billId,
    } = body;

    if (!email || !reservationNumber) {
      return NextResponse.json({ error: "email and reservationNumber required" }, { status: 400 });
    }

    const results: { email: boolean; sms: boolean | null } = { email: false, sms: null };

    // ── Send email ────────────────────────────────────────────────────────
    try {
      let html = getEmailTemplate();

      // Simple ^[Placeholder]$ replacements
      html = html
        .replace(/\^\[ReservationName\]\$/g, reservationName || firstName || "Racer")
        .replace(/\^\[ReservationNumber\]\$/g, reservationNumber)
        .replace(/\^\[ReservationDate\]\$/g, reservationDate || "")
        .replace(/\^\[ReservationTime\]\$/g, reservationTime || "")
        .replace(/\^\[ReservationSchedule\]\$/g, reservationSchedule || "");

      // Generate QR code from reservation code
      let qrHtml = "";
      if (reservationCode) {
        try {
          const qrDataUrl = await QRCode.toDataURL(String(reservationCode), { width: 160, margin: 1, color: { dark: "#000000", light: "#ffffff" } });
          qrHtml = `<img src="${qrDataUrl}" width="140" height="140" alt="QR Code" style="display:block;margin:0 auto;" />`;
        } catch { /* skip QR if generation fails */ }
      }

      // Function-style ^PlaceholderName()$ replacements
      const waiverLink = waiverUrl || "https://kiosk.sms-timing.com/headpinzftmyers/subscribe";
      html = html
        .replace(/\^ReservationLink\(\)\$/g, waiverLink)
        .replace(/\^BookingConfirmationQr\(\)\$/g, qrHtml)
        .replace(/\^SoldVouchersList\(\)\$/g, "")
        .replace(/\^ActivityBoxLink\(\)\$/g, "https://smstim.in/headpinzftmyers");

      results.email = await sendEmail(
        email,
        `Booking Confirmed — #${reservationNumber}`,
        html,
      );
    } catch (err) {
      console.error("[booking-confirmation] email failed:", err);
    }

    // ── Send SMS (if opted in) ──────────────────────────────────────────
    if (smsOptIn && phone) {
      try {
        const normalized = normalizePhone(phone);
        if (normalized.length >= 10) {
          const rawWaiverLink = waiverUrl || "https://kiosk.sms-timing.com/headpinzftmyers/subscribe";
          const rawConfirmLink = billId ? signedConfirmationUrl(billId) : "";

          // Shorten long URLs for SMS
          let shortWaiver = rawWaiverLink;
          let shortConfirm = rawConfirmLink;
          try {
            shortWaiver = await shortenUrl(rawWaiverLink);
            if (rawConfirmLink) shortConfirm = await shortenUrl(rawConfirmLink);
          } catch { /* fall back to full URLs */ }

          const schedule = reservationSchedule ? reservationSchedule.replace(/<br\/?>/g, "\n") : "";
          const confirmSection = shortConfirm ? `\nView your confirmation:\n${shortConfirm}` : "";

          const smsBody = `FastTrax Booking Confirmed

Reservation: #${reservationNumber}
${schedule}

${reservationDate || ""}
${reservationTime || ""}

Arrive 30 minutes early to check in at Guest Services.

Complete your waiver:
${shortWaiver}
${confirmSection}

Important information about your race check-in:
https://fasttraxent.com/racing#racers-journey`;

          results.sms = await sendSms(normalized, smsBody);
        }
      } catch (err) {
        console.error("[booking-confirmation] sms failed:", err);
        results.sms = false;
      }
    }

    return NextResponse.json({ success: true, ...results });
  } catch (err) {
    console.error("[booking-confirmation] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Notification failed" },
      { status: 500 },
    );
  }
}
