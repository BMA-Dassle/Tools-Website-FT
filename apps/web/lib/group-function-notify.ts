/**
 * Group function lifecycle notifications — SMS, email, Teams.
 *
 * All emails:
 *   - Sent FROM the planner (if available) so it appears in their inbox
 *   - CC the planner so they see the thread
 *   - Reply-to the planner for direct guest responses
 *   - Premium dark-branded design matching the contract landing page
 */

import { sendEmail } from "@/lib/sendgrid";
import { voxSend } from "@/lib/sms-retry";
import { sendAdaptiveCardToChannel, updateAdaptiveCard } from "@/lib/teams-bot";
import { PLANNERS } from "@/lib/sales-lead-config";
import type { GroupFunctionQuote } from "@/lib/group-function-db";
import { parseGiftCardGans } from "@/lib/group-function-db";
import { updateGfTeamsCard } from "@/lib/group-function-db";

const FALLBACK_URL = "https://fasttraxent.com";
const GF_BCC = ["vendorcases@dassle.us", "jacob@headpinz.com"];

function baseUrl(quote: GroupFunctionQuote): string {
  return quote.base_url || FALLBACK_URL;
}
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function primaryGan(quote: GroupFunctionQuote): string {
  const gans = parseGiftCardGans(quote.square_gift_card_gan);
  return gans[0] || "";
}

function allGans(quote: GroupFunctionQuote): string {
  const gans = parseGiftCardGans(quote.square_gift_card_gan);
  return gans.join(", ");
}

function plannerName(quote: GroupFunctionQuote): string {
  return quote.planner_first
    ? `${quote.planner_first} ${quote.planner_last || ""}`.trim()
    : "your event planner";
}

function plannerFrom(quote: GroupFunctionQuote): { email: string; name: string } | undefined {
  if (!quote.planner_email) return undefined;
  return { email: quote.planner_email, name: plannerName(quote) };
}

function plannerCc(quote: GroupFunctionQuote): string | undefined {
  return quote.planner_email || undefined;
}

function resolvePlannerTeamsChatId(quote: GroupFunctionQuote): string | null {
  if (!quote.planner_email) return null;
  const email = quote.planner_email.toLowerCase();
  for (const p of Object.values(PLANNERS)) {
    if (p.email.toLowerCase() === email) return p.teamsChatId;
  }
  return null;
}

// ── Memo helper — logs every email to BMI private notes ────────────

function memoLog(quote: GroupFunctionQuote, message: string): void {
  import("@/lib/bmi-office-actions")
    .then(({ appendProjectPrivateNote, noteTimestamp }) =>
      appendProjectPrivateNote({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        note: `[${noteTimestamp()}] ${message}`,
        contractUrl: `${baseUrl(quote)}/contract/${quote.contract_short_id}`,
      }),
    )
    .catch(() => {});
}

// ── Contract Sent ───────────────────────────────────────────────────

export async function notifyContractSent(quote: GroupFunctionQuote): Promise<void> {
  const contractUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=email_sent`;
  const smsUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=sms_sent`;
  const pName = plannerName(quote);

  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event contract for ${quote.event_name || "your event"} at ${quote.center_name} is ready!`,
            `Review & sign here: ${smsUrl}`,
            `Questions? Contact ${pName}.`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Your Event Contract — ${quote.event_name || quote.center_name}`,
      html: buildContractSentHtml(quote, contractUrl),
      text: `Hi ${quote.guest_first_name},\n\nYour event contract is ready to review and sign.\n\nEvent: ${quote.event_name}\nDate: ${quote.event_date_display}\nTotal: ${dollars(quote.total_cents)}\n\nReview & Sign: ${contractUrl}\n\nQuestions? Reply to this email.\n\n${pName}\n${quote.center_name}`,
    }),

    sendContractTeamsCard(quote),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] contractSent notification failed:", r.reason);
    }
  }

  memoLog(quote, `Contract sent to ${quote.guest_email}`);
}

// ── Contract Updated (before signing) ───────────────────────────────

export async function notifyContractUpdated(quote: GroupFunctionQuote): Promise<void> {
  const contractUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=email_updated`;
  const smsUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=sms_updated`;
  const pName = plannerName(quote);

  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event contract for ${quote.event_name || "your event"} has been updated.`,
            `Review the changes here: ${smsUrl}`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Contract Updated — ${quote.event_name || quote.center_name}`,
      html: buildContractUpdatedHtml(quote, contractUrl),
      text: `Hi ${quote.guest_first_name},\n\nYour event contract for ${quote.event_name} has been updated with new details.\n\nReview the changes: ${contractUrl}\n\nQuestions? Reply to this email.\n\n${pName}\n${quote.center_name}`,
    }),

    updateContractTeamsCard(quote, "contract_sent"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] contractUpdated notification failed:", r.reason);
    }
  }

  memoLog(quote, `Contract updated — resent to ${quote.guest_email}`);
}

// ── Deposit Paid ────────────────────────────────────────────────────

export async function notifyDepositPaid(quote: GroupFunctionQuote): Promise<void> {
  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your deposit of ${dollars(quote.deposit_due_cents)} for ${quote.event_name || "your event"} has been received!`,
            primaryGan(quote) ? `Reference: ${primaryGan(quote)}` : "",
            quote.balance_cents > 0
              ? `Your remaining balance of ${dollars(quote.balance_cents)} will be charged 72 hours before your event.`
              : "",
            `View your event: ${baseUrl(quote)}/contract/${quote.contract_short_id}?src=sms_deposit`,
            `See you at ${quote.center_name}!`,
          ]
            .filter(Boolean)
            .join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Deposit Received — ${quote.event_name || quote.center_name}`,
      html: buildDepositPaidHtml(quote),
      text: `Hi ${quote.guest_first_name},\n\nYour deposit of ${dollars(quote.deposit_due_cents)} has been received for ${quote.event_name}.\n\nReference: ${primaryGan(quote) || "N/A"}\nRemaining balance: ${dollars(quote.balance_cents)}\n\nThe remaining balance will be charged 72 hours before your event.\n\nThank you!\n${quote.center_name}`,
    }),

    updateContractTeamsCard(quote, "deposit_paid"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] depositPaid notification failed:", r.reason);
    }
  }

  memoLog(
    quote,
    `Deposit received — ${dollars(quote.deposit_due_cents)} confirmation sent to ${quote.guest_email}`,
  );
}

