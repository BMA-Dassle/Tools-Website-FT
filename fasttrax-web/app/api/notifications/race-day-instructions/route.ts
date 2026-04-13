import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { Redis } from "ioredis";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FROM_NAME = "FastTrax Entertainment";
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const ACTIVITY_BOX_LINK = "https://smstim.in/headpinzftmyers";

// ── Template (loaded once) ─────────────────────────────────────────────────

let template: string | null = null;
function getTemplate(): string {
  if (!template) {
    template = readFileSync(join(process.cwd(), "emails", "race-day-instructions.html"), "utf-8");
  }
  return template;
}

// ── SendGrid ───────────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
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
    return res.ok || res.status === 202;
  } catch {
    return false;
  }
}

// ── Build dynamic sections ─────────────────────────────────────────────────

function buildWhenYouArriveExpress(): string {
  return `
    <p class="section-label" style="margin: 0 0 14px 0; text-align: center;">When You Arrive</p>
    <table width="100%" cellpadding="16" cellspacing="0" border="0"
           style="background-color:#ECFDF5; border: 2px solid #10B981; border-radius: 6px;">
    <tr>
    <td style="font-family: Arial, sans-serif;">
      <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: bold; color: #059669;">&#9889; EXPRESS LANE</p>
      <p style="margin: 0 0 8px 0; font-size: 14px; color: #CC0000; line-height: 1.5;">
        <span style="text-decoration: line-through;">&#10060; Guest Services</span> &nbsp;&nbsp;
        <span style="text-decoration: line-through;">&#10060; Event Check-In</span>
      </p>
      <p style="margin: 0 0 8px 0; font-size: 18px; font-weight: 900; color: #059669;">
        &#10148; Head straight to Karting!
      </p>
      <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;">1st Floor &mdash; Arrive 5 minutes before your race time.</p>
      <p style="margin: 0; font-size: 13px; color: #059669; font-weight: bold;">Have your confirmation open and ready on your phone.</p>
    </td>
    </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 12px;">
    <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #EEEEEE;">
      <strong style="color: #059669; font-size: 18px;">1.</strong>
      <strong style="color: #1A1A1A; font-size: 14px;">Go Directly to Karting &mdash; 1st Floor</strong>
      <p style="margin: 4px 0 0 26px; font-size: 13px; color: #666; line-height: 1.5;">
        Skip Guest Services and Event Check-In. Head straight to the karting area on the 1st floor.
      </p>
    </td>
    </tr>
    <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #EEEEEE;">
      <strong style="color: #059669; font-size: 18px;">2.</strong>
      <strong style="color: #1A1A1A; font-size: 14px;">Show Your Confirmation</strong>
      <p style="margin: 4px 0 0 26px; font-size: 13px; color: #666; line-height: 1.5;">
        Have your confirmation page or this email ready on your phone for the karting check-in team.
      </p>
    </td>
    </tr>
    <tr>
    <td style="padding: 10px 0;">
      <strong style="color: #059669; font-size: 18px;">3.</strong>
      <strong style="color: #1A1A1A; font-size: 14px;">Race, Qualify, Level Up</strong>
      <p style="margin: 4px 0 0 26px; font-size: 13px; color: #666; line-height: 1.5;">
        Drive smooth, hit your qualifying time, and unlock the next tier. Check your results in the app after each heat.
      </p>
    </td>
    </tr>
    </table>`;
}

function buildWhenYouArriveStandard(): string {
  return `
    <p class="section-label" style="margin: 0 0 14px 0; text-align: center;">When You Arrive</p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #EEEEEE;">
      <strong style="color: #004AAD; font-size: 18px;">1.</strong>
      <strong style="color: #1A1A1A; font-size: 14px;">Head to Guest Services 30 Minutes Early</strong>
      <p style="margin: 4px 0 0 26px; font-size: 13px; color: #666; line-height: 1.5;">
        Go upstairs to Guest Services to complete your reservation. Waivers should be completed before arrival.
      </p>
    </td>
    </tr>
    <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #EEEEEE;">
      <strong style="color: #004AAD; font-size: 18px;">2.</strong>
      <strong style="color: #1A1A1A; font-size: 14px;">Guest Services Reviews &amp; Prints Tickets</strong>
      <p style="margin: 4px 0 0 26px; font-size: 13px; color: #666; line-height: 1.5;">
        We'll verify waivers, confirm your booking, and print your race tickets.
      </p>
    </td>
    </tr>
    <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #EEEEEE;">
      <strong style="color: #004AAD; font-size: 18px;">3.</strong>
      <strong style="color: #1A1A1A; font-size: 14px;">Check In Downstairs at Your Scheduled Time</strong>
      <p style="margin: 4px 0 0 26px; font-size: 13px; color: #666; line-height: 1.5;">
        <strong style="color: #D71C1C;">Your scheduled time is your check-in time for karting, not your race start time.</strong>
        Plan for about 30&ndash;45 minutes from check-in to the end of your race.
      </p>
    </td>
    </tr>
    <tr>
    <td style="padding: 10px 0;">
      <strong style="color: #004AAD; font-size: 18px;">4.</strong>
      <strong style="color: #1A1A1A; font-size: 14px;">Race, Qualify, Level Up</strong>
      <p style="margin: 4px 0 0 26px; font-size: 13px; color: #666; line-height: 1.5;">
        Drive smooth, hit your qualifying time, and unlock the next tier. Check your results in the app after each heat.
      </p>
    </td>
    </tr>
    </table>`;
}

