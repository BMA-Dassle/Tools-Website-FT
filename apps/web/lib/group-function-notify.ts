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
import { notifyContractDataIssues } from "@/lib/group-function-alert";
import type { GroupFunctionQuote } from "@/lib/group-function-db";
import { parseGiftCardGans, balanceChargeTiming } from "@/lib/group-function-db";
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

// ── Helpers ─────────────────────────────────────────────────────────

function emailOk(result: PromiseSettledResult<unknown>): boolean {
  if (result.status === "rejected") return false;
  const v = result.value;
  return !(v && typeof v === "object" && "ok" in v && !(v as { ok: boolean }).ok);
}

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

/**
 * Fire a staff Teams alert when a contract email to a *syntactically valid*
 * address actually failed to send (e.g. SendGrid rejected it / bounce). The
 * empty/invalid-email case is already caught up front by the dispatch cron's
 * `collectContractDataIssues`, so we only alert here when an address was
 * present — avoids a duplicate alert for the missing-email case. Best-effort.
 */
function alertContractEmailFailed(quote: GroupFunctionQuote): void {
  if (!quote.guest_email?.trim()) return;
  notifyContractDataIssues({
    centerCode: quote.center_code,
    centerName: quote.center_name,
    reservationId: quote.bmi_reservation_id,
    eventName: quote.event_name || "",
    guestName: `${quote.guest_first_name || ""} ${quote.guest_last_name || ""}`.trim(),
    guestEmail: quote.guest_email,
    guestPhone: quote.guest_phone || "",
    plannerEmail: quote.planner_email || "",
    contractUrl: quote.contract_short_id
      ? `${baseUrl(quote)}/contract/${quote.contract_short_id}`
      : undefined,
    issues: ["Email delivery failed — SendGrid did not accept the guest address"],
  }).catch(() => {});
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
      html: await buildContractSentHtml(quote, contractUrl),
      text: `Hi ${quote.guest_first_name},\n\nYour event contract is ready to review and sign.\n\nEvent: ${quote.event_name}\nDate: ${quote.event_date_display}\nTotal: ${dollars(quote.total_cents)}\n\nReview & Sign: ${contractUrl}\n\nQuestions? Reply to this email.\n\n${pName}\n${quote.center_name}`,
    }),

    sendContractTeamsCard(quote),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] contractSent notification failed:", r.reason);
    }
  }

  const sentOk = emailOk(results[1]);
  memoLog(
    quote,
    sentOk
      ? `Contract sent to ${quote.guest_email}`
      : `Contract email FAILED to ${quote.guest_email}`,
  );
  if (!sentOk) alertContractEmailFailed(quote);
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
      html: await buildContractUpdatedHtml(quote, contractUrl),
      text: `Hi ${quote.guest_first_name},\n\nYour event contract for ${quote.event_name} has been updated with new details.\n\nReview the changes: ${contractUrl}\n\nQuestions? Reply to this email.\n\n${pName}\n${quote.center_name}`,
    }),

    updateContractTeamsCard(quote, "contract_sent"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] contractUpdated notification failed:", r.reason);
    }
  }

  const updatedOk = emailOk(results[1]);
  memoLog(
    quote,
    updatedOk
      ? `Contract updated — resent to ${quote.guest_email}`
      : `Contract update email FAILED to ${quote.guest_email}`,
  );
  if (!updatedOk) alertContractEmailFailed(quote);
}

// ── Deposit Paid ────────────────────────────────────────────────────