// ── Waiver Reminder (sent 5 min after deposit) ─────────────────────

const CLIENT_KEYS_NOTIFY: Record<string, string> = {
  "fort-myers": "headpinzftmyers",
  fasttrax: "headpinzftmyers",
  naples: "headpinznaples",
};

export async function notifyWaiverReminder(quote: GroupFunctionQuote): Promise<void> {
  const items = (quote.line_items || []) as Array<{ name: string }>;
  const { hasWaiverRequiredActivities, fetchProject } = await import("@/lib/bmi-office-actions");
  if (!hasWaiverRequiredActivities(items)) return;

  const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
  if (!project?.projectReference) {
    console.warn(`[gf-notify] no projectReference for waiver email, skipping quote=${quote.id}`);
    return;
  }

  const clientKey = CLIENT_KEYS_NOTIFY[quote.center_code] || "headpinzftmyers";
  const waiverUrl = `https://kiosk.sms-timing.com/${clientKey}/subscribe/event?id=${encodeURIComponent(project.projectReference as string)}`;
  const contractUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=email_waiver`;

  const waiverActivities = items
    .filter((i) =>
      ["laser tag", "gel blaster", "racing", "race", "nexus", "kart", "vip birthday"].some((w) =>
        i.name.toLowerCase().includes(w),
      ),
    )
    .map((i) => i.name);

  const activityList =
    waiverActivities.length > 0
      ? waiverActivities
          .map((a) => `<li style="margin:4px 0;font-size:14px;color:#333">${a}</li>`)
          .join("")
      : "";

  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, all participants for ${quote.event_name || "your event"} at ${quote.center_name} must complete a waiver before arriving.`,
            `Please forward this link to everyone in your group:`,
            waiverUrl,
            `Questions? Contact ${plannerName(quote)}.`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Waivers Required — ${quote.event_name || quote.center_name}`,
      html: emailShell(
        quote,
        "Waivers Required",
        "Please complete waivers before your event",
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">${quote.guest_first_name}, your deposit is confirmed and we can't wait to see you! Before your event, <strong>every participant must complete a waiver</strong>.</p>

        <div style="background:#fef3c7;border-radius:12px;padding:20px;margin:16px 0;border-left:4px solid #f59e0b">
          <p style="margin:0 0 8px;font-size:15px;font-weight:bold;color:#92400e">Important: Waivers Are Mandatory</p>
          <p style="margin:0 0 4px;font-size:13px;color:#78350f">Participants without a signed waiver will not be able to participate in the following activities:</p>
          ${activityList ? `<ul style="margin:8px 0 0;padding-left:20px">${activityList}</ul>` : ""}
        </div>

        <p style="margin:16px 0;font-size:14px;color:#475569">Please forward this email — or share the link below — with everyone attending your event. Getting waivers done early avoids delays at check-in!</p>

        ${ctaButton("Complete Waivers Now", waiverUrl)}

        <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0;text-align:center">
          <p style="margin:0 0 8px;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">Share This Link With Your Group</p>
          <p style="margin:0;font-size:13px;font-family:monospace;color:#334155;word-break:break-all">${waiverUrl}</p>
        </div>

        <p style="margin:16px 0 0;font-size:13px;color:#64748b;text-align:center">You can also access the waiver link anytime from your <a href="${contractUrl}" style="color:#004aad">event page</a>.</p>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour deposit is confirmed! Before your event, every participant must complete a waiver.\n\nComplete waivers here: ${waiverUrl}\n\nPlease forward this link to everyone in your group. Incomplete waivers may delay check-in.\n\nQuestions? Contact ${plannerName(quote)}.\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] waiver reminder failed:", r.reason);
    }
  }

  console.log(`[gf-notify] waiver reminder sent for quote=${quote.id}`);
  memoLog(quote, `Waiver reminder sent to ${quote.guest_email}`);
}

// ── 7-Day Waiver Reminder ──────────────────────────────────────────

export async function notify7DayWaiverReminder(
  quote: GroupFunctionQuote,
  waiverUrl: string,
): Promise<void> {
  const contractUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=email_7day_waiver`;

  const items = (quote.line_items || []) as Array<{ name: string }>;
  const waiverActivities = items
    .filter((i) =>
      ["laser tag", "gel blaster", "racing", "race", "nexus", "kart", "vip birthday"].some((w) =>
        i.name.toLowerCase().includes(w),
      ),
    )
    .map((i) => i.name);

  const activityList =
    waiverActivities.length > 0
      ? waiverActivities
          .map((a) => `<li style="margin:4px 0;font-size:14px;color:#333">${a}</li>`)
          .join("")
      : "";

  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event ${quote.event_name || ""} is in 7 days! All participants must complete their waivers before arriving.`,
            `Complete waivers: ${waiverUrl}`,
            `Please share this link with your entire group.`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      bcc: GF_BCC,
      subject: `Action Required: Waivers Must Be Completed — ${quote.event_name || quote.center_name}`,
      html: emailShell(
        quote,
        "Waivers Must Be Completed Within 7 Days",
        "Your event is coming up — don't wait!",
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">${quote.guest_first_name}, your event is just <strong>7 days away</strong>! To ensure a smooth experience, <strong>everyone attending must complete a waiver</strong> prior to your event.</p>

        <div style="background:#fef3c7;border-radius:12px;padding:20px;margin:16px 0;border-left:4px solid #f59e0b">
          <p style="margin:0 0 8px;font-size:15px;font-weight:bold;color:#92400e">Action Required: Waivers Must Be Completed</p>
          <p style="margin:0 0 4px;font-size:13px;color:#78350f">This must be done within the next 7 days for the following activities:</p>
          ${activityList ? `<ul style="margin:8px 0 0;padding-left:20px">${activityList}</ul>` : ""}
        </div>

        <p style="margin:16px 0;font-size:14px;color:#dc2626;font-weight:bold">Failure to complete waivers in time may result in check-in delays or delays to your event.</p>

        ${ctaButton("Complete Your Waiver Now", waiverUrl)}

        <p style="margin:16px 0;font-size:14px;color:#475569">Make sure everyone in your group signs the waiver. Share this link:</p>

        <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0;text-align:center">
          <p style="margin:0;font-size:13px;font-family:monospace;color:#334155;word-break:break-all">${waiverUrl}</p>
        </div>

        <p style="margin:16px 0 0;font-size:13px;color:#64748b;text-align:center">View your event details anytime on your <a href="${contractUrl}" style="color:#004aad">event page</a>.</p>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour event is 7 days away! All participants must complete a waiver before arriving.\n\nComplete waivers: ${waiverUrl}\n\nPlease share this link with everyone in your group. Failure to complete waivers may result in check-in delays.\n\nIf text don't work, copy and paste the waiver link above.\n\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] 7-day waiver reminder failed:", r.reason);
    }
  }

  console.log(`[gf-notify] 7-day waiver reminder sent for quote=${quote.id}`);
  memoLog(quote, `7-day waiver reminder sent to ${quote.guest_email}`);
}

// ── 2-Day Final Waiver Warning ─────────────────────────────────────

export async function notify2DayWaiverWarning(
  quote: GroupFunctionQuote,
  waiverUrl: string,
): Promise<void> {
  const contractUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=email_2day_waiver`;

  const items = (quote.line_items || []) as Array<{ name: string }>;
  const waiverActivities = items
    .filter((i) =>
      ["laser tag", "gel blaster", "racing", "race", "nexus", "kart", "vip birthday"].some((w) =>
        i.name.toLowerCase().includes(w),
      ),
    )
    .map((i) => i.name);

  const activityList =
    waiverActivities.length > 0
      ? waiverActivities
          .map((a) => `<li style="margin:4px 0;font-size:14px;color:#333">${a}</li>`)
          .join("")
      : "";

  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `URGENT: ${quote.guest_first_name}, your event ${quote.event_name || ""} is in 2 days! Waivers must be completed NOW.`,
            `Guests without a signed waiver will not be able to participate.`,
            `Complete waivers: ${waiverUrl}`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      bcc: GF_BCC,
      subject: `ONLY 2 DAYS LEFT — Complete Waivers Now! — ${quote.event_name || quote.center_name}`,
      html: emailShell(
        quote,
        "Only 2 Days Left to Complete Waiver!",
        "This is your final reminder",
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">${quote.guest_first_name}, your event is in <strong>2 days</strong>. If you or your guests have not signed the required waiver, it must be completed within the next <strong>48 hours</strong> to avoid delays at check-in.</p>

        <div style="background:#fef2f2;border-radius:12px;padding:20px;margin:16px 0;border-left:4px solid #ef4444">
          <p style="margin:0 0 8px;font-size:15px;font-weight:bold;color:#dc2626">Guests without a signed waiver will not be able to participate</p>
          <p style="margin:0;font-size:13px;color:#991b1b">This applies to the following activities at your event:</p>
          ${activityList ? `<ul style="margin:8px 0 0;padding-left:20px">${activityList}</ul>` : ""}
        </div>

        ${ctaButton("Complete Your Waiver Now", waiverUrl)}

        <p style="margin:16px 0;font-size:14px;color:#475569"><strong>Make sure your entire group is ready.</strong> Share the waiver link below with anyone who still needs to sign:</p>

        <div style="background:#f8fafc;border-radius:8px;padding:16px;margin:16px 0;text-align:center">
          <p style="margin:0;font-size:13px;font-family:monospace;color:#334155;word-break:break-all">${waiverUrl}</p>
        </div>

        <p style="margin:16px 0 0;font-size:13px;color:#64748b;text-align:center">If you have already completed your waiver, please disregard this email. View event details on your <a href="${contractUrl}" style="color:#004aad">event page</a>.</p>`,
      ),
      text: `URGENT: ${quote.guest_first_name}, your event is in 2 days!\n\nAll participants must complete their waiver within the next 48 hours.\n\nGuests without a signed waiver will not be able to participate.\n\nComplete waivers: ${waiverUrl}\n\nShare this link with your entire group.\n\nIf already completed, please disregard.\n\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] 2-day waiver warning failed:", r.reason);
    }
  }

  console.log(`[gf-notify] 2-day waiver warning sent for quote=${quote.id}`);
  memoLog(quote, `2-day waiver warning sent to ${quote.guest_email}`);
}

