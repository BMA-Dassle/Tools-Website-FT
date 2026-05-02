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
const VOX_FROM_FASTTRAX = "+12394819666";
const VOX_FROM_HEADPINZ = "+12393022155";
const VOX_FROM_NAPLES = "+12394553755";

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

/** Create a signed confirmation URL so billId can't be guessed/tampered.
 *  Points at the shared /book/confirmation page. (Older
 *  /book/race/confirmation is still served as a redirect for legacy
 *  links — see app/book/race/confirmation/page.tsx — but new emails
 *  go direct.) */
function signedConfirmationUrl(billId: string): string {
  const sig = createHmac("sha256", HMAC_SECRET).update(billId).digest("hex").slice(0, 16);
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
  return `${base}/book/confirmation?billId=${encodeURIComponent(billId)}&sig=${sig}&referrer=receipt`;
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

/**
 * Send via the centralized voxSend helper — picks up quota detection
 * automatically. If we're in cooldown OR Vox returns a quota error,
 * we enqueue onto the quota queue so the every-minute sweep delivers
 * it as soon as the daily limit resets.
 *
 * Returns true for "delivered or queued for guaranteed delivery" and
 * false only for hard failures (bad phone, missing config).
 */
async function sendSms(to: string, body: string, fromNumber?: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[booking-confirmation] Missing VOX_API_KEY");
    return false;
  }
  const toFormatted = to.length === 10 ? `+1${to}` : `+${to}`;
  const from = fromNumber || VOX_FROM_FASTTRAX;
  const ts = new Date().toISOString();

  // Lazy-load to avoid pulling Redis into the route's import chain
  // until we actually need to send.
  const { voxSend } = await import("@/lib/sms-retry");
  const { logSms } = await import("@/lib/sms-log");
  const result = await voxSend(toFormatted, body, { fromOverride: from });

  if (result.ok) {
    // Log the successful booking-confirm send so the sales admin can
    // count daily SMS volume by source. Other paths (pre-race-cron,
    // checkin-cron, video-match, admin-resend) already log; this was
    // the gap — booking-confirmation was firing untracked.
    await logSms({
      ts,
      phone: toFormatted,
      source: "booking-confirm",
      status: result.status,
      ok: true,
      body,
      provider: result.provider,
      failedOver: result.failedOver,
      providerMessageId: result.voxId || result.twilioSid,
    }).catch(() => void 0);
    return true;
  }

  if (result.skipped || result.quotaHit) {
    const { quotaEnqueue } = await import("@/lib/sms-quota");
    await quotaEnqueue({
      phone: toFormatted,
      body,
      from,
      source: "booking-confirm",
      queuedAt: new Date().toISOString(),
    });
    // Log the queued attempt — quota-queue worker will log the eventual
    // delivery, but tracking the QUEUED state at attempt time means
    // dashboards reflect "we tried to send a confirmation today" even
    // when the actual delivery slips into the next quota window.
    await logSms({
      ts,
      phone: toFormatted,
      source: "booking-confirm",
      status: result.status,
      ok: false,
      error: result.error,
      body,
      provider: result.provider,
    }).catch(() => void 0);
    console.warn("[booking-confirmation] queued SMS for next quota reset:", toFormatted, result.error);
    // Treat as "we'll get it sent eventually" — not a customer-facing
    // failure, since email already delivered.
    return true;
  }

  // Hard failure — bad phone, missing config, etc. Still log it so the
  // dashboard surfaces the failure rate per source.
  await logSms({
    ts,
    phone: toFormatted,
    source: "booking-confirm",
    status: result.status,
    ok: false,
    error: result.error,
    body,
    provider: result.provider,
  }).catch(() => void 0);
  console.error("[booking-confirmation] Voxtelesys error:", result.status, result.error);
  return false;
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
      location,
      expressLane,
      rookiePack,
      packageId,
    } = body;
    const codes: string[] = Array.isArray(povCodes) ? povCodes : [];
    // Rookie Pack hint — adds a one-liner pointing at the
    // confirmation link to find the appetizer code. Code itself
    // never appears in SMS/email so it can't be screenshot-shared.
    const isRookiePack = rookiePack === true;
    // Generic package ID — "rookie-pack", "ultimate-qualifier-mega", etc.
    // Falls back to "rookie-pack" when the legacy rookiePack boolean is set
    // (for callers that haven't been updated to send packageId yet).
    const resolvedPackageId: string | undefined =
      typeof packageId === "string" && packageId
        ? packageId
        : isRookiePack
          ? "rookie-pack"
          : undefined;
    const products: string[] = Array.isArray(productNames) ? productNames : [];
    // scheduledItems is forwarded from the confirmation page. Older
    // callers send `{name, start}` only; newer ones include `persons`
    // and `quantity` so the participantCount math below can use them.
    // Both fields default to undefined-ish so legacy callers still work.
    const scheduled: { name: string; start: string; persons?: number; quantity?: number }[] =
      Array.isArray(scheduledItems) ? scheduledItems : [];
    const isExpressLane = !!expressLane;

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

    // Sales-log capture — every confirmed reservation gets one entry
    // for the /admin/{token}/sales dashboard. Fired once per bill,
    // gated by the same notif-dedup so a refresh of the confirmation
    // page doesn't double-log. Best-effort: errors here never break
    // confirmation send.
    //
    // Bookings shapes vary widely (racing, attractions, race-pack,
    // mixed) so we derive the booking type + flags by scanning the
    // product name list rather than asking the page to telegraph
    // every detail. Names from BMI are stable enough for this.
    try {
      const { logSale } = await import("@/lib/sales-log");
      const allNames = [...products, ...scheduled.map((s) => s.name)];
      const lower = (n: string) => (n || "").toLowerCase();
      const hasRacing = allNames.some((n) => lower(n).includes("race") || lower(n).includes("kart") || /(blue|red|mega).*track/i.test(n));
      const hasRacePack = allNames.some((n) => /race\s*pack|pack/i.test(n));
      const hasAttraction = allNames.some((n) => {
        const x = lower(n);
        return x.includes("gel") || x.includes("laser") || x.includes("shuffly") || x.includes("bowl") || x.includes("duck pin");
      });
      let bookingType: "racing" | "racing-pack" | "attractions" | "mixed" | "other" = "other";
      if (hasRacing && hasAttraction) bookingType = "mixed";
      else if (hasRacePack) bookingType = "racing-pack";
      else if (hasRacing) bookingType = "racing";
      else if (hasAttraction) bookingType = "attractions";

      const raceNames = allNames.filter((n) => {
        const x = lower(n);
        return x.includes("race") || x.includes("kart") || /(blue|red|mega).*track/i.test(n) || /pack/i.test(n);
      });
      const addOnNames = allNames.filter((n) => {
        const x = lower(n);
        return x.includes("gel") || x.includes("laser") || x.includes("shuffly") || x.includes("bowl") || x.includes("duck pin");
      });
      const hasLicense = allNames.some((n) => lower(n).includes("license"));
      const hasPov = allNames.some((n) => /pov/i.test(n)) || codes.length > 0;

      // Participant count — MAX of `persons` (or `quantity` fallback)
      // across distinct karting scheduled lines. Not the COUNT of lines.
      //
      // Why max: a single-racer Ultimate Qualifier creates 2 karting
      // lines (Starter + Intermediate), each with persons=1. Counting
      // lines reported it as 2 racers — inflated every UQ booking.
      // A 4-racer UQ creates 2 lines with persons=4 each; max=4 is the
      // correct racer count. Same shape for race packs (3 lines, same
      // persons) and individual races.
      //
      // Edge case: split-track bookings (2 racers on Red + 2 on Blue at
      // the same time) create 2 lines, persons=2 each → max=2,
      // undercounting the true 4. Rare and the BMI bill's top-level
      // `Persons` field would be the proper signal — not exposed in
      // bill/overview today. Leaving the trade-off for now.
      const kartingScheduled = scheduled.filter((s) => {
        const x = lower(s.name);
        return x.includes("race") || x.includes("kart") || /(blue|red|mega).*track/i.test(s.name);
      });
      const participantCount = (() => {
        if (kartingScheduled.length === 0) {
          return raceNames.length || undefined;
        }
        const counts = kartingScheduled
          .map((s) => Number(s.persons ?? s.quantity ?? 0))
          .filter((n) => n > 0);
        if (counts.length === 0) {
          // Legacy callers didn't forward persons/quantity — fall back to
          // the old line-count behavior so we don't suddenly report 0.
          return kartingScheduled.length || raceNames.length || undefined;
        }
        return Math.max(...counts);
      })();

      await logSale({
        ts: new Date().toISOString(),
        billId,
        reservationNumber,
        brand: brand === "headpinz" ? "headpinz" : "fasttrax",
        location: location === "naples" ? "naples" : "fortmyers",
        bookingType,
        participantCount,
        isNewRacer: !!isNewRacer,
        rookiePack: isRookiePack,
        packageId: resolvedPackageId,
        povPurchased: hasPov,
        povQty: codes.length || (hasPov ? participantCount : 0) || undefined,
        licensePurchased: hasLicense || undefined,
        expressLane: isExpressLane,
        raceProductNames: raceNames.length > 0 ? raceNames : undefined,
        addOnNames: addOnNames.length > 0 ? addOnNames : undefined,
        email,
        phone,
      });
    } catch (err) {
      console.error("[booking-confirmation] sales-log write failed:", err);
    }

    const results: { email: boolean; sms: boolean | null } = { email: false, sms: null };

    // Determine which venue each line item checks in at. Racing
    // lives at FastTrax; gel-blasters / laser tag / shuffleboard
    // (when at HP Fort Myers) live at HeadPinz. Within HeadPinz the
    // `location` param disambiguates Naples vs Fort Myers.
    function getVenue(name: string): "headpinz" | "fasttrax" {
      const n = name.toLowerCase();
      if (n.includes("gel")) return "headpinz";
      if (n.includes("laser")) return "headpinz";
      if (n.includes("shuffly") && n.includes("hpfm")) return "headpinz";
      return "fasttrax";
    }
    const firstItem = scheduled[0]?.name || products[0] || "";
    const allVenues = new Set((scheduled.length > 0 ? scheduled.map((s: { name: string }) => getVenue(s.name)) : products.map(getVenue)));
    const hasBoth = allVenues.has("headpinz") && allVenues.has("fasttrax");
    const firstVenue = getVenue(firstItem);

    // ── Venue address mapping ──────────────────────────────────────
    //
    // Honor `location` (passed by the booking flow) when picking the
    // HP address. Without this, HeadPinz Naples bookings used to fall
    // back to "14513 Global Parkway, Fort Myers" because the route
    // only had a product-name signal.
    const isNaples = location === "naples";
    const HP_ADDRESS = isNaples
      ? "8525 Radio Lane, Naples"
      : "14513 Global Parkway, Fort Myers";
    const HP_VENUE_NAME = isNaples ? "HeadPinz Naples" : "HeadPinz";
    const FT_ADDRESS = "14501 Global Parkway, Fort Myers";

    // Check-in location is based on first scheduled product
    const isHeadPinz = firstVenue === "headpinz";
    const showFastTrax = firstVenue === "fasttrax";
    // Brand drives the email subject + sender name. Trust the
    // explicit `brand` param from the booking page; fall back to the
    // first venue if it wasn't provided. If the booking is at Naples
    // it's always HeadPinz (no FT location there).
    const isHeadPinzBrand = brand === "headpinz" || isNaples || (!brand && isHeadPinz);
    const brandName = isHeadPinzBrand ? "HeadPinz" : "FastTrax";

    // Crude booking-type detection — drives the racing-specific
    // footer in the SMS body. Don't include the racer's-journey
    // link on a HeadPinz Naples gel-blaster confirmation.
    const isRacingBooking = (() => {
      const all = [...products, ...scheduled.map((s: { name: string }) => s.name)];
      return all.some((n) => /race|kart|(blue|red|mega).*track/i.test(String(n)));
    })();

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

      // Build short confirmation URL for email button
      let emailConfirmUrl = "";
      if (billId) {
        try {
          const rawUrl = signedConfirmationUrl(billId);
          emailConfirmUrl = await shortenUrl(rawUrl);
        } catch { /* fall back */ }
      }

      if (isExpressLane) {
        checkInHtml += `
          <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background-color: #ECFDF5; border: 2px solid #10B981; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: bold; color: #059669;">&#9889; EXPRESS CHECK-IN</p>
            <p style="margin: 0 0 8px 0; font-size: 14px; color: #CC0000; line-height: 1.5;">
              <span style="text-decoration: line-through;">&#10060; Guest Services</span> &nbsp;&nbsp; <span style="text-decoration: line-through;">&#10060; Event Check-In</span>
            </p>
            <p style="margin: 0 0 8px 0; font-size: 18px; font-weight: 900; color: #059669; letter-spacing: 0.5px;">
              &#10148; Head straight to Karting!
            </p>
            <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">1st Floor — Arrive 5 minutes before your race time.</p>
            <p style="margin: 0 0 8px 0; font-size: 13px; color: #059669; font-weight: bold;">Have your express pass open and ready on your phone.</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${FT_ADDRESS}</p>
            ${emailConfirmUrl ? `<p style="margin: 14px 0 0 0; text-align: center;"><a href="${emailConfirmUrl}" style="display:inline-block;padding:14px 28px;background-color:#059669;color:#ffffff;text-decoration:none;border-radius:555px;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase;">View Your Express Pass</a></p>` : ""}
          </td></tr></table>
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: #FFF0F0; border: 2px solid #D71C1C; border-radius: 6px; margin-top: 10px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: #D71C1C;">&#9888; Additional Attractions</p>
            <p style="margin: 0; font-size: 13px; color: #333; line-height: 1.5;">
              If you have other attractions booked (gel blasters, laser tag, shuffleboard, etc.), <strong style="color:#D71C1C;">Guest Services check-in is still required</strong> for those activities. Please arrive 30 minutes early.
            </p>
          </td></tr></table>`;
      } else if (isHeadPinz && !showFastTrax) {
        checkInHtml += `
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: #FFF5F5; border: 1px solid #FFCDD2; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: #C62828;">&#127923; Check In at ${HP_VENUE_NAME}</p>
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #333;">Please arrive 30 minutes early. Check in at Guest Services.</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${HP_ADDRESS}</p>
          </td></tr></table>`;
      } else if (showFastTrax && !isHeadPinz) {
        checkInHtml += `
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: #E8F8F8; border: 1px solid #B2DFDB; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: #00838F;">&#127937; Check In at FastTrax</p>
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #333;">Please arrive 30 minutes early. Check in at Guest Services, 2nd Floor.</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${FT_ADDRESS}</p>
          </td></tr></table>`;
      } else if (hasBoth) {
        // Both venues on the same bill (FT racing + HP attractions).
        // This combination is only possible at Fort Myers — Naples
        // doesn't have a FastTrax — so HP_ADDRESS resolves correctly
        // for the FortMyers case here.
        const firstLabel = isHeadPinz ? HP_VENUE_NAME : "FastTrax";
        const firstAddr = isHeadPinz ? HP_ADDRESS : `${FT_ADDRESS} &mdash; Guest Services, 2nd Floor`;
        const secondLabel = isHeadPinz ? "FastTrax" : HP_VENUE_NAME;
        const secondAddr = isHeadPinz ? `${FT_ADDRESS} &mdash; Guest Services, 2nd Floor` : HP_ADDRESS;
        checkInHtml += `
          <p style="font-size: 14px; color: #666; line-height: 1.6; margin: 0 0 14px 0; text-align: center;">
            Your first attraction is at <strong style="color:#1A1A1A;">${firstLabel}</strong>. Please arrive 30 minutes early.
          </p>
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: ${isHeadPinz ? "#FFF5F5; border: 2px solid #FFCDD2" : "#E8F8F8; border: 2px solid #B2DFDB"}; border-radius: 6px; margin-bottom: 10px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 14px; font-weight: bold; color: ${isHeadPinz ? "#C62828" : "#00838F"};">&#10148; Check in here first: ${firstLabel}</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${firstAddr}</p>
          </td></tr></table>
          <table width="100%" cellpadding="14" cellspacing="0" border="0" style="background-color: ${isHeadPinz ? "#E8F8F8; border: 1px solid #B2DFDB" : "#FFF5F5; border: 1px solid #FFCDD2"}; border-radius: 6px;">
          <tr><td style="font-family: Arial, sans-serif;">
            <p style="margin: 0 0 4px 0; font-size: 13px; font-weight: bold; color: ${isHeadPinz ? "#00838F" : "#C62828"};">${secondLabel} (later)</p>
            <p style="margin: 0; font-size: 12px; color: #888;">&#128205; ${secondAddr}</p>
          </td></tr></table>`;
      }
      // Add "View Your Confirmation" button for all emails
      if (emailConfirmUrl && !isExpressLane) {
        checkInHtml += `
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 14px;">
          <tr><td align="center">
            <a href="${emailConfirmUrl}" style="display:inline-block;padding:12px 24px;background-color:#004AAD;color:#ffffff;text-decoration:none;border-radius:555px;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">View Your Confirmation</a>

          </td></tr></table>`;
      }
      checkInHtml += `</td></tr>`;

      html = html.replace(/\^CheckInSection\(\)\$/g, checkInHtml);

      // Legacy placeholder cleanup (no longer used)
      if (false) {
      }

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
        .replace(/\^QrSection\(\)\$/g, qrHtml ? `
<tr>
<td align="center" style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
<table width="100%" cellpadding="16" cellspacing="0" border="0" style="border: 2px solid #004AAD; border-radius: 6px;">
<tr><td align="center" style="font-size: 14px; font-weight: bold; color: #004AAD;">Booking Confirmation QR Code</td></tr>
<tr><td align="center" style="font-size: 13px; color: #666;">Present this at check-in for faster service.</td></tr>
<tr><td align="center">${qrHtml}</td></tr>
</table>
</td>
</tr>` : "")
        .replace(/\^SoldVouchersList\(\)\$/g, codes.length > 0
          ? `<p style="font-weight:bold; color:#1A1A1A; margin:0 0 8px 0;">Your ViewPoint POV Camera Codes:</p>
             ${codes.map((c, i) => `<p style="font-family:monospace; font-size:18px; font-weight:bold; color:#6B21A8; margin:4px 0;">Code ${i + 1}: ${c}</p>`).join("")}
             <p style="color:#D71C1C; font-size:13px; line-height:1.6; margin:12px 0 0 0; font-weight:bold;">
               After your race, be sure to collect your POV camera slip. Without this slip, you will not be able to get your video.
               Scan the QR code on the slip and enter the codes above to redeem your video. Videos take 15-30 minutes to upload.
             </p>`
          : "")
        .replace(/\^ActivityBoxLink\(\)\$/g, "https://smstim.in/headpinzftmyers");

      // Rookie Pack — append a small free-appetizer call-out before
      // </body> when the booking opted in. The actual coupon code
      // lives on the confirmation page only; this email just tells
      // the racer to look there.
      if (isRookiePack) {
        const rookieBlock = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 20px;max-width:600px;">
  <tr><td style="padding:0 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FEF3C7;border:2px solid #F59E0B;border-radius:14px;">
      <tr><td style="padding:18px 22px;font-family:Arial,sans-serif;color:#1F2937;">
        <p style="margin:0 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#92400E;font-weight:bold;">Rookie Pack — Included</p>
        <h3 style="margin:0 0 8px;font-size:20px;color:#111827;">🍴 Your Free Appetizer at Nemo's</h3>
        <p style="margin:0 0 8px;font-size:14px;color:#374151;line-height:1.5;">
          Join us <strong>upstairs at Nemo's</strong> before or after your race. Your coupon
          code is on your confirmation page — open the link above to grab it.
        </p>
        <p style="margin:0;font-size:12px;color:#6B7280;">
          One free appetizer per group (Bruschetta, GF Mac &amp; Cheese Bites, or Fried Zucchini Sticks).
          Dine-in only · <strong style="color:#92400E;">Valid race day only</strong>.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>`;
        html = html.replace("</body>", rookieBlock);
      }

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
    //
    // Single-segment policy: SMS is the alert; the confirmation page
    // carries the schedule, waiver requirement, arrival instructions,
    // POV codes, appetizer code, and everything else. Voxtelesys bills
    // per 153-char (GSM-7) or 67-char (UCS-2) segment; the previous
    // verbose template ran 4–9 segments per send and showed up as ~60k
    // billed segments over a couple weeks. Holding strict 1-segment
    // GSM-7 budget per booking SMS — no emoji, no em-dashes, no
    // bullets, no extra section headers — caps each booking at 1
    // billed message regardless of number of races, returning vs new,
    // express vs not.
    //
    // Trade-offs: customers don't see the schedule, waiver link, or
    // POV codes inline. They tap the confirmation URL and see all of
    // it on the page — including the action-required waiver banner.
    if (smsOptIn && phone) {
      try {
        const normalized = normalizePhone(phone);
        if (normalized.length >= 10) {
          const rawConfirmLink = billId ? signedConfirmationUrl(billId) : "";
          let shortConfirm = rawConfirmLink;
          try {
            if (rawConfirmLink) shortConfirm = await shortenUrl(rawConfirmLink);
          } catch { /* fall back to the full URL */ }

          // Compose date/time as a short ASCII string. `reservationDate`
          // arrives like "Saturday, May 4, 2026" — collapse to "Sat May 4"
          // to keep the SMS in single-segment range. Drop the "20XX"
          // year (rarely useful in-context, eats 6 chars).
          const compactDate = (() => {
            const raw = reservationDate || "";
            // "Saturday, May 4, 2026" → "Sat May 4"
            const m = raw.match(/^(\w+),\s*(\w+)\s+(\d{1,2})/);
            if (m) {
              return `${m[1].slice(0, 3)} ${m[2].slice(0, 3)} ${m[3]}`;
            }
            return raw;
          })();
          const dateTime = [compactDate, reservationTime].filter(Boolean).join(", ");

          // ASCII-only label for the link CTA — em-dashes / curly quotes
          // would force UCS-2 encoding, halving the per-segment budget.
          // Mention POV codes when this booking includes them so racers
          // know where to find the redemption codes (we no longer send
          // codes as separate SMS — they live on the confirmation page).
          const hasPovCodes = codes.length > 0;
          const cta = isExpressLane
            ? hasPovCodes
              ? "Pass, check-in + POV codes"
              : "View pass + check-in"
            : hasPovCodes
              ? "View, waiver + POV codes"
              : "View + waiver";

          // Express-lane racers get the brand suffixed with "Express Lane"
          // so the prefix line is unmistakable at a glance — staff and
          // racers asked for this so the SMS preview tells them they
          // bypass Guest Services without needing to open the link.
          const brandPrefix = isExpressLane
            ? `${brandName} Express Lane`
            : brandName;
          const smsBody = shortConfirm
            ? `${brandPrefix}: Booking #${reservationNumber} for ${dateTime}. ${cta}: ${shortConfirm}`
            : `${brandPrefix}: Booking #${reservationNumber} for ${dateTime}.`;

          const smsFrom = location === "naples" ? VOX_FROM_NAPLES : isHeadPinzBrand ? VOX_FROM_HEADPINZ : VOX_FROM_FASTTRAX;
          results.sms = await sendSms(normalized, smsBody, smsFrom);

          // POV codes are now displayed on the confirmation page only —
          // no separate per-code SMS. Cuts N+1 outbound messages per
          // booking (where N = video count, typically 1-4) down to 1.
          // The CTA above tells racers to tap the URL for the codes.
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
