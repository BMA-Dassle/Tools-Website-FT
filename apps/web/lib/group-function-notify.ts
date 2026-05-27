/**
 * Group function lifecycle notifications — SMS, email, Teams.
 *
 * Sends branded messages to guests and planners at each lifecycle stage:
 *   - Contract sent (SMS + email to guest, Teams card to planner)
 *   - Contract signed (Teams card update)
 *   - Deposit paid (SMS + email to guest, Teams card update)
 *   - Balance charged (SMS + email receipt to guest, Teams card update)
 *   - Balance link sent (SMS + email with payment link)
 */

import { sendEmail } from "@/lib/sendgrid";
import { voxSend } from "@/lib/sms-retry";
import { sendAdaptiveCardToChannel, updateAdaptiveCard } from "@/lib/teams-bot";
import { PLANNERS } from "@/lib/sales-lead-config";
import type { GroupFunctionQuote } from "@/lib/group-function-db";
import { updateGfTeamsCard } from "@/lib/group-function-db";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function resolvePlannerTeamsChatId(quote: GroupFunctionQuote): string | null {
  if (!quote.planner_email) return null;
  const email = quote.planner_email.toLowerCase();
  for (const p of Object.values(PLANNERS)) {
    if (p.email.toLowerCase() === email) return p.teamsChatId;
  }
  return null;
}

// ── Contract Sent ───────────────────────────────────────────────────

export async function notifyContractSent(quote: GroupFunctionQuote): Promise<void> {
  const contractUrl = `${BASE_URL}/contract/${quote.contract_short_id}`;
  const plannerName = quote.planner_first
    ? `${quote.planner_first} ${quote.planner_last || ""}`.trim()
    : "your event planner";

  const results = await Promise.allSettled([
    // SMS to guest
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event contract for ${quote.event_name || "your event"} at ${quote.center_name} is ready!`,
            `Review & sign here: ${contractUrl}`,
            `Questions? Contact ${plannerName}.`,
          ].join("\n"),
        )
      : Promise.resolve(),

    // Email to guest
    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: quote.planner_email ? { email: quote.planner_email, name: plannerName } : undefined,
      replyTo: quote.planner_email || undefined,
      subject: `Your Event Contract — ${quote.event_name || quote.center_name}`,
      html: buildContractSentEmailHtml(quote, contractUrl, plannerName),
      text: `Hi ${quote.guest_first_name},\n\nYour event contract is ready to review and sign.\n\nEvent: ${quote.event_name}\nDate: ${quote.event_date_display}\nTotal: ${dollars(quote.total_cents)}\n\nReview & Sign: ${contractUrl}\n\nQuestions? Reply to this email or contact ${plannerName}.\n\nThank you!\n${quote.center_name}`,
    }),

    // Teams card to planner
    sendContractTeamsCard(quote),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] contractSent notification failed:", r.reason);
    }
  }
}

// ── Deposit Paid ────────────────────────────────────────────────────

export async function notifyDepositPaid(quote: GroupFunctionQuote): Promise<void> {
  const results = await Promise.allSettled([
    // SMS to guest
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your deposit of ${dollars(quote.deposit_due_cents)} for ${quote.event_name || "your event"} has been received!`,
            quote.square_gift_card_gan ? `Reference: ${quote.square_gift_card_gan}` : "",
            `Your remaining balance of ${dollars(quote.balance_cents)} will be charged 72 hours before your event.`,
            `See you at ${quote.center_name}!`,
          ]
            .filter(Boolean)
            .join("\n"),
        )
      : Promise.resolve(),

    // Email to guest
    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      subject: `Deposit Received — ${quote.event_name || quote.center_name}`,
      html: buildDepositPaidEmailHtml(quote),
      text: `Hi ${quote.guest_first_name},\n\nYour deposit of ${dollars(quote.deposit_due_cents)} has been received for ${quote.event_name}.\n\nReference: ${quote.square_gift_card_gan || "N/A"}\nRemaining balance: ${dollars(quote.balance_cents)}\n\nThe remaining balance will be charged 72 hours before your event.\n\nThank you!\n${quote.center_name}`,
    }),

    // Teams card update
    updateContractTeamsCard(quote, "deposit_paid"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] depositPaid notification failed:", r.reason);
    }
  }
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
      subject: `Payment Complete — ${quote.event_name || quote.center_name}`,
      html: buildBalanceChargedEmailHtml(quote),
      text: `Hi ${quote.guest_first_name},\n\nYour remaining balance of ${dollars(quote.total_cents - quote.deposit_due_cents)} has been charged. You're all set for ${quote.event_name} on ${quote.event_date_display}!\n\nThank you!\n${quote.center_name}`,
    }),

    updateContractTeamsCard(quote, "balance_charged"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] balanceCharged notification failed:", r.reason);
    }
  }
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
            `Questions? Contact us at ${quote.center_name}.`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      subject: `Balance Due — ${quote.event_name || quote.center_name}`,
      html: buildBalanceLinkEmailHtml(quote),
      text: `Hi ${quote.guest_first_name},\n\nYour remaining balance of ${dollars(quote.balance_cents)} for ${quote.event_name} is due.\n\nPay here: ${quote.balance_payment_link_url}\n\nThank you!\n${quote.center_name}`,
    }),

    updateContractTeamsCard(quote, "balance_link_sent"),
  ]);

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[gf-notify] balanceLinkSent notification failed:", r.reason);
    }
  }
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
  const plannerName = quote.planner_first
    ? `${quote.planner_first} ${quote.planner_last || ""}`.trim()
    : "Guest Services";

  const facts = [
    { title: "Event", value: quote.event_name || "—" },
    { title: "Date", value: quote.event_date_display || "—" },
    { title: "Guest", value: `${quote.guest_first_name} ${quote.guest_last_name}` },
    { title: "Email", value: quote.guest_email },
    { title: "Total", value: dollars(quote.total_cents) },
    { title: "Deposit", value: dollars(quote.deposit_due_cents) },
    { title: "Balance", value: dollars(quote.balance_cents) },
  ];

  if (quote.square_gift_card_gan) {
    facts.push({ title: "GAN", value: quote.square_gift_card_gan });
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
        text: `${quote.center_name} · Planner: ${plannerName}`,
        size: "small",
        isSubtle: true,
      },
      ...statusBanners,
      {
        type: "FactSet",
        facts,
      },
    ],
    actions: quote.contract_short_id
      ? [
          {
            type: "Action.OpenUrl",
            title: "View Contract",
            url: `${BASE_URL}/contract/${quote.contract_short_id}`,
          },
        ]
      : [],
  };
}