// ── Balance Charged ─────────────────────────────────────────────────

export async function notifyBalanceCharged(quote: GroupFunctionQuote): Promise<void> {
  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, the remaining balance of ${dollars(quote.total_cents - quote.deposit_due_cents)} for ${quote.event_name || "your event"} has been charged.`,
            `You're all set for ${quote.event_date_display || "your event"}!`,
            `See you at ${quote.center_name}!`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Payment Complete — ${quote.event_name || quote.center_name}`,
      html: buildBalanceChargedHtml(quote),
      text: `Hi ${quote.guest_first_name},\n\nYour remaining balance of ${dollars(quote.total_cents - quote.deposit_due_cents)} has been charged. You're all set for ${quote.event_name} on ${quote.event_date_display}!\n\nThank you!\n${quote.center_name}`,
    }),

    updateContractTeamsCard(quote, "balance_charged"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] balanceCharged notification failed:", r.reason);
    }
  }

  memoLog(quote, `Balance charged — ${dollars(quote.balance_cents)} via saved card`);
}

// ── Balance Link Sent ───────────────────────────────────────────────

export async function notifyBalanceLinkSent(quote: GroupFunctionQuote): Promise<void> {
  if (!quote.balance_payment_link_url) return;

  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your remaining balance of ${dollars(quote.balance_cents)} for ${quote.event_name || "your event"} is due.`,
            `Pay here: ${quote.balance_payment_link_url}`,
            `Questions? Contact ${plannerName(quote)}.`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Balance Due — ${quote.event_name || quote.center_name}`,
      html: buildBalanceLinkHtml(quote),
      text: `Hi ${quote.guest_first_name},\n\nYour remaining balance of ${dollars(quote.balance_cents)} for ${quote.event_name} is due.\n\nPay here: ${quote.balance_payment_link_url}\n\nThank you!\n${quote.center_name}`,
    }),

    updateContractTeamsCard(quote, "balance_link_sent"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] balanceLinkSent notification failed:", r.reason);
    }
  }

  memoLog(quote, `Balance payment link sent to ${quote.guest_email}`);
}

