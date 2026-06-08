/**
 * Group-event reminder RULES.
 *
 * Declarative generalization of the one-off reminder crons (group-7day-waiver,
 * group-96hr-reminder, …). Each rule describes WHEN it fires (status + an
 * event_date window), WHO is eligible, and HOW to send. A single dispatcher
 * cron (app/api/cron/group-event-reminders) evaluates every rule, dedups via
 * contract_audit_log (the existing NOT EXISTS gate), and records a ledger row.
 *
 * Adding a reminder = adding a rule here. No new cron file.
 */
import type { GroupFunctionQuote, GfQuoteStatus } from "@/lib/group-function-db";

export type ReminderChannel = "email" | "sms";

export interface RuleContext {
  quote: GroupFunctionQuote;
  /** Lazily-resolved, memoized BMI waiver URL for this quote. */
  getWaiverUrl: () => Promise<string | null>;
  /** All contract_audit_log event names already recorded for this quote. */
  firedEvents: ReadonlySet<string>;
  /** false during SMS quiet hours — send() should suppress SMS but still email. */
  allowSms: boolean;
  dryRun: boolean;
}

export interface RuleSendResult {
  channelsAttempted: ReminderChannel[];
  emailOk?: boolean;
  smsOk?: boolean | null;
  providerMessageId?: string;
  error?: string;
}

export interface ReminderRule {
  key: string;
  label: string;
  channels: ReminderChannel[];
  statuses: GfQuoteStatus[];
  /** Window relative to NOW(), in hours, against event_date. Negative = post-event. */
  window: { minHours: number; maxHours: number };
  /** contract_audit_log event used for the NOT-EXISTS dedup gate. Defaults to key. */
  dedupKey?: string;
  /** Exclude win-back events (they have their own offer rule). */
  excludeWinback?: boolean;
  /** Only win-back events. */
  winbackOnly?: boolean;
  /** Per-rule kill switch env var (truthy = enabled). Absent = always on. */
  enableEnv?: string;
  /** Drip rule: dedups per-occurrence (dedupKey:occurrence) instead of once. */
  recurring?: boolean;
  /** For recurring rules: the current occurrence suffix, or null to skip now. */
  occurrenceFor?: (quote: GroupFunctionQuote) => string | null;
  eligible?: (ctx: RuleContext) => boolean | Promise<boolean>;
  send: (ctx: RuleContext) => Promise<RuleSendResult>;
}

// ── shared helpers ───────────────────────────────────────────────────

const CLIENT_KEYS: Record<string, string> = {
  "fort-myers": "headpinzftmyers",
  fasttrax: "headpinzftmyers",
  naples: "headpinznaples",
};

export function hasBalanceDue(quote: GroupFunctionQuote): boolean {
  return quote.total_cents - quote.collected_cents > 0;
}

export async function hasWaiver(quote: GroupFunctionQuote): Promise<boolean> {
  const { hasWaiverRequiredActivities } = await import("@/lib/bmi-office-actions");
  return hasWaiverRequiredActivities((quote.line_items || []) as Array<{ name: string }>);
}

/** Centralizes the waiver-URL logic duplicated across the legacy reminder crons. */
export async function buildWaiverUrl(quote: GroupFunctionQuote): Promise<string | null> {
  try {
    const { fetchProject } = await import("@/lib/bmi-office-actions");
    const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
    if (project?.projectReference) {
      const ck = CLIENT_KEYS[quote.center_code] || "headpinzftmyers";
      return `https://kiosk.sms-timing.com/${ck}/subscribe/event?id=${encodeURIComponent(String(project.projectReference))}`;
    }
  } catch {
    /* non-fatal */
  }
  return null;
}

const PLACEHOLDER_PHONES = new Set(["2222222222"]);
/** Pandora placeholder guard (DRIVER 1 PLACEHOLDER phone). */
export function isPandoraPlaceholder(quote: GroupFunctionQuote): boolean {
  const digits = (quote.guest_phone || "").replace(/\D/g, "").replace(/^1/, "");
  return PLACEHOLDER_PHONES.has(digits);
}