// ── Email HTML builders ─────────────────────────────────────────────

function emailShell(centerName: string, content: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b"><div style="max-width:600px;margin:0 auto;padding:24px"><div style="background:#0f172a;color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center"><h2 style="margin:0;font-size:20px">${centerName}</h2></div><div style="background:white;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">${content}</div><p style="text-align:center;font-size:12px;color:#94a3b8;margin-top:16px">${centerName}</p></div></body></html>`;
}

function buildContractSentEmailHtml(
  quote: GroupFunctionQuote,
  contractUrl: string,
  plannerName: string,
): string {
  return emailShell(
    quote.center_name,
    `<h3 style="margin:0 0 16px">Your Event Contract is Ready</h3>
    <p>Hi ${quote.guest_first_name},</p>
    <p>Your contract for <strong>${quote.event_name || "your event"}</strong> on <strong>${quote.event_date_display || ""}</strong> is ready for review.</p>
    <table style="width:100%;margin:16px 0;font-size:14px">
      <tr><td style="padding:4px 0;color:#64748b">Total</td><td style="padding:4px 0;text-align:right;font-weight:600">${dollars(quote.total_cents)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Deposit Due</td><td style="padding:4px 0;text-align:right;font-weight:600">${dollars(quote.deposit_due_cents)}</td></tr>
    </table>
    <div style="text-align:center;margin:24px 0"><a href="${contractUrl}" style="display:inline-block;padding:12px 32px;background:#0f172a;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px">Review & Sign</a></div>
    <p style="font-size:14px;color:#64748b">Questions? Contact ${plannerName}${quote.planner_phone ? ` at ${quote.planner_phone}` : ""}.</p>`,
  );
}

function buildDepositPaidEmailHtml(quote: GroupFunctionQuote): string {
  return emailShell(
    quote.center_name,
    `<h3 style="margin:0 0 16px">Deposit Received!</h3>
    <p>Hi ${quote.guest_first_name},</p>
    <p>Your deposit of <strong>${dollars(quote.deposit_due_cents)}</strong> for <strong>${quote.event_name || "your event"}</strong> has been received.</p>
    ${quote.square_gift_card_gan ? `<p style="font-size:14px;color:#64748b">Reference: <code>${quote.square_gift_card_gan}</code></p>` : ""}
    <table style="width:100%;margin:16px 0;font-size:14px">
      <tr><td style="padding:4px 0;color:#64748b">Event Date</td><td style="padding:4px 0;text-align:right">${quote.event_date_display || ""}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Deposit Paid</td><td style="padding:4px 0;text-align:right;color:#22c55e;font-weight:600">${dollars(quote.deposit_due_cents)}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Remaining Balance</td><td style="padding:4px 0;text-align:right">${dollars(quote.balance_cents)}</td></tr>
    </table>
    <p style="font-size:14px;color:#64748b">The remaining balance will be charged 72 hours before your event.</p>
    <p>See you at ${quote.center_name}!</p>`,
  );
}

function buildBalanceChargedEmailHtml(quote: GroupFunctionQuote): string {
  return emailShell(
    quote.center_name,
    `<h3 style="margin:0 0 16px">Payment Complete!</h3>
    <p>Hi ${quote.guest_first_name},</p>
    <p>Your remaining balance of <strong>${dollars(quote.total_cents - quote.deposit_due_cents)}</strong> for <strong>${quote.event_name || "your event"}</strong> has been charged.</p>
    <p style="font-size:18px;font-weight:700;text-align:center;margin:20px 0;color:#22c55e">You're all set!</p>
    <table style="width:100%;margin:16px 0;font-size:14px">
      <tr><td style="padding:4px 0;color:#64748b">Event</td><td style="padding:4px 0;text-align:right">${quote.event_name || ""}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Date</td><td style="padding:4px 0;text-align:right">${quote.event_date_display || ""}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b">Total Paid</td><td style="padding:4px 0;text-align:right;color:#22c55e;font-weight:600">${dollars(quote.total_cents)}</td></tr>
    </table>
    <p>See you at ${quote.center_name}!</p>`,
  );
}

function buildBalanceLinkEmailHtml(quote: GroupFunctionQuote): string {
  return emailShell(
    quote.center_name,
    `<h3 style="margin:0 0 16px">Balance Due</h3>
    <p>Hi ${quote.guest_first_name},</p>
    <p>Your remaining balance of <strong>${dollars(quote.balance_cents)}</strong> for <strong>${quote.event_name || "your event"}</strong> on <strong>${quote.event_date_display || ""}</strong> is due.</p>
    <div style="text-align:center;margin:24px 0"><a href="${quote.balance_payment_link_url}" style="display:inline-block;padding:12px 32px;background:#0f172a;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px">Pay ${dollars(quote.balance_cents)}</a></div>
    <p style="font-size:14px;color:#64748b">Questions? Contact us at ${quote.center_name}.</p>`,
  );
}
