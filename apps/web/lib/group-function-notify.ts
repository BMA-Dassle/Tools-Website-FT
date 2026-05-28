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
import { updateGfTeamsCard } from "@/lib/group-function-db";

const FALLBACK_URL = "https://fasttraxent.com";

function baseUrl(quote: GroupFunctionQuote): string {
  return quote.base_url || FALLBACK_URL;
}
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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

// ── Contract Sent ───────────────────────────────────────────────────

export async function notifyContractSent(quote: GroupFunctionQuote): Promise<void> {
  const contractUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}`;
  const pName = plannerName(quote);

  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event contract for ${quote.event_name || "your event"} at ${quote.center_name} is ready!`,
            `Review & sign here: ${contractUrl}`,
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
}

// ── Contract Updated (before signing) ───────────────────────────────

export async function notifyContractUpdated(quote: GroupFunctionQuote): Promise<void> {
  const contractUrl = `${baseUrl(quote)}/contract/${quote.contract_short_id}`;
  const pName = plannerName(quote);

  const results = await Promise.allSettled([
    quote.guest_phone
      ? voxSend(
          quote.guest_phone,
          [
            `${quote.guest_first_name}, your event contract for ${quote.event_name || "your event"} has been updated.`,
            `Review the changes here: ${contractUrl}`,
          ].join("\n"),
        )
      : Promise.resolve(),

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
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
}

// ── Deposit Paid ────────────────────────────────────────────────────

export async function notifyDepositPaid(quote: GroupFunctionQuote): Promise<void> {
  const results = await Promise.allSettled([
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

    sendEmail({
      to: quote.guest_email,
      toName: `${quote.guest_first_name} ${quote.guest_last_name}`,
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
      subject: `Deposit Received — ${quote.event_name || quote.center_name}`,
      html: buildDepositPaidHtml(quote),
      text: `Hi ${quote.guest_first_name},\n\nYour deposit of ${dollars(quote.deposit_due_cents)} has been received for ${quote.event_name}.\n\nReference: ${quote.square_gift_card_gan || "N/A"}\nRemaining balance: ${dollars(quote.balance_cents)}\n\nThe remaining balance will be charged 72 hours before your event.\n\nThank you!\n${quote.center_name}`,
    }),

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
      from: plannerFrom(quote),
      replyTo: quote.planner_email || undefined,
      cc: plannerCc(quote),
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
        text: `${quote.center_name} · Planner: ${pName}`,
        size: "small",
        isSubtle: true,
      },
      ...statusBanners,
      { type: "FactSet", facts },
    ],
    actions: quote.contract_short_id
      ? [{ type: "Action.OpenUrl", title: "View Contract", url: `${baseUrl(quote)}/contract/${quote.contract_short_id}` }]
      : [],
  };
}

// ── Premium Email HTML ──────────────────────────────────────────────

function emailShell(quote: GroupFunctionQuote, heroTitle: string, heroSubtitle: string, content: string): string {
  const pName = plannerName(quote);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a1020;color:#e2e8f0">
<div style="max-width:600px;margin:0 auto">

  <!-- Hero -->
  <div style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:40px 24px 32px;text-align:center;border-radius:16px 16px 0 0">
    <img src="${BLOB}/subpages/group-events-hero.webp" alt="" style="width:100%;max-height:160px;object-fit:cover;border-radius:8px;margin-bottom:20px" />
    <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:white">${heroTitle}</h1>
    <p style="margin:0;font-size:15px;color:#94a3b8">${heroSubtitle}</p>
  </div>

  <!-- Content -->
  <div style="background:#1e293b;padding:28px 24px;border-left:1px solid rgba(148,163,184,0.1);border-right:1px solid rgba(148,163,184,0.1)">
    ${content}
  </div>

  <!-- Event summary bar -->
  <div style="background:#0f172a;padding:16px 24px;border:1px solid rgba(148,163,184,0.1);border-top:none">
    <table style="width:100%;font-size:13px;color:#94a3b8"><tr>
      <td style="padding:4px 0"><strong style="color:white">${quote.event_name || "Event"}</strong></td>
      <td style="padding:4px 0;text-align:right">${quote.event_date_display || ""}</td>
    </tr><tr>
      <td style="padding:4px 0">${quote.center_name}</td>
      <td style="padding:4px 0;text-align:right">Total: <strong style="color:white">${dollars(quote.total_cents)}</strong></td>
    </tr></table>
  </div>

  <!-- Planner footer -->
  <div style="background:#1e293b;padding:20px 24px;border-radius:0 0 16px 16px;border:1px solid rgba(148,163,184,0.1);border-top:none">
    <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#64748b">Your Event Planner</p>
    <p style="margin:0 0 4px;font-size:16px;font-weight:700;color:white">${pName}</p>
    ${quote.planner_phone ? `<p style="margin:0;font-size:13px"><a href="tel:${quote.planner_phone}" style="color:#22d3ee;text-decoration:none">${quote.planner_phone}</a></p>` : ""}
    ${quote.planner_email ? `<p style="margin:0;font-size:13px"><a href="mailto:${quote.planner_email}" style="color:#22d3ee;text-decoration:none">${quote.planner_email}</a></p>` : ""}
  </div>

  <p style="text-align:center;font-size:11px;color:#475569;margin-top:16px;padding:0 24px">${quote.center_name} · <a href="${baseUrl(quote)}" style="color:#475569">${quote.brand === "headpinz" ? "headpinz.com" : "fasttraxent.com"}</a></p>
</div>
</body></html>`;
}

function ctaButton(text: string, url: string): string {
  return `<div style="text-align:center;margin:24px 0"><a href="${url}" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#06b6d4,#2563eb);color:white;text-decoration:none;border-radius:999px;font-weight:700;font-size:16px;letter-spacing:0.5px">${text}</a></div>`;
}

function pricingRow(label: string, value: string, highlight?: boolean): string {
  return `<tr><td style="padding:6px 0;color:#94a3b8;font-size:14px">${label}</td><td style="padding:6px 0;text-align:right;font-size:14px;font-weight:${highlight ? "700" : "600"};color:${highlight ? "#22d3ee" : "white"}">${value}</td></tr>`;
}

function buildContractSentHtml(quote: GroupFunctionQuote, contractUrl: string): string {
  return emailShell(
    quote,
    `${quote.guest_first_name}, your experience awaits`,
    `Your event contract is ready to review and sign`,
    `<p style="margin:0 0 16px;font-size:15px;color:#cbd5e1">We're excited to host <strong style="color:white">${quote.event_name || "your event"}</strong> at ${quote.center_name}! Review the details below and sign your contract to lock in your date.</p>

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
    `<p style="margin:0 0 16px;font-size:15px;color:#cbd5e1">${quote.guest_first_name}, your event planner has updated the details for <strong style="color:white">${quote.event_name || "your event"}</strong>. Please review the updated contract and sign to confirm.</p>

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
    `<p style="margin:0 0 16px;font-size:15px;color:#cbd5e1">Great news, ${quote.guest_first_name}! Your deposit has been received and your event date is locked in.</p>

    <div style="background:#0f172a;border-radius:12px;padding:20px;margin:16px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Deposit Paid</p>
      <p style="margin:0;font-size:32px;font-weight:800;color:#22d3ee">${dollars(quote.deposit_due_cents)}</p>
      ${quote.square_gift_card_gan ? `<p style="margin:8px 0 0;font-size:12px;font-family:monospace;color:#64748b">Ref: ${quote.square_gift_card_gan}</p>` : ""}
    </div>

    <table style="width:100%;margin:16px 0;border-collapse:collapse">
      ${pricingRow("Event Date", quote.event_date_display || "")}
      ${pricingRow("Deposit Paid", dollars(quote.deposit_due_cents), true)}
      ${quote.balance_cents > 0 ? pricingRow("Remaining Balance", dollars(quote.balance_cents)) : ""}
    </table>

    ${quote.balance_cents > 0 ? `<p style="margin:0;font-size:13px;color:#64748b;text-align:center">The remaining balance will be automatically charged 72 hours before your event.</p>` : ""}`,
  );
}

function buildBalanceChargedHtml(quote: GroupFunctionQuote): string {
  return emailShell(
    quote,
    "You're All Set!",
    `Payment complete for ${quote.event_name || "your event"}`,
    `<p style="margin:0 0 16px;font-size:15px;color:#cbd5e1">${quote.guest_first_name}, your remaining balance has been charged. Everything is paid and you're ready to go!</p>

    <div style="background:#0f172a;border-radius:12px;padding:20px;margin:16px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Total Paid</p>
      <p style="margin:0;font-size:32px;font-weight:800;color:#22c55e">${dollars(quote.total_cents)}</p>
    </div>

    <table style="width:100%;margin:16px 0;border-collapse:collapse">
      ${pricingRow("Event", quote.event_name || "")}
      ${pricingRow("Date", quote.event_date_display || "")}
      ${pricingRow("Total Paid", dollars(quote.total_cents), true)}
    </table>

    <p style="margin:16px 0 0;font-size:15px;color:#cbd5e1;text-align:center">See you at <strong style="color:white">${quote.center_name}</strong>!</p>`,
  );
}

function buildBalanceLinkHtml(quote: GroupFunctionQuote): string {
  return emailShell(
    quote,
    "Balance Due",
    `Complete your payment for ${quote.event_name || "your event"}`,
    `<p style="margin:0 0 16px;font-size:15px;color:#cbd5e1">${quote.guest_first_name}, your event is coming up and the remaining balance is due.</p>

    <div style="background:#0f172a;border-radius:12px;padding:20px;margin:16px 0;text-align:center">
      <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Balance Due</p>
      <p style="margin:0;font-size:32px;font-weight:800;color:#f59e0b">${dollars(quote.balance_cents)}</p>
    </div>

    ${ctaButton(`Pay ${dollars(quote.balance_cents)}`, quote.balance_payment_link_url || "#")}

    <p style="margin:0;font-size:13px;color:#64748b;text-align:center">Questions? Reply to this email or contact your planner.</p>`,
  );
}