export async function notifyDepositPaid(quote: GroupFunctionQuote): Promise<void> {
  // Inside 72h the balance cron charges within ~15 min of card save — never
  // promise "72 hours before" when the charge is effectively immediate.
  const immediate = balanceChargeTiming(quote) === "immediate";
  const balanceLine =
    quote.balance_cents > 0
      ? immediate
        ? `Your remaining balance of ${dollars(quote.balance_cents)} will be charged today.`
        : `Your remaining balance of ${dollars(quote.balance_cents)} will be charged 72 hours before your event.`
      : "";
  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your deposit of ${dollars(quote.deposit_due_cents)} for ${quote.event_name || "your event"} has been received!`,
            primaryGan(quote) ? `Reference: ${primaryGan(quote)}` : "",
            balanceLine,
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
      html: await buildDepositPaidHtml(quote),
      text: `Hi ${quote.guest_first_name},\n\nYour deposit of ${dollars(quote.deposit_due_cents)} has been received for ${quote.event_name}.\n\nReference: ${primaryGan(quote) || "N/A"}${quote.balance_cents > 0 ? `\nRemaining balance: ${dollars(quote.balance_cents)}\n\n${balanceLine}` : ""}\n\nThank you!\n${quote.center_name}`,
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
      html: await emailShell(
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
        { omitWaiverNotice: true },
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
      html: await emailShell(
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
        { omitWaiverNotice: true },
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
      html: await emailShell(
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
        { omitWaiverNotice: true },
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
      html: await buildBalanceChargedHtml(quote),
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

// ── Re-price: delta charged after re-sign ───────────────────────────

/**
 * A paid-in-full event was re-priced UP and, after the guest re-signed, we
 * charged the difference to the card on file (and loaded the gift cards).
 * Receipt to guest + planner.
 */
export async function notifyRepriceCharged(
  quote: GroupFunctionQuote,
  deltaCents: number,
  cardLast4?: string,
): Promise<void> {
  const cardLine = cardLast4 ? ` to your card ending in ${cardLast4}` : " to your card on file";
  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event total for ${quote.event_name || "your event"} was updated to ${dollars(quote.total_cents)}.`,
            `We charged the ${dollars(deltaCents)} difference${cardLine}.`,
            `You're all set for ${quote.event_date_display || "your event"}!`,
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
      subject: `Balance Adjustment — ${quote.event_name || quote.center_name}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0a1628">
        <h2 style="color:#0a1628">Your event total was updated</h2>
        <p>Hi ${quote.guest_first_name},</p>
        <p>Your event <strong>${quote.event_name || quote.center_name}</strong> on
        ${quote.event_date_display || ""} was updated to a new total of
        <strong>${dollars(quote.total_cents)}</strong>.</p>
        <p>We charged the difference of <strong>${dollars(deltaCents)}</strong>${cardLine}.
        Your event is fully paid and confirmed.</p>
        <p>Questions? Just reply to this email to reach ${plannerName(quote)}.</p>
        <p>Thank you!<br/>${quote.center_name}</p>
      </div>`,
      text: `Hi ${quote.guest_first_name},\n\nYour event total for ${quote.event_name} was updated to ${dollars(quote.total_cents)}. We charged the ${dollars(deltaCents)} difference${cardLine}. Your event is fully paid and confirmed.\n\nThank you!\n${quote.center_name}`,
    }),

    updateContractTeamsCard(quote, "balance_charged"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] repriceCharged notification failed:", r.reason);
    }
  }

  memoLog(
    quote,
    `Re-price charged — ${dollars(deltaCents)} difference collected (new total ${dollars(quote.total_cents)})`,
  );
}

/**
 * A paid-in-full event was re-priced DOWN below what was collected. We do NOT
 * auto-refund — alert staff to issue the refund in Square.
 */
