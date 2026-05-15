import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import redis from "@/lib/redis";
import { getBowlingReservation, type BowlingReservation } from "@/lib/bowling-db";

// ── Config ──────────────────────────────────────────────────────────────────

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";

const VOX_API_KEY = process.env.VOX_API_KEY || "";
const VOX_FROM_HEADPINZ = "+12393022155";
const VOX_FROM_NAPLES = "+12394553755";

// ── Center metadata ─────────────────────────────────────────────────────────

const CENTER_META: Record<
  string,
  { name: string; address: string; phone: string; smsFrom: string; location: string }
> = {
  TXBSQN0FEKQ11: {
    name: "HeadPinz Fort Myers",
    address: "14513 Global Parkway, Fort Myers, FL 33913",
    phone: "(239) 302-2155",
    smsFrom: VOX_FROM_HEADPINZ,
    location: "fortmyers",
  },
  PPTR5G2N0QXF7: {
    name: "HeadPinz Naples",
    address: "8525 Radio Lane, Naples, FL 34104",
    phone: "(239) 455-3755",
    smsFrom: VOX_FROM_NAPLES,
    location: "naples",
  },
};

// ── Email template (loaded once at startup) ─────────────────────────────────

let emailTemplate: string | null = null;

function getEmailTemplate(): string {
  if (!emailTemplate) {
    const templatePath = join(process.cwd(), "emails", "bowling-confirmation.html");
    emailTemplate = readFileSync(templatePath, "utf-8");
  }
  return emailTemplate;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): { dateFull: string; timeFull: string; dateCompact: string } {
  const d = new Date(iso);
  const dateFull = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
  const timeFull = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  // Compact for SMS: "Sat May 4, 2:00 PM"
  const dateCompact = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
  return { dateFull, timeFull, dateCompact };
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!SENDGRID_API_KEY) {
    console.error("[bowling-confirmation] No SENDGRID_API_KEY");
    return false;
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }], bcc: [{ email: "vendorcases@dassle.us" }] }],
      from: { email: FROM_EMAIL, name: "HeadPinz Entertainment" },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("[bowling-confirmation] SendGrid error:", res.status, err);
    return false;
  }
  return true;
}

async function sendSms(to: string, body: string, fromNumber: string): Promise<boolean> {
  if (!VOX_API_KEY) {
    console.error("[bowling-confirmation] Missing VOX_API_KEY");
    return false;
  }
  const toFormatted = to.length === 10 ? `+1${to}` : `+${to}`;
  const from = fromNumber;
  const ts = new Date().toISOString();

  const { voxSend } = await import("@/lib/sms-retry");
  const { logSms } = await import("@/lib/sms-log");
  const result = await voxSend(toFormatted, body, { fromOverride: from });

  if (result.ok) {
    await logSms({
      ts,
      phone: toFormatted,
      source: "bowling-confirm",
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
      source: "bowling-confirm",
      queuedAt: new Date().toISOString(),
    });
    await logSms({
      ts,
      phone: toFormatted,
      source: "bowling-confirm",
      status: result.status,
      ok: false,
      error: result.error,
      body,
      provider: result.provider,
    }).catch(() => void 0);
    console.warn(
      "[bowling-confirmation] queued SMS for next quota reset:",
      toFormatted,
      result.error,
    );
    return true; // will be delivered eventually
  }

  await logSms({
    ts,
    phone: toFormatted,
    source: "bowling-confirm",
    status: result.status,
    ok: false,
    error: result.error,
    body,
    provider: result.provider,
  }).catch(() => void 0);
  console.error("[bowling-confirmation] Vox error:", result.status, result.error);
  return false;
}

// ── POST handler ────────────────────────────────────────────────────────────