function buildWaiverExpress(): string {
  return `
    <table width="100%" cellpadding="14" cellspacing="0" border="0"
           style="background-color:#ECFDF5; border: 2px solid #10B981; border-radius: 6px;">
    <tr>
    <td align="center" style="font-size: 15px; font-weight: bold; color: #059669;">
      &#9989; Waiver Complete
    </td>
    </tr>
    <tr>
    <td align="center" style="font-size: 13px; color: #333; line-height: 1.6;">
      Your waiver is on file and up to date. No action needed &mdash; you're all set!
    </td>
    </tr>
    </table>`;
}

function buildWaiverStandard(waiverUrl: string): string {
  return `
    <table width="100%" cellpadding="16" cellspacing="0" border="0"
           style="background-color:#FFF0F0; border: 2px solid #D71C1C; border-radius: 6px;">
    <tr>
    <td align="center" style="font-size: 17px; font-weight: bold; color: #D71C1C;">
      WAIVERS REQUIRED
    </td>
    </tr>
    <tr>
    <td align="center" style="font-size: 14px; color: #333; line-height: 1.6;">
      Every guest must complete a waiver <strong>before arrival</strong>.
      Missing waivers are the <strong>#1 cause of delays</strong>.
    </td>
    </tr>
    <tr>
    <td align="center">
      <a href="${waiverUrl}" style="display:inline-block;padding:14px 28px;background-color:#D71C1C;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Complete Waiver Now</a>
    </td>
    </tr>
    <tr>
    <td align="center" style="font-size: 11px; color: #999; word-break: break-all;">
      ${waiverUrl}
    </td>
    </tr>
    </table>`;
}

// ── POST handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const {
      billId,
      email,
      firstName,
      expressLane,
      schedule,
      waiverUrl,
      confirmUrl,
    } = await req.json();

    if (!email || !billId) {
      return NextResponse.json({ error: "email and billId required" }, { status: 400 });
    }

    // Dedup check
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    try {
      await redis.connect();
      const dedupKey = `notif:raceday:${billId}`;
      const already = await redis.get(dedupKey);
      if (already) {
        redis.disconnect();
        return NextResponse.json({ success: true, duplicate: true });
      }

      // Build email
      const isExpress = !!expressLane;
      let html = getTemplate();

      // Replace dynamic sections
      html = html.replace("^WhenYouArriveSection()$", isExpress ? buildWhenYouArriveExpress() : buildWhenYouArriveStandard());
      html = html.replace("^WaiverSection()$", isExpress ? buildWaiverExpress() : buildWaiverStandard(waiverUrl || "https://kiosk.sms-timing.com/headpinzftmyers/subscribe"));
      html = html.replace("^ReservationSchedule()$", schedule || "See your confirmation for details.");
      html = html.replace(/\^ConfirmationLink\(\)\$/g, confirmUrl || `https://fasttraxent.com/book/confirmation?billId=${billId}`);
      html = html.replace(/\^ActivityBoxLink\(\)\$/g, ACTIVITY_BOX_LINK);

      // Send
      const subject = `${isExpress ? "⚡ " : ""}Race Day Prep — ${firstName || "Racer"}`;
      const sent = await sendEmail(email, subject, html);

      // Log & dedup
      const log = {
        type: "race-day-instructions",
        billId,
        email,
        expressLane: isExpress,
        sentAt: new Date().toISOString(),
        sent,
      };
      await redis.set(dedupKey, JSON.stringify(log), "EX", 24 * 60 * 60); // 24hr TTL
      if (billId) {
        await redis.rpush(`notif:history:${billId}`, JSON.stringify(log));
        await redis.expire(`notif:history:${billId}`, 90 * 24 * 60 * 60);
      }

      redis.disconnect();
      return NextResponse.json({ success: sent, expressLane: isExpress });
    } catch (err) {
      redis.disconnect();
      throw err;
    }
  } catch (err) {
    console.error("[race-day-instructions] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