export async function notifyRepriceRefundOwed(
  quote: GroupFunctionQuote,
  overageCents: number,
): Promise<void> {
  const staffTo = quote.planner_email || GF_BCC[0];
  await sendEmail({
    to: staffTo,
    toName: plannerName(quote),
    cc: plannerCc(quote),
    bcc: GF_BCC,
    subject: `ACTION: Refund owed — ${quote.event_name || quote.center_name}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0a1628">
      <h2 style="color:#b91c1c">Refund owed — manual action required</h2>
      <p>Event <strong>${quote.event_name || quote.center_name}</strong>
      (${quote.event_number || quote.bmi_reservation_id}) on ${quote.event_date_display || ""}
      was re-priced down.</p>
      <p>New total: <strong>${dollars(quote.total_cents)}</strong><br/>
      Collected: <strong>${dollars(quote.collected_cents)}</strong><br/>
      <strong style="color:#b91c1c">Overage to refund: ${dollars(overageCents)}</strong></p>
      <p>Original balance payment: ${quote.square_balance_payment_id || "n/a"}<br/>
      Deposit payment: ${quote.square_deposit_payment_id || "n/a"}</p>
      <p>Issue the refund in the Square dashboard. No automatic refund was made.</p>
    </div>`,
    text: `Refund owed — ${quote.event_name} (${quote.event_number || quote.bmi_reservation_id}). New total ${dollars(quote.total_cents)}, collected ${dollars(quote.collected_cents)}, overage to refund ${dollars(overageCents)}. Balance payment ${quote.square_balance_payment_id || "n/a"}, deposit payment ${quote.square_deposit_payment_id || "n/a"}. Issue refund in Square; no auto-refund made.`,
  }).catch((err) => console.error("[gf-notify] repriceRefundOwed email failed:", err));

  memoLog(
    quote,
    `Re-price DOWN — refund owed ${dollars(overageCents)} (new total ${dollars(quote.total_cents)}, collected ${dollars(quote.collected_cents)}). Manual Square refund required.`,
  );
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
      html: await buildBalanceLinkHtml(quote),
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

// ── Notification-engine builders (return a result for the ledger) ───

/** Result shape consumed by the reminder dispatcher's ledger. */
export interface NotifyResult {
  emailOk: boolean;
  /** true=sent, false=failed, null=not attempted (no phone / suppressed). */
  smsOk: boolean | null;
  smsId?: string;
}

/** Normalize a settled voxSend result into {ok, id}. */
function smsResult(r: PromiseSettledResult<unknown>): { ok: boolean | null; id?: string } {
  if (r.status === "rejected") return { ok: false };
  const v = r.value as { ok?: boolean; voxId?: string; twilioSid?: string } | undefined;
  if (!v || typeof v !== "object" || !("ok" in v)) return { ok: null }; // Promise.resolve() = not attempted
  return { ok: Boolean(v.ok), id: v.voxId || v.twilioSid };
}

/**
 * Scheduled "balance due in N days" reminder for events that still owe money.
 * payUrl is the existing balance payment link if present, else the contract
 * portal — we do NOT mint a new Square link here.
 */
export async function notifyPaymentDueReminder(
  quote: GroupFunctionQuote,
  daysOut: number,
  payUrl: string,
  opts?: { smsSuppressed?: boolean },
): Promise<NotifyResult> {
  const amountDue = quote.total_cents - quote.collected_cents;
  const pName = plannerName(quote);

  const results = await Promise.allSettled([
    quote.guest_phone && !opts?.smsSuppressed
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your balance of ${dollars(amountDue)} for ${quote.event_name || "your event"} at ${quote.center_name} is due in ${daysOut} days.`,
            `Pay here: ${payUrl}`,
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
      subject: `Balance Due in ${daysOut} Days — ${quote.event_name || quote.center_name}`,
      html: await emailShell(
        quote,
        `${quote.guest_first_name}, your balance is due soon`,
        `${daysOut} days until your event balance is due`,
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">Your event <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at ${quote.center_name} is coming up! Here's a friendly reminder that your remaining balance is due.</p>
        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          ${pricingRow("Event Total", dollars(quote.total_cents))}
          ${pricingRow("Collected", dollars(quote.collected_cents))}
          ${pricingRow("Balance Due", dollars(amountDue), true)}
        </table>
        ${ctaButton("Complete Your Payment", payUrl)}`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour remaining balance of ${dollars(amountDue)} for ${quote.event_name} is due in ${daysOut} days.\n\nPay here: ${payUrl}\n\nThank you!\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") console.error("[gf-notify] paymentDueReminder failed:", r.reason);
  }
  const sms = smsResult(results[0]);
  memoLog(quote, `Payment-due (T-${daysOut}) reminder sent to ${quote.guest_email}`);
  return { emailOk: emailOk(results[1]), smsOk: sms.ok, smsId: sms.id };
}

/**
 * Day-of final ask for events that reach event MORNING still owing. Exciting
 * framing: get the contracted balance out of the way now, then it's all fun.
 * Extras stay flexible — additional items can be added with the server on-site.
 * payUrl is the existing balance payment link if present, else the contract
 * portal — we do NOT mint a new Square link here.
 */
export async function notifyBalanceDueToday(
  quote: GroupFunctionQuote,
  payUrl: string,
  opts?: { smsSuppressed?: boolean },
): Promise<NotifyResult> {
  const amountDue = quote.total_cents - quote.collected_cents;
  const pName = plannerName(quote);

  const results = await Promise.allSettled([
    quote.guest_phone && !opts?.smsSuppressed
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event at ${quote.center_name} is TODAY! 🎉`,
            `Get the final balance on your contract (${dollars(amountDue)}) out of the way now — then it's all fun from there: ${payUrl}`,
            `Extras? Your server can add items on-site. Questions? Contact ${pName}.`,
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
      subject: `Your Event is TODAY 🎉 — Settle Up & Let the Fun Begin! (${quote.event_name || quote.center_name})`,
      html: await emailShell(
        quote,
        `${quote.guest_first_name}, your event is HERE! 🎉`,
        "Get the final balance out of the way — then it's all fun",
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">Today's the day! <strong style="color:#0f172a">${quote.event_name || "Your event"}</strong> at ${quote.center_name} is just hours away. Take one minute to settle the final balance on your contract now, and the only thing left to do when you walk in is have fun — no paperwork, no waiting, straight to the good part.</p>
        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          ${pricingRow("Event Total", dollars(quote.total_cents))}
          ${pricingRow("Collected", dollars(quote.collected_cents))}
          ${pricingRow("Contracted Balance Due Today", dollars(amountDue), true)}
        </table>
        ${ctaButton("Settle Up & Let the Fun Begin", payUrl)}
        <p style="margin:0;font-size:13px;color:#64748b;text-align:center">Want extra games, food, or add-ons? Easy — additional items can always be added with your server on-site.</p>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour event ${quote.event_name || ""} at ${quote.center_name} is TODAY! Get the final balance on your contract (${dollars(amountDue)}) out of the way now — then it's all fun from there.\n\nPay here: ${payUrl}\n\nWant extras? Additional items can always be added with your server on-site.\n\nSee you soon!\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") console.error("[gf-notify] balanceDueToday failed:", r.reason);
  }
  const sms = smsResult(results[0]);
  memoLog(quote, `Day-of balance reminder sent to ${quote.guest_email}`);
  return { emailOk: emailOk(results[1]), smsOk: sms.ok, smsId: sms.id };
}

/** Post-event thank-you (email only — gentler, no late-night SMS). */
export async function notifyThankYou(quote: GroupFunctionQuote): Promise<NotifyResult> {
  const venue = quote.brand === "headpinz" ? "bowling center" : "racing center";
  const [r] = await Promise.allSettled([
    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      bcc: GF_BCC,
      subject: `Thank You from ${quote.center_name}!`,
      html: await emailShell(
        quote,
        `Thank you, ${quote.guest_first_name}!`,
        "We hope your event was a blast",
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">Thank you for hosting <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at our ${venue}! We hope everyone had an amazing time.</p>
        <p style="margin:0 0 16px;font-size:15px;color:#475569">We'd love to host you again — just reach out anytime to start planning your next event.</p>`,
        { omitWaiverNotice: true },
      ),
      text: `Hi ${quote.guest_first_name},\n\nThank you for hosting ${quote.event_name} at ${quote.center_name}! We hope everyone had a great time.\n\nWe'd love to host you again.\n\n${quote.center_name}`,
    }),
  ]);
  return { emailOk: emailOk(r), smsOk: null };
}

/**
 * Dedicated "last chance to change your order" call (~5 days out) — a final
 * nudge to adjust the event (guests, lanes, food, add-ons, timing) before the
 * total is finalized and the balance is charged. Deliberately NOT framed as a
 * headcount: most events are sized by lane, not guest count. Changes route
 * through the planner (the portal is view-only for event details).
 */
export async function notifyHeadcountFinal(
  quote: GroupFunctionQuote,
  opts?: { smsSuppressed?: boolean },
): Promise<NotifyResult> {
  const pName = plannerName(quote);
  const eventLabel = quote.event_name || "your event";
  const url = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=finalize`;

  const results = await Promise.allSettled([
    quote.guest_phone && !opts?.smsSuppressed
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, ${eventLabel} at ${quote.center_name} is coming up!`,
            `Last chance to make any changes to your order — reply or contact ${pName} before we finalize your total.`,
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
      subject: `Last chance to update your event — ${quote.event_name || quote.center_name}`,
      html: await emailShell(
        quote,
        `${quote.guest_first_name}, any changes before we finalize?`,
        "Last chance to update your event before we finalize your total",
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">Your event <strong style="color:#0f172a">${eventLabel}</strong> at ${quote.center_name} is coming up! If anything has changed — guests, lanes, food, add-ons, or timing — now's the time to let us know.</p>
        <div style="background:#fff3cd;border-radius:12px;padding:16px;margin:16px 0;border-left:4px solid #f59e0b">
          <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#92400e">📋 Last chance to make changes</p>
          <p style="margin:0;font-size:13px;color:#78350f">If your order has changed, now's the time. Reply to this email or contact ${pName} and we'll update your total — once your balance is finalized, your order is locked in.</p>
        </div>
        ${ctaButton("View Event Details", url)}
        <p style="margin:0;font-size:13px;color:#64748b;text-align:center">Questions? Reply to this email or contact ${pName}.</p>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour event ${eventLabel} at ${quote.center_name} is coming up! This is your last chance to make changes to your order before we finalize your total. If anything has changed, reply to this email or contact ${pName}.\n\n${pName}\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") console.error("[gf-notify] headcountFinal failed:", r.reason);
  }
  const sms = smsResult(results[0]);
  memoLog(quote, `Final-headcount reminder sent to ${quote.guest_email}`);
  return { emailOk: emailOk(results[1]), smsOk: sms.ok, smsId: sms.id };
}

// ── $20 Legacy Win-Back ─────────────────────────────────────────────

/**
 * The win-back offer: "add your card on file now, get a $20 e-gift card today —
 * we'll charge your balance 72 hours before your event like normal." Links to
 * the /contract portal where the existing legacy-deposit flow saves the card.
 */
export async function notifyWinbackOffer(
  quote: GroupFunctionQuote,
  opts?: { smsSuppressed?: boolean },
): Promise<NotifyResult> {
  const amountDue = quote.total_cents - quote.deposit_due_cents;
  const bonus = dollars(quote.incentive_cents || 2000);
  const pName = plannerName(quote);
  const url = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=winback`;
  // Inside 72h the balance cron charges within ~15 min of card save — the
  // "no charge today / 72 hours before" promise would be false. Be honest.
  const immediate = balanceChargeTiming(quote) === "immediate";

  const results = await Promise.allSettled([
    quote.guest_phone && !opts?.smsSuppressed
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, lock in ${quote.event_name || "your event"} at ${quote.center_name} & get a ${bonus} e-gift card on us!`,
            immediate
              ? `Your event is almost here — add your card on file now and we'll settle the ${dollars(amountDue)} balance today; your ${bonus} e-gift card is issued right away.`
              : `Add your card on file now — we'll charge the ${dollars(amountDue)} balance 72 hours before, just like normal.`,
            `Get started: ${url}`,
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
      subject: `Lock in your event & get a ${bonus} e-Gift Card!`,
      html: await emailShell(
        quote,
        `${quote.guest_first_name}, add your card & get ${bonus}`,
        `Lock in your event and we'll send you a ${bonus} e-gift card today`,
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">Let's get <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at ${quote.center_name} fully locked in! Add a card on file now and we'll send you a <strong style="color:#004aad">${bonus} e-gift card</strong> right away — spend it on arrival on concessions, games, whatever you like.</p>
        ${
          immediate
            ? `<p style="margin:0 0 16px;font-size:15px;color:#475569">Your event is almost here! Add your card on file now and we'll settle your remaining balance of <strong style="color:#0f172a">${dollars(amountDue)}</strong> today — and your <strong>${bonus} e-gift card</strong> still applies, issued the moment your card is on file.</p>`
            : `<p style="margin:0 0 16px;font-size:15px;color:#475569">No charge today — we'll automatically charge your remaining balance <strong>72 hours before your event</strong>, exactly like every other event.</p>`
        }
        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          ${pricingRow("Event Total", dollars(quote.total_cents))}
          ${pricingRow("Deposit Paid", dollars(quote.deposit_due_cents))}
          ${pricingRow(immediate ? "Balance (charged today)" : "Balance (charged 72hrs before)", dollars(amountDue), true)}
          ${pricingRow("Your Bonus", `${bonus} e-gift card — today`, true)}
        </table>
        ${ctaButton(`Add Card & Claim ${bonus}`, url)}
        <p style="margin:0;font-size:13px;color:#64748b;text-align:center">Your ${bonus} e-gift card is issued the moment your card is on file.</p>`,
      ),
      text: immediate
        ? `Hi ${quote.guest_first_name},\n\nLock in ${quote.event_name} at ${quote.center_name} and get a ${bonus} e-gift card today! Your event is almost here — add your card on file now and we'll settle your ${dollars(amountDue)} balance today; your ${bonus} e-gift card is issued right away.\n\nGet started: ${url}\n\n${quote.center_name}`
        : `Hi ${quote.guest_first_name},\n\nLock in ${quote.event_name} at ${quote.center_name} and get a ${bonus} e-gift card today! Add your card on file now — no charge today; we'll charge your ${dollars(amountDue)} balance 72 hours before your event, just like normal.\n\nGet started: ${url}\n\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") console.error("[gf-notify] winbackOffer failed:", r.reason);
  }
  const sms = smsResult(results[0]);
  memoLog(quote, `Win-back $20 card-on-file offer sent to ${quote.guest_email}`);
  return { emailOk: emailOk(results[1]), smsOk: sms.ok, smsId: sms.id };
}

/** Receipt after a win-back guest adds a card on file — confirms the $20 + schedule. */
export async function notifyWinbackReceipt(
  quote: GroupFunctionQuote,
  incentiveGan: string,
  opts?: { smsSuppressed?: boolean },
): Promise<NotifyResult> {
  const bonus = dollars(quote.incentive_cents || 2000);
  const amountDue = quote.total_cents - quote.deposit_due_cents;
  // Inside 72h the balance cron charges this card within ~15 min — say so.
  const immediate = balanceChargeTiming(quote) === "immediate";
  const results = await Promise.allSettled([
    quote.guest_phone && !opts?.smsSuppressed
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, you're all set for ${quote.event_name || "your event"} — card's on file!`,
            `Your ${bonus} e-gift card is ready: ${incentiveGan}. Spend it on arrival at ${quote.center_name}.`,
            immediate
              ? `Your remaining balance of ${dollars(amountDue)} will be charged to your card shortly — you're all set for your event!`
              : `We'll charge your ${dollars(amountDue)} balance 72 hours before your event.`,
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
      subject: `You're All Set — Here's Your ${bonus} e-Gift Card!`,
      html: await emailShell(
        quote,
        `Thank you, ${quote.guest_first_name}!`,
        `Your card is on file and your ${bonus} e-gift card is ready`,
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">You're all set for <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at ${quote.center_name}! Your card is securely on file, and ${
          immediate
            ? `your remaining balance of <strong style="color:#004aad">${dollars(amountDue)}</strong> will be charged shortly — you're all set for your event.`
            : `we'll automatically charge your remaining balance of <strong style="color:#004aad">${dollars(amountDue)}</strong> 72 hours before your event.`
        }</p>
        <div style="background:#eef6ff;border-radius:12px;padding:16px;margin:16px 0;border-left:4px solid #004aad">
          <p style="margin:0 0 6px;font-size:13px;font-weight:bold;color:#004aad;text-transform:uppercase;letter-spacing:1px">Your ${bonus} e-Gift Card</p>
          <p style="margin:0;font-size:18px;font-weight:bold;color:#0f172a;letter-spacing:1px">${incentiveGan}</p>
          <p style="margin:8px 0 0;font-size:13px;color:#475569">Spend it on arrival — concessions, games, or anything else. No need to print; just give this number at the counter.</p>
        </div>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYou're all set for ${quote.event_name} — your card is on file and your ${bonus} e-gift card is ready: ${incentiveGan}\n\n${
        immediate
          ? `Your remaining balance of ${dollars(amountDue)} will be charged shortly — you're all set for your event.`
          : `We'll charge your ${dollars(amountDue)} balance 72 hours before your event.`
      } Spend your ${bonus} on arrival at ${quote.center_name}.\n\nThank you!`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") console.error("[gf-notify] winbackReceipt failed:", r.reason);
  }
  const sms = smsResult(results[0]);
  memoLog(quote, `Win-back $20 card ${incentiveGan} issued (card on file) to ${quote.guest_email}`);
  return { emailOk: emailOk(results[1]), smsOk: sms.ok, smsId: sms.id };
}

/**
 * Day-of final ask for win-back events that never added a card. Their pay path
 * is the contract portal: add a card → the balance cron charges within ~15 min
 * → the $20 e-gift card mints. Only fires on event day (rule-gated), so the
 * copy says "today" outright.
 */
export async function notifyWinbackBalanceDueToday(
  quote: GroupFunctionQuote,
  opts?: { smsSuppressed?: boolean },
): Promise<NotifyResult> {
  const amountDue = quote.total_cents - quote.deposit_due_cents;
  const bonus = dollars(quote.incentive_cents || 2000);
  const pName = plannerName(quote);
  const url = `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=winback_dayof`;

  const results = await Promise.allSettled([
    quote.guest_phone && !opts?.smsSuppressed
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event at ${quote.center_name} is TODAY! 🎉`,
            `Get the final balance out of the way now — add your card to settle the ${dollars(amountDue)} contracted balance, and your ${bonus} e-gift card still applies: ${url}`,
            `Extras? Your server can add items on-site. Questions? Contact ${pName}.`,
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
      subject: `Your Event is TODAY 🎉 — Settle Up, Get ${bonus}, Let the Fun Begin`,
      html: await emailShell(
        quote,
        `${quote.guest_first_name}, your event is HERE! 🎉`,
        `Settle your balance now — your ${bonus} e-gift card still applies`,
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">Today's the day! <strong style="color:#0f172a">${quote.event_name || "Your event"}</strong> at ${quote.center_name} kicks off in just a few hours. Get the final balance out of the way now: add a card on file and we'll settle your contracted balance of <strong style="color:#004aad">${dollars(amountDue)}</strong> today — your <strong style="color:#004aad">${bonus} e-gift card</strong> is issued the moment your card is on file, and the rest of the day is pure fun.</p>
        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          ${pricingRow("Event Total", dollars(quote.total_cents))}
          ${pricingRow("Deposit Paid", dollars(quote.deposit_due_cents))}
          ${pricingRow("Contracted Balance (charged today)", dollars(amountDue), true)}
          ${pricingRow("Your Bonus", `${bonus} e-gift card — today`, true)}
        </table>
        ${ctaButton(`Add Card & Claim ${bonus}`, url)}
        <p style="margin:0;font-size:13px;color:#64748b;text-align:center">Want extra games, food, or add-ons? Easy — additional items can always be added with your server on-site.</p>`,
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour event ${quote.event_name || ""} at ${quote.center_name} is TODAY! Get the final balance out of the way now: add your card to settle the ${dollars(amountDue)} contracted balance — your ${bonus} e-gift card still applies.\n\nGet started: ${url}\n\nWant extras? Additional items can always be added with your server on-site.\n\nSee you soon!\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected")
      console.error("[gf-notify] winbackBalanceDueToday failed:", r.reason);
  }
  const sms = smsResult(results[0]);
  memoLog(quote, `Day-of win-back balance reminder sent to ${quote.guest_email}`);
  return { emailOk: emailOk(results[1]), smsOk: sms.ok, smsId: sms.id };
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
            `${quote.guest_first_name}, ${quote.event_name || "your event"} is almost here!`,
            `Final chance to change your guest count — your balance of ${dollars(quote.balance_cents)} is charged tomorrow.`,
            `Review/update: ${smsUrl}`,
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
      html: await emailShell(
        quote,
        `${quote.guest_first_name}, your event is almost here`,
        "Last call to change your guest count — your balance is charged tomorrow",
        `<p style="margin:0 0 16px;font-size:15px;color:#475569">We're getting excited for <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at ${quote.center_name}! Your remaining balance of <strong style="color:#004aad">${dollars(quote.balance_cents)}</strong> will be automatically charged to your card on file tomorrow.</p>

        <div style="background:#fff3cd;border-radius:12px;padding:16px;margin:16px 0;border-left:4px solid #f59e0b">
          <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#92400e">📋 Final chance to change your headcount</p>
          <p style="margin:0;font-size:13px;color:#78350f">We'll charge for ${quote.guest_count ? `<strong>${quote.guest_count} guests</strong>` : "your current guest count"} when your balance runs tomorrow. Need to adjust? Reply to this email or contact ${pName} today — after the charge, your total is locked in.</p>
        </div>

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

  memoLog(quote, `96-hour reminder sent to ${quote.guest_email}`);
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
      html: await emailShell(
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

  memoLog(quote, `Balance receipt sent to ${quote.guest_email}`);
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
      html: await emailShell(
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
        { omitWaiverNotice: true },
      ),
      text: `Hi ${quote.guest_first_name},\n\nYour event ${quote.event_name} at ${quote.center_name} has been cancelled.\n\n${hasRefund ? "A refund has been initiated. Please allow 5-10 business days.\n\n" : ""}Questions? Contact ${pName}.\n${quote.center_name}`,
    }),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] cancellation notification failed:", r.reason);
    }
  }

  memoLog(quote, `Cancellation notice sent to ${quote.guest_email}`);
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
      html: await emailShell(
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
        { omitWaiverNotice: true },
      ), // staff-internal: no guest waiver banner
      text: `Post-paid approval needed for ${quote.event_name}\n\nCustomer: ${quote.guest_first_name} ${quote.guest_last_name}\nTotal: ${dollars(quote.total_cents)}\nPlanner: ${plannerName(quote)}\n\nReview: ${approveUrl}`,
    }).catch((err) => console.error("[gf-notify] approval email failed:", err));
  }

  memoLog(quote, `Approval request sent to management`);
}