const truthy = (v: string | undefined) => /^(1|true|on|yes)$/i.test(v || "");

export function isEngineKilled(): boolean {
  return truthy(process.env.GF_REMINDERS_KILL);
}

export function isRuleEnabled(rule: ReminderRule): boolean {
  return rule.enableEnv ? truthy(process.env[rule.enableEnv]) : true;
}

/** True if NOW (America/New_York) is within the SMS quiet-hours window. */
export function withinQuietHours(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  let hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  if (hour === 24) hour = 0;
  const start = Number(process.env.GF_SMS_QUIET_START || 21); // 9pm ET
  const end = Number(process.env.GF_SMS_QUIET_END || 9); // 9am ET
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

// ── rule send() implementations ──────────────────────────────────────

function payUrl(quote: GroupFunctionQuote, src: string): string {
  return (
    quote.balance_payment_link_url ||
    `${quote.base_url || "https://fasttraxent.com"}/contract/${quote.contract_short_id}?src=${src}`
  );
}

async function sendPaymentDue(ctx: RuleContext, daysOut: number): Promise<RuleSendResult> {
  const { notifyPaymentDueReminder } = await import("@/lib/group-function-notify");
  const res = await notifyPaymentDueReminder(
    ctx.quote,
    daysOut,
    payUrl(ctx.quote, `email_paydue_t${daysOut}`),
    {
      smsSuppressed: !ctx.allowSms,
    },
  );
  return {
    channelsAttempted: ctx.allowSms ? ["email", "sms"] : ["email"],
    emailOk: res.emailOk,
    smsOk: res.smsOk,
    providerMessageId: res.smsId,
  };
}

async function sendWaiver(ctx: RuleContext, kind: "7day" | "2day"): Promise<RuleSendResult> {
  const url = await ctx.getWaiverUrl();
  if (!url) return { channelsAttempted: [], error: "no waiver url" };
  const notify = await import("@/lib/group-function-notify");
  if (kind === "7day") await notify.notify7DayWaiverReminder(ctx.quote, url);
  else await notify.notify2DayWaiverWarning(ctx.quote, url);
  // Legacy builders return void; record optimistic success for the ledger.
  return { channelsAttempted: ["email", "sms"], emailOk: true, smsOk: true };
}

// ── registry ─────────────────────────────────────────────────────────

export const RULES: ReminderRule[] = [
  // Payment-due nudges — only events that must pay manually (no saved card),
  // never win-back (own offer rule). Dark-launched until enabled.
  {
    key: "rem_payment_due_t14",
    label: "Payment due — 14 days out",
    channels: ["email", "sms"],
    statuses: ["deposit_paid", "balance_link_sent"],
    window: { minHours: 13 * 24, maxHours: 15 * 24 },
    excludeWinback: true,
    enableEnv: "GF_REMINDER_PAYMENT_DUE_ENABLED",
    eligible: (ctx) => hasBalanceDue(ctx.quote) && !ctx.quote.saved_card_id,
    send: (ctx) => sendPaymentDue(ctx, 14),
  },
  {
    key: "rem_payment_due_t7",
    label: "Payment due — 7 days out",
    channels: ["email", "sms"],
    statuses: ["deposit_paid", "balance_link_sent"],
    window: { minHours: 6 * 24, maxHours: 8 * 24 },
    excludeWinback: true,
    enableEnv: "GF_REMINDER_PAYMENT_DUE_ENABLED",
    eligible: (ctx) => hasBalanceDue(ctx.quote) && !ctx.quote.saved_card_id,
    send: (ctx) => sendPaymentDue(ctx, 7),
  },
  // Waiver reminders — reuse the LEGACY dedup keys so they no-op against the
  // old crons during the parallel/shadow phase (zero double-send).
  {
    key: "rem_waiver_t7",
    label: "Waiver reminder — 7 days out",
    channels: ["email", "sms"],
    statuses: ["deposit_paid", "balance_charged", "balance_link_sent"],
    window: { minHours: 6 * 24, maxHours: 8 * 24 },
    dedupKey: "7day_waiver_sent",
    eligible: (ctx) => hasWaiver(ctx.quote),
    send: (ctx) => sendWaiver(ctx, "7day"),
  },
  {
    key: "rem_waiver_t2",
    label: "Waiver warning — 2 days out",
    channels: ["email", "sms"],
    statuses: ["deposit_paid", "balance_charged", "balance_link_sent"],
    window: { minHours: 36, maxHours: 60 },
    dedupKey: "2day_waiver_sent",
    eligible: (ctx) => hasWaiver(ctx.quote),
    send: (ctx) => sendWaiver(ctx, "2day"),
  },
  // Post-event thank-you (email only). Dark-launched until enabled.
  {
    key: "rem_thank_you",
    label: "Post-event thank-you",
    channels: ["email"],
    statuses: ["balance_charged", "completed"],
    window: { minHours: -36, maxHours: -12 },
    enableEnv: "GF_REMINDER_THANKYOU_ENABLED",
    send: async (ctx) => {
      const { notifyThankYou } = await import("@/lib/group-function-notify");
      const res = await notifyThankYou(ctx.quote);
      return { channelsAttempted: ["email"], emailOk: res.emailOk, smsOk: null };
    },
  },
  // Dedicated "final headcount" call ~5 days out — a clean standalone touch
  // BEFORE the 96h balance/charge reminder, so the two never collide. The
  // guest count can still change the total here (balance not yet charged).
  {
    key: "rem_headcount_final",
    label: "Final headcount call (~5 days out)",
    channels: ["email", "sms"],
    statuses: ["deposit_paid", "balance_link_sent"],
    window: { minHours: 108, maxHours: 156 }, // ~4.5–6.5 days out; clear of the 72–96h balance reminder
    enableEnv: "GF_REMINDER_HEADCOUNT_ENABLED",
    eligible: (ctx) => !ctx.quote.balance_paid_at,
    send: async (ctx) => {
      const { notifyHeadcountFinal } = await import("@/lib/group-function-notify");
      const res = await notifyHeadcountFinal(ctx.quote, { smsSuppressed: !ctx.allowSms });
      return {
        channelsAttempted: ctx.allowSms ? ["email", "sms"] : ["email"],
        emailOk: res.emailOk,
        smsOk: res.smsOk,
        providerMessageId: res.smsId,
      };
    },
  },
  // $20 legacy win-back drip. Ingestion sends occurrence 0 and records
  // `rem_winback_offer:0`; this re-sends weekly (occ 1, 2) until paid or
  // 3 total sends. Gated behind GF_WINBACK_ENABLED. Window is effectively
  // "any future event" — the offer isn't anchored to event proximity.
  {
    key: "rem_winback_offer",
    label: "$20 win-back offer (drip)",
    channels: ["email", "sms"],
    statuses: ["contract_sent"],
    window: { minHours: 0, maxHours: 24 * 400 },
    winbackOnly: true,
    recurring: true,
    enableEnv: "GF_WINBACK_ENABLED",
    occurrenceFor: (q) => {
      if (!q.contract_sent_at) return null;
      const days = (Date.now() - new Date(q.contract_sent_at).getTime()) / 86_400_000;
      const occ = Math.floor(days / 7); // 0 (ingestion), 1 (+7d), 2 (+14d)
      return occ >= 3 ? null : String(occ);
    },
    // Re-offer only while they still haven't added a card / completed.
    eligible: (ctx) => !ctx.quote.saved_card_id && !ctx.quote.deposit_paid_at,
    send: async (ctx) => {
      const { notifyWinbackOffer } = await import("@/lib/group-function-notify");
      const res = await notifyWinbackOffer(ctx.quote, { smsSuppressed: !ctx.allowSms });
      return {
        channelsAttempted: ctx.allowSms ? ["email", "sms"] : ["email"],
        emailOk: res.emailOk,
        smsOk: res.smsOk,
        providerMessageId: res.smsId,
      };
    },
  },
];