/**
 * POST /api/notifications/bowling-confirmation
 *
 * Sends bowling confirmation email + optional SMS.
 * Called by the bowling wizard after a successful reservation.
 *
 * Body: { neonId: number; smsOptIn?: boolean; channel?: "email" | "sms" | "both"; forceResend?: boolean;
 *         overridePhone?: string; overrideEmail?: string }
 *
 * Everything is derived from the Neon reservation row — no need for the
 * caller to duplicate reservation data in the request body.
 *
 * `forceResend` skips dedup (for admin resends).
 * `channel` defaults to "both" — sends email + SMS (if smsOptIn).
 * For admin resends, set channel explicitly and smsOptIn=true.
 * `overridePhone` / `overrideEmail` let admins send to a different contact.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      neonId,
      smsOptIn,
      channel = "both",
      forceResend = false,
      overridePhone,
      overrideEmail,
    } = body as {
      neonId: number;
      smsOptIn?: boolean;
      channel?: "email" | "sms" | "both";
      forceResend?: boolean;
      overridePhone?: string;
      overrideEmail?: string;
    };

    if (!neonId) {
      return NextResponse.json({ error: "neonId required" }, { status: 400 });
    }

    // ── Dedup (skipped for admin resends) ────────────────────────
    const notifKey = `notif:bowling:${neonId}`;
    if (!forceResend) {
      const alreadySent = await redis.get(notifKey);
      if (alreadySent) {
        return NextResponse.json({ success: true, duplicate: true });
      }
    }

    // ── Load reservation from Neon ─────────────────────────────────
    const reservation = await getBowlingReservation(neonId);
    if (!reservation) {
      return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    }

    const r = reservation as BowlingReservation & {
      lines: { label: string; quantity: number; unitPriceCents: number }[];
    };
    const center = CENTER_META[r.centerCode] ?? CENTER_META.TXBSQN0FEKQ11;
    const { dateFull, timeFull, dateCompact } = formatDate(r.bookedAt);

    const results: { email: boolean; sms: boolean | null } = {
      email: false,
      sms: null,
    };

    // ── Experience label ───────────────────────────────────────────
    // Derive from the first line item or product kind
    const experienceLabel = (() => {
      if (r.productKind === "kbf") return "Kids Bowl Free";
      // Use the first non-shoe line item's label if available
      const mainLine = r.lines?.find((l) => !/shoe/i.test(l.label));
      return mainLine?.label ?? "Open Bowling";
    })();

    // ── Build confirmation link ────────────────────────────────────
    // Bowling is HeadPinz-only. The short URL stores a /hp/book/bowling/…
    // path, which only resolves correctly on the headpinz.com domain.
    // Using fasttraxent.com here caused a redirect loop that dropped the
    // /hp prefix and landed on the wrong (FastTrax attractions)
    // confirmation page — stuck on "Confirming your booking…" forever.
    const siteUrl = "https://headpinz.com";
    const confirmLink = r.shortCode ? `${siteUrl}/s/${r.shortCode}` : undefined;

    // ── Resolve contacts (override or reservation) ──────────────
    const emailTo = overrideEmail || r.guestEmail;
    const phoneTo = overridePhone || r.guestPhone;
    const sendEmail_ = (channel === "email" || channel === "both") && !!emailTo;
    const sendSms_ = (channel === "sms" || channel === "both") && smsOptIn !== false && !!phoneTo;

    // ── Send email ─────────────────────────────────────────────────
    if (sendEmail_ && emailTo) {
      try {
        let html = getEmailTemplate();

        // Headline / subtitle
        const isKbf = r.productKind === "kbf";
        const headline = isKbf ? "You're Bowling Free!" : "Your Lane Is Reserved!";
        const subtitle = isKbf
          ? `Thank you for booking Kids Bowl Free at ${center.name}! Your lane is reserved — show this confirmation when you arrive.`
          : `Thank you for booking at ${center.name}! Your deposit has been charged and your lane is reserved.`;

        html = html
          .replace(/\^\[Headline\]\$/g, headline)
          .replace(/\^\[Subtitle\]\$/g, subtitle)
          .replace(/\^\[ExperienceLabel\]\$/g, experienceLabel)
          .replace(/\^\[BookingRef\]\$/g, r.qamfReservationId ?? `HP-${r.id}`)
          .replace(/\^\[CenterName\]\$/g, center.name)
          .replace(/\^\[CenterAddress\]\$/g, center.address)
          .replace(/\^\[CenterPhone\]\$/g, center.phone)
          .replace(/\^\[BookingDate\]\$/g, dateFull)
          .replace(/\^\[BookingTime\]\$/g, timeFull)
          .replace(/\^\[PlayerCount\]\$/g, String(r.playerCount ?? 1));

        // Payment section — only show if there's a deposit
        if (r.depositCents > 0) {
          const remaining = r.totalCents - r.depositCents;
          let paymentHtml = `<tr>
  <td style="border-top: 1px solid #EEEEEE; padding: 12px 16px; font-family: Arial, sans-serif;">
    <p style="margin: 0 0 4px 0; font-size: 12px; font-weight: bold; color: #004AAD; text-transform: uppercase; letter-spacing: 1px;">Payment</p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
      <td style="color: #888; font-size: 13px;">Deposit paid:</td>
      <td style="color: #059669; font-size: 14px; font-weight: bold; text-align: right;">${centsToDollars(r.depositCents)}</td>
    </tr>`;
          if (remaining > 0) {
            paymentHtml += `
    <tr>
      <td style="color: #888; font-size: 13px; padding-top: 4px;">Remaining balance:</td>
      <td style="color: #1A1A1A; font-size: 14px; text-align: right; padding-top: 4px;">${centsToDollars(remaining)}</td>
    </tr>`;
          }
          paymentHtml += `
    </table>
  </td>
</tr>`;
          html = html.replace(/\^\[PaymentSection\]\$/g, paymentHtml);
        } else {
          html = html.replace(/\^\[PaymentSection\]\$/g, "");
        }

        // Confirm button
        if (confirmLink) {
          const btnHtml = `
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 14px;">
<tr><td align="center">
  <a href="${confirmLink}" style="display:inline-block;padding:12px 24px;background-color:#004AAD;color:#ffffff;text-decoration:none;border-radius:555px;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;">View Your Confirmation</a>
</td></tr>
</table>`;
          html = html.replace(/\^\[ConfirmButtonSection\]\$/g, btnHtml);
        } else {
          html = html.replace(/\^\[ConfirmButtonSection\]\$/g, "");
        }

        // Nav links
        const bookAnotherLink = isKbf
          ? `${siteUrl}/hp/book/kids-bowl-free`
          : `${siteUrl}/hp/book/bowling`;
        html = html
          .replace(/\^\[BookAnotherLink\]\$/g, bookAnotherLink)
          .replace(/\^\[ExploreLink\]\$/g, `${siteUrl}/hp/book`);

        const subject = isKbf
          ? `Kids Bowl Free Confirmed - ${center.name}`
          : `Bowling Confirmed - ${center.name}`;

        results.email = await sendEmail(emailTo!, subject, html);
      } catch (err) {
        console.error("[bowling-confirmation] email failed:", err);
      }
    }

    // ── Send SMS ───────────────────────────────────────────────────
    if (sendSms_ && phoneTo) {
      try {
        const normalized = normalizePhone(phoneTo);
        if (normalized.length >= 10) {
          const dateTime = `${dateCompact}, ${timeFull}`;
          const ref = r.qamfReservationId ?? `HP-${r.id}`;

          // Single-segment GSM-7 budget — compact message, details on
          // the confirmation page.
          const smsBody = confirmLink
            ? `HeadPinz: Bowling #${ref} for ${dateTime} at ${center.name}. View: ${confirmLink}`
            : `HeadPinz: Bowling #${ref} for ${dateTime} at ${center.name}.`;

          results.sms = await sendSms(normalized, smsBody, center.smsFrom);
        }
      } catch (err) {
        console.error("[bowling-confirmation] sms failed:", err);
        results.sms = false;
      }
    }

    // ── Log dedup key ──────────────────────────────────────────────
    try {
      const log = {
        type: "bowling-confirmation",
        neonId,
        email: emailTo ?? null,
        phone: sendSms_ ? phoneTo : null,
        emailSent: results.email,
        smsSent: results.sms,
        forceResend: forceResend || undefined,
        sentAt: new Date().toISOString(),
      };
      // Only set the dedup key on the initial send (not admin resends)
      if (!forceResend) {
        await redis.set(notifKey, JSON.stringify(log), "EX", 90 * 24 * 60 * 60);
      }
    } catch {
      /* non-fatal */
    }

    return NextResponse.json({ success: true, ...results });
  } catch (err) {
    console.error("[bowling-confirmation] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Notification failed" },
      { status: 500 },
    );
  }
}
