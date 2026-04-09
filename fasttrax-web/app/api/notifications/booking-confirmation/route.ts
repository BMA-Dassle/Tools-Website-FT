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

async function sendEmail(to: string, subject: string, html: string, fromName?: string): Promise<boolean> {
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
      personalizations: [{ to: [{ email: to }], bcc: [{ email: "vendorcases@dassle.us" }] }],
      from: { email: FROM_EMAIL, name: fromName || FROM_NAME },
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
      isNewRacer,
      povCodes,
      productNames,
      scheduledItems,
      brand,
    } = body;
    const codes: string[] = Array.isArray(povCodes) ? povCodes : [];
    const products: string[] = Array.isArray(productNames) ? productNames : [];
    const scheduled: { name: string; start: string }[] = Array.isArray(scheduledItems) ? scheduledItems : [];

    if (!email || !reservationNumber) {
      return NextResponse.json({ error: "email and reservationNumber required" }, { status: 400 });
    }

    // Dedup: check if confirmation was already sent for this bill
    const notifKey = `notif:${billId || reservationNumber}`;
    const alreadySent = await redis.get(notifKey);
    if (alreadySent) {
      console.log("[booking-confirmation] already sent for", billId || reservationNumber);
      return NextResponse.json({ success: true, duplicate: true });
    }

    const results: { email: boolean; sms: boolean | null } = { email: false, sms: null };

    // Determine check-in location from FIRST scheduled item
    function getLocation(name: string): "headpinz" | "fasttrax" {
      const n = name.toLowerCase();
      if (n.includes("gel")) return "headpinz";
      if (n.includes("laser")) return "headpinz";
      if (n.includes("shuffly") && n.includes("hpfm")) return "headpinz";
      return "fasttrax";
    }
    const firstItem = scheduled[0]?.name || products[0] || "";
    const firstLocation = getLocation(firstItem);
    const allLocations = new Set((scheduled.length > 0 ? scheduled.map((s: { name: string }) => getLocation(s.name)) : products.map(getLocation)));
    const hasBoth = allLocations.has("headpinz") && allLocations.has("fasttrax");
    // Check-in location is based on first scheduled product
    const isHeadPinz = firstLocation === "headpinz";
    const showFastTrax = firstLocation === "fasttrax";
    // Brand is based on which website they booked from
    const isHeadPinzBrand = brand === "headpinz" || (!brand && isHeadPinz);
    const brandName = isHeadPinzBrand ? "HeadPinz" : "FastTrax";

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

      let checkInHtml = `<tr><td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
        <p class="section-label" style="margin: 0 0 14px 0; text-align: center;">Where to Check In</p>`;

      if (isHeadPinz && !showFastTrax) {
        checkInHtml += `
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: #FFF5F5; border: 1px solid #FFCDD2; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: #C62828;">&#127923; Check In at HeadPinz</p>
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #333;">Please arrive 30 minutes early. Check in at Guest Services.</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; 14513 Global Parkway, Fort Myers</p>
          </td></tr></table>`;
      } else if (showFastTrax && !isHeadPinz) {
        checkInHtml += `
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: #E8F8F8; border: 1px solid #B2DFDB; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: #00838F;">&#127937; Check In at FastTrax</p>
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #333;">Please arrive 30 minutes early. Check in at Guest Services, 2nd Floor.</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; 14501 Global Parkway, Fort Myers</p>
          </td></tr></table>`;
      } else if (hasBoth) {
        // Both locations — highlight which is first
        const firstLabel = isHeadPinz ? "HeadPinz" : "FastTrax";
        checkInHtml += `
          <p style="font-size: 14px; color: #666; line-height: 1.6; margin: 0 0 14px 0; text-align: center;">
            Your first attraction is at <strong style="color:#1A1A1A;">${firstLabel}</strong>. Please arrive 30 minutes early.
          </p>
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: ${isHeadPinz ? "#FFF5F5; border: 2px solid #FFCDD2" : "#E8F8F8; border: 2px solid #B2DFDB"}; border-radius: 6px; margin-bottom: 10px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: ${isHeadPinz ? "#C62828" : "#00838F"};">&#10148; Check in here first: ${isHeadPinz ? "HeadPinz" : "FastTrax"}</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${isHeadPinz ? "14513 Global Parkway, Fort Myers" : "14501 Global Parkway, Fort Myers &mdash; Guest Services, 2nd Floor"}</p>
          </td></tr></table>
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: ${isHeadPinz ? "#E8F8F8; border: 1px solid #B2DFDB" : "#FFF5F5; border: 1px solid #FFCDD2"}; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 13px; font-weight: bold; color: ${isHeadPinz ? "#00838F" : "#C62828"};">${isHeadPinz ? "FastTrax" : "HeadPinz"} (later)</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${isHeadPinz ? "14501 Global Parkway, Fort Myers &mdash; Guest Services, 2nd Floor" : "14513 Global Parkway, Fort Myers"}</p>
          </td></tr></table>`;
      }
      checkInHtml += `</td></tr>`;

      html = html.replace(/\^CheckInSection\(\)\$/g, checkInHtml);

      // Waiver section — only for new racers
      const waiverLink = isNewRacer ? (waiverUrl || "https://kiosk.sms-timing.com/headpinzftmyers/subscribe") : "";
      const waiverSectionHtml = isNewRacer ? `
<tr>
<td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
<table width="100%" cellpadding="16" cellspacing="0" border="0"
       style="background-color:#FFF0F0; border: 2px solid #D71C1C; border-radius: 6px;">
<tr><td align="center" style="font-size: 17px; font-weight: bold; color: #D71C1C;">WAIVERS REQUIRED</td></tr>
<tr><td align="center" style="font-size: 14px; color: #333; line-height: 1.6;">
  Every guest must complete a waiver <strong>before arrival</strong>.
  Missing waivers are the <strong>#1 cause of delays</strong>.
</td></tr>
<tr><td align="center"><a href="${waiverLink}" class="cta-btn red">Complete Waiver Now</a></td></tr>
<tr><td align="center" style="font-size: 11px; color: #999; word-break: break-all;">${waiverLink}</td></tr>
</table>
</td>
</tr>` : "";

      // Function-style ^PlaceholderName()$ replacements
      html = html
        .replace(/\^WaiverSection\(\)\$/g, waiverSectionHtml)
        .replace(/\^ReservationLink\(\)\$/g, waiverLink || "#")
        .replace(/\^BookingConfirmationQr\(\)\$/g, qrHtml)
        .replace(/\^SoldVouchersList\(\)\$/g, codes.length > 0
          ? `<p style="font-weight:bold; color:#1A1A1A; margin:0 0 8px 0;">Your ViewPoint POV Camera Codes:</p>
             ${codes.map((c, i) => `<p style="font-family:monospace; font-size:18px; font-weight:bold; color:#6B21A8; margin:4px 0;">Code ${i + 1}: ${c}</p>`).join("")}
             <p style="color:#D71C1C; font-size:13px; line-height:1.6; margin:12px 0 0 0; font-weight:bold;">
               After your race, be sure to collect your POV camera slip. Without this slip, you will not be able to get your video.
               Scan the QR code on the slip and enter the codes above to redeem your video. Videos take 15-30 minutes to upload.
             </p>`
          : "")
        .replace(/\^ActivityBoxLink\(\)\$/g, "https://smstim.in/headpinzftmyers");

      // Waiver section already handled by ^WaiverSection()$ placeholder

      results.email = await sendEmail(
        email,
        `${brandName} Booking Confirmed — #${reservationNumber}`,
        html,
        isHeadPinzBrand ? "HeadPinz Entertainment" : undefined,
      );
    } catch (err) {
      console.error("[booking-confirmation] email failed:", err);
    }

    // ── Send SMS (if opted in) ──────────────────────────────────────────
    if (smsOptIn && phone) {
      try {
        const normalized = normalizePhone(phone);
        if (normalized.length >= 10) {
          const rawConfirmLink = billId ? signedConfirmationUrl(billId) : "";

          // Shorten long URLs for SMS
          let shortWaiver = "";
          let shortConfirm = rawConfirmLink;
          try {
            if (isNewRacer) {
              const rawWaiverLink = waiverUrl || "https://kiosk.sms-timing.com/headpinzftmyers/subscribe";
              shortWaiver = await shortenUrl(rawWaiverLink);
            }
            if (rawConfirmLink) shortConfirm = await shortenUrl(rawConfirmLink);
          } catch { /* fall back to full URLs */ }

          const schedule = reservationSchedule ? reservationSchedule.replace(/<br\/?>/g, "\n") : "";
          const confirmSection = shortConfirm ? `\nView your confirmation:\n${shortConfirm}` : "";
          const waiverSection = shortWaiver ? `\nComplete your waiver:\n${shortWaiver}` : "";
          const smsBody = `${brandName} Booking Confirmed

Reservation: #${reservationNumber}
${schedule}

${reservationDate || ""}
${reservationTime || ""}

${showFastTrax && !hasBoth ? "Arrive 30 minutes early to check in at FastTrax.\nGuest Services, 2nd Floor\n14501 Global Parkway, Fort Myers" : ""}${isHeadPinz && !hasBoth ? "Arrive 30 minutes early to check in at HeadPinz.\nGuest Services\n14513 Global Parkway, Fort Myers" : ""}${hasBoth ? `Arrive 30 minutes early. Check in first at ${isHeadPinz ? "HeadPinz\n14513 Global Parkway, Fort Myers" : "FastTrax — Guest Services, 2nd Floor\n14501 Global Parkway, Fort Myers"}.` : ""}
${waiverSection}
${confirmSection}

Important information about your race check-in:
https://fasttraxent.com/racing#racers-journey`;

          const povFooter = codes.length > 0
            ? `\n\n\nYour POV Camera Codes — collect your camera slip after your race to redeem. Videos take 15-30 min to upload. POV Codes below:`
            : "";

          results.sms = await sendSms(normalized, smsBody + povFooter);

          // Send each POV code as a separate SMS for easy copy/paste
          // Delay to ensure confirmation SMS arrives first
          if (codes.length > 0) {
            await new Promise(r => setTimeout(r, 5000));
            for (const code of codes) {
              await sendSms(normalized, code);
            }
          }
        }
      } catch (err) {
        console.error("[booking-confirmation] sms failed:", err);
        results.sms = false;
      }
    }

    // Log notification to Redis (90-day TTL)
    try {
      const log = {
        type: "booking-confirmation",
        billId: billId || null,
        reservationNumber,
        email,
        phone: smsOptIn ? phone : null,
        emailSent: results.email,
        smsSent: results.sms,
        povCodes: codes.length > 0 ? codes : null,
        isNewRacer: !!isNewRacer,
        sentAt: new Date().toISOString(),
      };
      await redis.set(notifKey, JSON.stringify(log), "EX", 90 * 24 * 60 * 60);
      // Also append to per-bill notification history
      if (billId) {
        await redis.rpush(`notif:history:${billId}`, JSON.stringify(log));
        await redis.expire(`notif:history:${billId}`, 90 * 24 * 60 * 60);
      }
    } catch { /* non-fatal */ }

    return NextResponse.json({ success: true, ...results });
  } catch (err) {
    console.error("[booking-confirmation] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Notification failed" },
      { status: 500 },
    );
  }
}