// ── 96-Hour Reminder (24hrs before balance charge) ─────────────────

export async function notify96HourReminder(
  quote: GroupFunctionQuote,
  waiverUrl: string | null,
): Promise<void> {
  const contractUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=email_96hr`;
  const smsUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=sms_96hr`;
  const pName = plannerName(quote);
  const items = (quote.line_items || []) as Array<{ name: string }>;
  const { hasWaiverRequiredActivities } = await import("@/lib/bmi-office-actions");
  const hasWaivers = hasWaiverRequiredActivities(items);

  const waiverBlock =
    hasWaivers && waiverUrl
      ? `<div style="background:#fff3cd;border-radius:12px;padding:16px;margin:16px 0;border-left:4px solid #f59e0b">
        <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#92400e">⚠ Waivers Required</p>
        <p style="margin:0 0 12px;font-size:13px;color:#78350f">Some of your activities require signed waivers for all participants. Please make sure your group completes their waivers before the event.</p>
        <a href="${waiverUrl}" style="display:inline-block;padding:10px 24px;background-color:#f59e0b;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:13px">Complete Waivers</a>
      </div>`
      : "";

  const results = await Promise.allSettled([
    quote.guest_phone
      ? (await import("@/lib/sms-retry")).voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event ${quote.event_name || ""} is almost here!`,
            `Your balance of ${dollars(quote.balance_cents)} will be charged tomorrow.`,
            `Update details: ${smsUrl}`,
            hasWaivers && waiverUrl ? `Complete waivers: ${waiverUrl}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Action Needed — Your Event Is Almost Here!`,
      html: emailShell(
        quote,
        `${quote.guest_first_name}, your event is almost here`,
        "Less than 24 hours to update your event details",
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">We're getting excited for <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at ${quote.center_name}! Your remaining balance of <strong style="color:#004aad">${dollars(quote.balance_cents)}</strong> will be automatically charged to your card on file tomorrow.</p>

        <div style="background:#f8fafc;border-radius:12px;padding:16px;margin:16px 0">
          <p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:#1a1a1a">Before that happens, please verify:</p>
          <p style="margin:0;font-size:13px;color:#475569;line-height:1.8">
            ✓ Your guest count is accurate${quote.guest_count ? ` (${quote.guest_count} guests)` : ""}<br>
            ✓ All event details are correct<br>
            ✓ Your card on file is up to date
          </p>
        </div>

        <div style="text-align:center;margin:24px 0">
          <a href="${contractUrl}" style="display:inline-block;padding:14px 28px;background-color:#004aad;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;margin:0 6px">VIEW EVENT DETAILS</a>
        </div>

        ${waiverBlock}

        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          ${pricingRow("Event", quote.event_name || "")}
          ${pricingRow("Date", quote.event_date_display || "")}
          ${pricingRow("Deposit Paid", dollars(quote.deposit_due_cents), true)}
          ${pricingRow("Balance Due (charged tomorrow)", dollars(quote.balance_cents), true)}
          ${pricingRow("Total", dollars(quote.total_cents))}
        </table>

        <p style="margin:0;font-size:13px;color:#64748b;text-align:center">Questions? Reply to this email or contact ${pName}.</p>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour event ${quote.event_name} is almost here! Your balance of ${dollars(quote.balance_cents)} will be charged tomorrow.\n\nVerify your details: ${contractUrl}\n\n${hasWaivers && waiverUrl ? `Complete waivers: ${waiverUrl}\n\n` : ""}${pName}\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] 96hr reminder failed:", r.reason);
    }
  }
}

// ── Balance Charged Receipt ────────────────────────────────────────

export async function notifyBalanceReceipt(
  quote: GroupFunctionQuote,
  waiverUrl: string | null,
  cardLast4?: string,
): Promise<void> {
  const pName = plannerName(quote);
  const items = (quote.line_items || []) as Array<{ name: string }>;
  const { hasWaiverRequiredActivities } = await import("@/lib/bmi-office-actions");
  const hasWaivers = hasWaiverRequiredActivities(items);
  const chargeDate = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const waiverBlock =
    hasWaivers && waiverUrl
      ? `<div style="background:#fff3cd;border-radius:12px;padding:16px;margin:16px 0;border-left:4px solid #f59e0b">
        <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#92400e">⚠ Reminder: Complete Your Waivers</p>
        <p style="margin:0 0 12px;font-size:13px;color:#78350f">All participants must have signed waivers before the event.</p>
        <a href="${waiverUrl}" style="display:inline-block;padding:10px 24px;background-color:#f59e0b;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:13px">Complete Waivers</a>
      </div>`
      : "";

  const notesBlock = quote.notes
    ? `<div style="background:#f8fafc;border-radius:12px;padding:16px;margin:16px 0">
        <p style="margin:0 0 8px;font-size:12px;font-weight:bold;color:#64748b;text-transform:uppercase;letter-spacing:1px">Event Notes</p>
        <p style="margin:0;font-size:13px;color:#475569;white-space:pre-line">${quote.notes}</p>
      </div>`
    : "";

  const results = await Promise.allSettled([
    quote.guest_phone
      ? (await import("@/lib/sms-retry")).voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your payment of ${dollars(quote.balance_cents)} for ${quote.event_name || "your event"} is complete!`,
            `You're all set for ${quote.event_date_display || "your event"}. See you at ${quote.center_name}!`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Payment Complete — See You Soon!`,
      html: emailShell(
        quote,
        "You're all set!",
        `Payment complete for ${quote.event_name || "your event"}`,
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">Great news, ${quote.guest_first_name}! Your remaining balance has been charged and everything is ready for your event. We're looking forward to hosting you at <strong style="color:#0f172a">${quote.center_name}</strong>!</p>

        <div style="background:#f0fdf4;border-radius:12px;padding:20px;margin:16px 0;text-align:center;border:1px solid #bbf7d0">
          <p style="margin:0 0 4px;font-size:13px;color:#15803d;text-transform:uppercase;letter-spacing:1px">Payment Receipt</p>
          <table style="width:100%;margin:12px 0;border-collapse:collapse;text-align:left">
            ${pricingRow("Deposit Paid", dollars(quote.deposit_due_cents))}
            ${pricingRow("Balance Charged", dollars(quote.total_cents - quote.deposit_due_cents), true)}
            <tr><td colspan="2" style="padding:8px 0;border-top:1px solid #d1fae5"></td></tr>
            ${pricingRow("Total Paid", dollars(quote.total_cents), true)}
            ${cardLast4 ? pricingRow("Card", `ending in ${cardLast4}`) : ""}
            ${pricingRow("Date", chargeDate)}
          </table>
        </div>

        ${waiverBlock}

        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          ${pricingRow("Event", quote.event_name || "")}
          ${pricingRow("Date", quote.event_date_display || "")}
          ${quote.guest_count ? pricingRow("Guests", String(quote.guest_count)) : ""}
          ${pricingRow("Center", quote.center_name)}
        </table>

        ${notesBlock}

        <p style="margin:16px 0 0;font-size:15px;color:#475569;text-align:center">We're looking forward to creating an amazing experience for your group!</p>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour payment of ${dollars(quote.total_cents - quote.deposit_due_cents)} is complete. Total paid: ${dollars(quote.total_cents)}.\n\nEvent: ${quote.event_name}\nDate: ${quote.event_date_display}\n${quote.guest_count ? `Guests: ${quote.guest_count}\n` : ""}Center: ${quote.center_name}\n\nWe're looking forward to hosting you!\n\n${pName}\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] balance receipt failed:", r.reason);
    }
  }
}

// ── Event Cancelled ────────────────────────────────────────────────

export async function notifyEventCancelled(
  quote: GroupFunctionQuote,
  hasRefund: boolean,
): Promise<void> {
  const pName = plannerName(quote);

  const refundBlock = hasRefund
    ? `<div style="background:#f0fdf4;border-radius:12px;padding:16px;margin:16px 0;border:1px solid #bbf7d0">
        <p style="margin:0 0 4px;font-size:13px;font-weight:bold;color:#15803d">Refund Initiated</p>
        <p style="margin:0;font-size:13px;color:#475569">A refund has been initiated for your payment(s). Please allow 5-10 business days for the refund to appear on your statement.</p>
      </div>`
    : "";

  const results = await Promise.allSettled([
    quote.guest_phone
      ? (await import("@/lib/sms-retry")).voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event ${quote.event_name || ""} at ${quote.center_name} has been cancelled.`,
            hasRefund ? "A refund has been initiated to your card." : "",
            `Questions? Contact ${pName}.`,
          ]
            .filter(Boolean)
            .join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Event Cancelled — ${quote.event_name || quote.center_name}`,
      html: emailShell(
        quote,
        "Event Cancelled",
        `${quote.event_name || "Your event"} has been cancelled`,
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">${quote.guest_first_name}, we're sorry to inform you that <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at ${quote.center_name} has been cancelled.</p>

        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          ${pricingRow("Event", quote.event_name || "")}
          ${pricingRow("Date", quote.event_date_display || "")}
          ${pricingRow("Center", quote.center_name)}
        </table>

        ${refundBlock}

        <p style="margin:16px 0 0;font-size:13px;color:#64748b;text-align:center">If you have questions about this cancellation, please contact your event planner.</p>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour event ${quote.event_name} at ${quote.center_name} has been cancelled.\n\n${hasRefund ? "A refund has been initiated. Please allow 5-10 business days.\n\n" : ""}Questions? Contact ${pName}.\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] cancellation notification failed:", r.reason);
    }
  }
}

// ── Post-Paid Approval ─────────────────────────────────────────────

const APPROVAL_RECIPIENTS = ["eric@headpinz.com", "jacob@headpinz.com"];

export async function notifyApprovalNeeded(quote: GroupFunctionQuote): Promise<void> {
  for (const to of APPROVAL_RECIPIENTS) {
    const approveUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}/approve?for=${encodeURIComponent(to)}`;
    sendEmail({
      to,
      subject: `[APPROVAL NEEDED] Post-Paid: ${quote.event_name || quote.center_name}`,
      bcc: GF_BCC,
      html: emailShell(
        quote,
        "Post-Paid Approval Required",
        `${quote.event_name || "Event"} requires management approval`,
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">A new post-paid group event needs your approval before the contract is sent to the customer.</p>

        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          ${pricingRow("Customer", `${quote.guest_first_name} ${quote.guest_last_name}`)}
          ${pricingRow("Email", quote.guest_email)}
          ${pricingRow("Planner", plannerName(quote))}
          ${pricingRow("Event Total", dollars(quote.total_cents), true)}
        </table>

        ${ctaButton("Review & Approve", approveUrl)}

        <p style="margin:0;font-size:13px;color:#64748b;text-align:center">This event uses a post-paid account. No deposit will be collected.</p>`,
      ),
      text: `Post-paid approval needed for ${quote.event_name}\n\nCustomer: ${quote.guest_first_name} ${quote.guest_last_name}\nTotal: ${dollars(quote.total_cents)}\nPlanner: ${plannerName(quote)}\n\nReview: ${approveUrl}`,
    }).catch((err) => console.error("[gf-notify] approval email failed:", err));
  }
}

export async function notifyPostPaidDenied(quote: GroupFunctionQuote): Promise<void> {
  if (!quote.planner_email) return;

  await sendEmail({
    to: quote.planner_email,
    toName: plannerName(quote),
    cc: APPROVAL_RECIPIENTS.join(","),
    bcc: GF_BCC,
    subject: `Post-Paid Account Denied — ${quote.event_name || quote.center_name}`,
    html: emailShell(
      quote,
      "Post-Paid Account Denied",
      `${quote.event_name || "Event"} was not approved for post-paid billing`,
      `<p style="margin:0 0 16px;font-size:15px;color:#475569">The post-paid account request for <strong style="color:#0f172a">${quote.event_name || "this event"}</strong> has been denied.</p>

      ${
        quote.denial_reason
          ? `<div style="background:#f8fafc;border-radius:12px;padding:20px;margin:16px 0;border-left:4px solid #ef4444">
        <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Reason</p>
        <p style="margin:0;font-size:15px;color:#1a1a1a">${quote.denial_reason}</p>
      </div>`
          : ""
      }

      <p style="margin:16px 0 0;font-size:13px;color:#64748b">Please convert this to a standard deposit event or contact management for further discussion.</p>`,
    ),
    text: `Post-paid account denied for ${quote.event_name}\n\n${quote.denial_reason ? `Reason: ${quote.denial_reason}\n\n` : ""}Please convert this to a standard deposit event or contact management.`,
  });
}

// ── Teams Adaptive Card ─────────────────────────────────────────────

async function sendContractTeamsCard(quote: GroupFunctionQuote): Promise<void> {
  const chatId = resolvePlannerTeamsChatId(quote);
  if (!chatId) return;

  const card = buildGroupFunctionCard(quote);
  const result = await sendAdaptiveCardToChannel(chatId, card, {
    summaryText: `GF Contract: ${quote.event_name}`,
  });

  if (result.id) {
    await updateGfTeamsCard(quote.id, result.id, chatId);
  }
}

async function updateContractTeamsCard(quote: GroupFunctionQuote, stage: string): Promise<void> {
  if (!quote.teams_card_activity_id || !quote.teams_card_conversation_id) return;

  const card = buildGroupFunctionCard(quote, stage);
  await updateAdaptiveCard(quote.teams_card_conversation_id, quote.teams_card_activity_id, card);
}

function buildGroupFunctionCard(
  quote: GroupFunctionQuote,
  stage?: string,
): Record<string, unknown> {
  const effectiveStage = stage || quote.status;
  const pName = plannerName(quote);

  const facts = [
    { title: "Event", value: quote.event_name || "—" },
    { title: "Date", value: quote.event_date_display || "—" },
    { title: "Guest", value: `${quote.guest_first_name} ${quote.guest_last_name}` },
    { title: "Email", value: quote.guest_email },
    { title: "Total", value: dollars(quote.total_cents) },
    { title: "Deposit", value: dollars(quote.deposit_due_cents) },
    { title: "Balance", value: dollars(quote.balance_cents) },
  ];

  if (primaryGan(quote)) {
    facts.push({ title: "GAN", value: allGans(quote) });
  }

  const statusBanners: Record<string, unknown>[] = [];

  if (effectiveStage === "contract_sent" || quote.contract_sent_at) {
    statusBanners.push({
      type: "TextBlock",
      text: `Contract sent ${quote.contract_sent_at ? new Date(quote.contract_sent_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : ""}`,
      color: "accent",
      size: "small",
      weight: "bolder",
    });
  }

  if (quote.contract_signed_at) {
    statusBanners.push({
      type: "TextBlock",
      text: `Contract signed ${new Date(quote.contract_signed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}`,
      color: "good",
      size: "small",
      weight: "bolder",
    });
  }

  if (quote.deposit_paid_at) {
    statusBanners.push({
      type: "TextBlock",
      text: `Deposit paid: ${dollars(quote.deposit_due_cents)} ${new Date(quote.deposit_paid_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}`,
      color: "good",
      size: "small",
      weight: "bolder",
    });
  }

  if (quote.balance_paid_at) {
    statusBanners.push({
      type: "TextBlock",
      text: `Balance charged: ${dollars(quote.total_cents - quote.deposit_due_cents)} (${quote.balance_payment_method || "auto"})`,
      color: "good",
      size: "small",
      weight: "bolder",
    });
  }

  if (effectiveStage === "balance_link_sent" && quote.balance_payment_link_url) {
    statusBanners.push({
      type: "TextBlock",
      text: "Balance payment link sent to customer",
      color: "warning",
      size: "small",
      weight: "bolder",
    });
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: `Group Function: ${quote.event_name || "#" + (quote.event_number || "")}`,
        weight: "bolder",
        size: "medium",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: `${quote.center_name} · Planner: ${pName}`,
        size: "small",
        isSubtle: true,
      },
      ...statusBanners,
      { type: "FactSet", facts },
    ],
    actions: quote.contract_short_id
      ? [
          {
            type: "Action.OpenUrl",
            title: "View Contract",
            url: `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=teams`,
          },
        ]
      : [],
  };
}

// ── Premium Email HTML ──────────────────────────────────────────────

function emailShell(
  quote: GroupFunctionQuote,
  heroTitle: string,
  heroSubtitle: string,
  content: string,
): string {
  const pName = plannerName(quote);
  const domain = quote.brand === "headpinz" ? "headpinz.com" : "fasttraxent.com";

  return `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="color-scheme" content="light" /><meta name="supported-color-schemes" content="light" /><style type="text/css">:root{color-scheme:light;supported-color-schemes:light}#outlook a{padding:0}a img{border:none}table td{border-collapse:collapse}body{margin:0;padding:0;background-color:#f2f3f5;-webkit-text-size-adjust:100%}a{color:#004aad}.section-label{font-size:10px;text-transform:uppercase;letter-spacing:3px;color:#004aad;font-weight:bold}.cta-btn{display:inline-block;padding:14px 28px;background-color:#004aad;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase}.cta-btn.red{background-color:#d71c1c;color:#ffffff !important}</style></head>
<body style="margin:0;padding:0;background-color:#f2f3f5">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f3f5">
<tr><td align="center" style="padding:20px 10px">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0">

  <!-- HEADER LOGOS -->
  <tr><td style="padding:24px 40px;background-color:#000418">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" width="50%"><img src="https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/hp_logo%201.png" width="130" alt="HeadPinz" style="height:auto" /></td>
      <td align="right" width="50%"><img src="https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png" width="130" alt="FastTrax" style="height:auto" /></td>
    </tr></table>
  </td></tr>

  <!-- HEADLINE -->
  <tr><td align="center" style="padding:28px 40px 20px 40px;font-family:Arial,sans-serif">
    <h1 style="margin:0 0 8px 0;font-size:24px;color:#1a1a1a;letter-spacing:1px;text-transform:uppercase">${heroTitle}</h1>
    <p style="margin:0;font-size:15px;color:#666666;line-height:1.6">${heroSubtitle}</p>
  </td></tr>

  <!-- CONTENT -->
  <tr><td style="padding:0 40px 24px 40px;font-family:Arial,sans-serif">
    ${content}
  </td></tr>

  <!-- EVENT SUMMARY -->
  <tr><td style="padding:0 40px 24px 40px;font-family:Arial,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden">
      <tr><td style="background-color:#000418;padding:10px 16px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#00e2e5;text-transform:uppercase;letter-spacing:1px">${quote.event_name || "Event Details"}</td></tr>
      <tr><td style="padding:14px 16px;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.8">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="color:#888;font-size:13px;width:140px">Date:</td><td style="color:#1a1a1a;font-size:14px;font-weight:bold">${quote.event_date_display || ""}</td></tr>
          <tr><td style="color:#888;font-size:13px;padding-top:6px">Center:</td><td style="color:#1a1a1a;font-size:14px;padding-top:6px">${quote.center_name}</td></tr>
          <tr><td style="color:#888;font-size:13px;padding-top:6px">Total:</td><td style="color:#1a1a1a;font-size:14px;font-weight:bold;padding-top:6px">${dollars(quote.total_cents)}</td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- PLANNER -->
  <tr><td style="padding:0 40px 24px 40px;font-family:Arial,sans-serif">
    <p class="section-label" style="margin:0 0 10px 0">Your Event Planner</p>
    <p style="margin:0 0 2px;font-size:16px;font-weight:bold;color:#1a1a1a">${pName}</p>
    ${quote.planner_phone ? `<p style="margin:0;font-size:13px;color:#666"><a href="tel:${quote.planner_phone}" style="color:#004aad;text-decoration:none">${quote.planner_phone}</a></p>` : ""}
    ${quote.planner_email ? `<p style="margin:0;font-size:13px;color:#666"><a href="mailto:${quote.planner_email}" style="color:#004aad;text-decoration:none">${quote.planner_email}</a></p>` : ""}
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:16px 40px;border-top:1px solid #e0e0e0;font-family:Arial,sans-serif;text-align:center">
    <p style="margin:0;font-size:11px;color:#999">${quote.center_name} · <a href="${baseUrl(quote)}" style="color:#999;text-decoration:none">${domain}</a></p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function ctaButton(text: string, url: string): string {
  return `<div style="text-align:center;margin:24px 0"><a href="${url}" style="display:inline-block;padding:14px 28px;background-color:#004aad;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif">${text}</a></div>`;
}

function pricingRow(label: string, value: string, highlight?: boolean): string {
  return `<tr><td style="padding:6px 0;color:#888;font-size:13px;font-family:Arial,sans-serif">${label}</td><td style="padding:6px 0;text-align:right;font-size:14px;font-weight:${highlight ? "bold" : "normal"};color:${highlight ? "#004aad" : "#1a1a1a"};font-family:Arial,sans-serif">${value}</td></tr>`;
}

function buildContractSentHtml(quote: GroupFunctionQuote, contractUrl: string): string {
  return emailShell(
    quote,
    `${quote.guest_first_name}, your experience awaits`,
    `Your event contract is ready to review and sign`,
    `<p style="margin:0 0 16px;font-size:15px;color:#475569">We're excited to host <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at ${quote.center_name}! Review the details below and sign your contract to lock in your date.</p>

    <table style="width:100%;margin:16px 0;border-collapse:collapse">
      ${pricingRow("Event Total", dollars(quote.total_cents))}
      ${pricingRow("Deposit Due Today", dollars(quote.deposit_due_cents), true)}
      ${quote.balance_cents > 0 ? pricingRow("Balance (due 72hrs before)", dollars(quote.balance_cents)) : ""}
    </table>

    ${ctaButton("Review & Sign Contract", contractUrl)}

    <p style="margin:0;font-size:13px;color:#64748b;text-align:center">After signing, you'll pay your deposit to secure your date.</p>`,
  );
}

function buildContractUpdatedHtml(quote: GroupFunctionQuote, contractUrl: string): string {
  return emailShell(
    quote,
    "Contract Updated",
    `Your event details have been revised`,
    `<p style="margin:0 0 16px;font-size:15px;color:#475569">${quote.guest_first_name}, your event planner has updated the details for <strong style="color:#0f172a">${quote.event_name || "your event"}</strong>. Please review the updated contract and sign to confirm.</p>

    <table style="width:100%;margin:16px 0;border-collapse:collapse">
      ${pricingRow("Event Total", dollars(quote.total_cents))}
      ${pricingRow("Deposit Due", dollars(quote.deposit_due_cents), true)}
      ${quote.balance_cents > 0 ? pricingRow("Balance (due 72hrs before)", dollars(quote.balance_cents)) : ""}
    </table>

    ${ctaButton("Review Updated Contract", contractUrl)}

    <p style="margin:0;font-size:13px;color:#64748b;text-align:center">The previous version has been replaced with this updated contract.</p>`,
  );
}

function buildDepositPaidHtml(quote: GroupFunctionQuote): string {
  return emailShell(
    quote,
    "Deposit Received!",
    `Your date at ${quote.center_name} is secured`,
    `<p style="margin:0 0 16px;font-size:15px;color:#475569">Great news, ${quote.guest_first_name}! Your deposit has been received and your event date is locked in.</p>

    <div style="background:#f8fafc;border-radius:12px;padding:20px;margin:16px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Deposit Paid</p>
      <p style="margin:0;font-size:32px;font-weight:800;color:#22d3ee">${dollars(quote.deposit_due_cents)}</p>
      ${primaryGan(quote) ? `<p style="margin:8px 0 0;font-size:12px;font-family:monospace;color:#64748b">Ref: ${primaryGan(quote)}</p>` : ""}
    </div>

    <table style="width:100%;margin:16px 0;border-collapse:collapse">
      ${pricingRow("Event Date", quote.event_date_display || "")}
      ${pricingRow("Deposit Paid", dollars(quote.deposit_due_cents), true)}
      ${quote.balance_cents > 0 ? pricingRow("Remaining Balance", dollars(quote.balance_cents)) : ""}
    </table>

    ${quote.balance_cents > 0 ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;text-align:center">The remaining balance will be automatically charged 72 hours before your event.</p>` : ""}

    ${ctaButton("View Your Event", `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=email_deposit`)}`,
  );
}

function buildBalanceChargedHtml(quote: GroupFunctionQuote): string {
  return emailShell(
    quote,
    "You're All Set!",
    `Payment complete for ${quote.event_name || "your event"}`,
    `<p style="margin:0 0 16px;font-size:15px;color:#475569">${quote.guest_first_name}, your remaining balance has been charged. Everything is paid and you're ready to go!</p>

    <div style="background:#f8fafc;border-radius:12px;padding:20px;margin:16px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Total Paid</p>
      <p style="margin:0;font-size:32px;font-weight:800;color:#22c55e">${dollars(quote.total_cents)}</p>
    </div>

    <table style="width:100%;margin:16px 0;border-collapse:collapse">
      ${pricingRow("Event", quote.event_name || "")}
      ${pricingRow("Date", quote.event_date_display || "")}
      ${pricingRow("Total Paid", dollars(quote.total_cents), true)}
    </table>

    <p style="margin:16px 0 0;font-size:15px;color:#475569;text-align:center">See you at <strong style="color:#0f172a">${quote.center_name}</strong>!</p>`,
  );
}

function buildBalanceLinkHtml(quote: GroupFunctionQuote): string {
  return emailShell(
    quote,
    "Balance Due",
    `Complete your payment for ${quote.event_name || "your event"}`,
    `<p style="margin:0 0 16px;font-size:15px;color:#475569">${quote.guest_first_name}, your event is coming up and the remaining balance is due.</p>

    <div style="background:#f8fafc;border-radius:12px;padding:20px;margin:16px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Balance Due</p>
      <p style="margin:0;font-size:32px;font-weight:800;color:#f59e0b">${dollars(quote.balance_cents)}</p>
    </div>

    ${ctaButton(`Pay ${dollars(quote.balance_cents)}`, quote.balance_payment_link_url || "#")}

    <p style="margin:0;font-size:13px;color:#64748b;text-align:center">Questions? Reply to this email or contact your planner.</p>`,
  );
}