export async function notifyPostPaidDenied(quote: GroupFunctionQuote): Promise<void> {
  if (!quote.planner_email) return;

  await sendEmail({
    to: quote.planner_email,
    toName: plannerName(quote),
    cc: APPROVAL_RECIPIENTS.join(","),
    bcc: GF_BCC,
    subject: `Post-Paid Account Denied — ${quote.event_name || quote.center_name}`,
    html: await emailShell(
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
      { omitWaiverNotice: true },
    ),
    text: `Post-paid account denied for ${quote.event_name}\n\n${quote.denial_reason ? `Reason: ${quote.denial_reason}\n\n` : ""}Please convert this to a standard deposit event or contact management.`,
  });

  memoLog(quote, `Post-paid denied — planner notified`);
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

// Per-quote waiver-URL cache — one BMI lookup per quote per warm lambda.
const WAIVER_URL_CACHE = new Map<number, string | null>();

/** Event-specific waiver signing link (kiosk), or null when unresolvable. */
async function eventWaiverUrl(quote: GroupFunctionQuote): Promise<string | null> {
  const cached = WAIVER_URL_CACHE.get(quote.id);
  if (cached !== undefined) return cached;
  let url: string | null = null;
  try {
    const { fetchProject } = await import("@/lib/bmi-office-actions");
    const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
    if (project?.projectReference) {
      const clientKey = CLIENT_KEYS_NOTIFY[quote.center_code] || "headpinzftmyers";
      url = `https://kiosk.sms-timing.com/${clientKey}/subscribe/event?id=${encodeURIComponent(String(project.projectReference))}`;
    }
  } catch {
    /* non-fatal — the notice renders without a link */
  }
  WAIVER_URL_CACHE.set(quote.id, url);
  return url;
}

/**
 * Loud, unmissable waiver banner injected into EVERY guest lifecycle email
 * (owner requirement 2026-06-11). Self-qualifying copy: only events with
 * laser tag / gel blasters / karting need waivers, but the banner rides every
 * email so no planner or guest can miss it. Dedicated waiver emails opt out
 * via emailShell's omitWaiverNotice (they carry richer activity-specific copy).
 */
function waiverNoticeRow(waiverUrl: string | null): string {
  return `
  <!-- WAIVER NOTICE -->
  <tr><td style="padding:0 40px 24px 40px;font-family:Arial,sans-serif">
    <div style="background:#fef2f2;border:2px solid #dc2626;border-radius:12px;padding:18px;text-align:center">
      <p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#dc2626;text-transform:uppercase;letter-spacing:1px">⚠️ Waivers Required</p>
      <p style="margin:0 0 12px;font-size:14px;color:#7f1d1d;line-height:1.6">If your event includes <strong>laser tag, gel blasters, or go-kart racing</strong>, ALL participants must sign a waiver before the event. Share the link with everyone attending — signed waivers mean no waiting at check-in!</p>
      ${
        waiverUrl
          ? `<a href="${waiverUrl}" style="display:inline-block;padding:11px 22px;background-color:#dc2626;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:13px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif">Sign Your Event Waiver</a>
      <p style="margin:10px 0 0;font-size:12px;font-family:monospace;color:#7f1d1d;word-break:break-all">${waiverUrl}</p>`
          : `<p style="margin:0;font-size:13px;color:#7f1d1d">Find your event's waiver link on your event page, or ask your planner.</p>`
      }
    </div>
  </td></tr>`;
}

async function emailShell(
  quote: GroupFunctionQuote,
  heroTitle: string,
  heroSubtitle: string,
  content: string,
  opts?: { omitWaiverNotice?: boolean },
): Promise<string> {
  const pName = plannerName(quote);
  const domain = quote.brand === "headpinz" ? "headpinz.com" : "fasttraxent.com";
  const waiverNotice = opts?.omitWaiverNotice ? "" : waiverNoticeRow(await eventWaiverUrl(quote));

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
  ${waiverNotice}
  <!-- EVENT SUMMARY -->
  <tr><td style="padding:0 40px 24px 40px;font-family:Arial,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden">
      <tr><td style="background-color:#000418;padding:10px 16px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#00e2e5;text-transform:uppercase;letter-spacing:1px">${quote.event_name || "Event Details"}</td></tr>
      <tr><td style="padding:14px 16px;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.8">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          ${quote.event_number ? `<tr><td style="color:#888;font-size:13px;width:140px">Booking #:</td><td style="color:#1a1a1a;font-size:14px;font-weight:bold">${quote.event_number}</td></tr>` : ""}
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

async function buildContractSentHtml(
  quote: GroupFunctionQuote,
  contractUrl: string,
): Promise<string> {
  return emailShell(
    quote,
    `${quote.guest_first_name}, your experience awaits`,
    `Your event contract is ready to review and sign`,
    `<p style="margin:0 0 16px;font-size:15px;color:#475569">We're excited to host <strong style="color:#0f172a">${quote.event_name || "your event"}</strong> at ${quote.center_name}! Review the details below and sign your contract to lock in your date.</p>

    <table style="width:100%;margin:16px 0;border-collapse:collapse">
      ${pricingRow("Event Total", dollars(quote.total_cents))}
      ${pricingRow(quote.balance_cents > 0 ? "Deposit Due Today" : "Payment Due Today", dollars(quote.deposit_due_cents), true)}
      ${quote.balance_cents > 0 ? pricingRow("Balance (due 72hrs before)", dollars(quote.balance_cents)) : ""}
    </table>

    ${ctaButton("Review & Sign Contract", contractUrl)}

    <p style="margin:0;font-size:13px;color:#64748b;text-align:center">After signing, you'll pay your deposit to secure your date.</p>`,
  );
}

async function buildContractUpdatedHtml(
  quote: GroupFunctionQuote,
  contractUrl: string,
): Promise<string> {
  return emailShell(
    quote,
    "Contract Updated",
    `Your event details have been revised`,
    `<p style="margin:0 0 16px;font-size:15px;color:#475569">${quote.guest_first_name}, your event planner has updated the details for <strong style="color:#0f172a">${quote.event_name || "your event"}</strong>. Please review the updated contract and sign to confirm.</p>

    <table style="width:100%;margin:16px 0;border-collapse:collapse">
      ${pricingRow("Event Total", dollars(quote.total_cents))}
      ${pricingRow(quote.balance_cents > 0 ? "Deposit Due" : "Payment Due", dollars(quote.deposit_due_cents), true)}
      ${quote.balance_cents > 0 ? pricingRow("Balance (due 72hrs before)", dollars(quote.balance_cents)) : ""}
    </table>

    ${ctaButton("Review Updated Contract", contractUrl)}

    <p style="margin:0;font-size:13px;color:#64748b;text-align:center">The previous version has been replaced with this updated contract.</p>`,
  );
}

async function buildDepositPaidHtml(quote: GroupFunctionQuote): Promise<string> {
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

    ${quote.balance_cents > 0 ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;text-align:center">The remaining balance will be automatically charged ${balanceChargeTiming(quote) === "immediate" ? "today" : "72 hours before your event"}.</p>` : ""}

    ${ctaButton("View Your Event", `${baseUrl(quote)}/contract/${quote.contract_short_id}?src=email_deposit`)}`,
  );
}

async function buildBalanceChargedHtml(quote: GroupFunctionQuote): Promise<string> {
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

async function buildBalanceLinkHtml(quote: GroupFunctionQuote): Promise<string> {
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
