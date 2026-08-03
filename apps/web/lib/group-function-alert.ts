/**
 * Operational alerts for the group-function "Send Contract" pipeline.
 *
 * When a planner flips a BMI Office event to "Send Contract" but the data is
 * incomplete (no email / name / phone, planner email unset, or — at HPFM/FT —
 * the location selector left blank), the contract still gets sent ("proceed
 * anyway"), but the guest-facing email/SMS may not actually reach anyone and
 * nobody is told. These helpers post a Teams Adaptive Card to the assigned
 * planner's chat (falling back to Guest Services) so staff can fix the BMI data.
 *
 * Distinct from `group-function-notify.ts`, which handles *customer-facing*
 * comms. This module is staff-facing alerting only and is always best-effort:
 * a Teams failure here must never break the dispatch cron.
 */

import { createHash } from "crypto";
import { sendAdaptiveCardToChannel } from "@/lib/teams-bot";
import { GUEST_SERVICES_CHAT_ID, plannerChatIdForEmail } from "@/lib/sales-lead-config";
import redis from "@/lib/redis";
import type { HermesQueueItem } from "@/lib/hermes-client";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Centers that expose the HeadPinz-vs-FastTrax location selector in BMI. */
const FM_CENTER_CODES = new Set(["fort-myers", "fasttrax"]);

export interface ContractIssue {
  message: string;
  /**
   * Required guest-facing info that MUST be present before a contract goes out.
   * The dispatch cron hard-blocks the *initial* send when any blocking issue is
   * present and leaves the BMI project in "Send Contract" until it's fixed.
   * Non-blocking issues (e.g. planner email) are warning-only.
   */
  blocking: boolean;
}

/**
 * Inspect a scanned "Send Contract" item and return classified data problems
 * that would degrade (or silently break) the contract send. Each issue is
 * tagged `blocking` (required guest info) or not (soft / internal-only).
 * Empty array = nothing to alert on. Pure — no I/O.
 */
export function collectContractIssues(item: HermesQueueItem, centerCode: string): ContractIssue[] {
  const issues: ContractIssue[] = [];

  const email = (item.customer.email || "").trim();
  if (!email) {
    issues.push({ message: "Guest email is missing", blocking: true });
  } else if (!EMAIL_RE.test(email)) {
    issues.push({ message: `Guest email looks invalid: ${email}`, blocking: true });
  }

  const first = (item.customer.first || "").trim();
  const last = (item.customer.last || "").trim();
  if (!first || !last) {
    issues.push({ message: "Guest name is incomplete (first/last)", blocking: true });
  }

  const phoneDigits = (item.customer.phone || "").replace(/\D/g, "");
  if (phoneDigits.length < 10) {
    issues.push({
      message: "Guest phone is missing or invalid (no SMS will be sent)",
      blocking: true,
    });
  }

  if (!(item.planner.email || "").trim()) {
    // Internal-only: the guest still gets the contract (default sender, no CC),
    // so this warns but does not block the send.
    issues.push({
      message: "Planner email is not set (email sends from default sender, no CC)",
      blocking: false,
    });
  }

  if (FM_CENTER_CODES.has(centerCode) && !(item.location || "").trim()) {
    issues.push({
      message: "Location selector not set in BMI — defaulted to HeadPinz Fort Myers",
      blocking: true,
    });
  }

  return issues;
}

/**
 * Back-compat flat list of every issue message (blocking + warning), in the
 * same order as {@link collectContractIssues}. Used by the email-delivery-failed
 * alert and the unit tests.
 */
export function collectContractDataIssues(item: HermesQueueItem, centerCode: string): string[] {
  return collectContractIssues(item, centerCode).map((i) => i.message);
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

/**
 * De-dup gate. Returns true if this is the first time we've seen `key` within
 * `ttlSeconds` (and we should send), false if we've already alerted recently.
 * Fails OPEN — if Redis is unreachable we'd rather send a possible duplicate
 * than swallow the alert.
 */
async function shouldAlert(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    const res = await redis.set(key, "1", "EX", ttlSeconds, "NX");
    return res === "OK";
  } catch (err) {
    console.warn("[gf-alert] redis dedup failed (sending anyway):", err);
    return true;
  }
}

function resolveChatId(plannerEmail: string | null | undefined): string {
  return plannerChatIdForEmail(plannerEmail) || GUEST_SERVICES_CHAT_ID;
}

export interface AlertCardOpts {
  eyebrow: string;
  title: string;
  subtitle: string;
  headerStyle: "warning" | "attention";
  facts: Array<{ title: string; value: string }>;
  issues: string[];
  contractUrl?: string;
}

/** Exported for the smoke test so it can post (and clean up) the real card. */
export function buildAlertCard(opts: AlertCardOpts): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: "Container",
      style: opts.headerStyle,
      bleed: true,
      items: [
        {
          type: "TextBlock",
          text: opts.eyebrow,
          weight: "Bolder",
          size: "Small",
          spacing: "None",
          wrap: true,
        },
        {
          type: "TextBlock",
          text: opts.title,
          weight: "Bolder",
          size: "Large",
          spacing: "Small",
          wrap: true,
        },
        {
          type: "TextBlock",
          text: opts.subtitle,
          isSubtle: true,
          size: "Small",
          spacing: "None",
          wrap: true,
        },
      ],
    },
    { type: "FactSet", facts: opts.facts, spacing: "Small" },
    {
      type: "TextBlock",
      text: "Needs attention:",
      weight: "Bolder",
      size: "Small",
      spacing: "Medium",
      wrap: true,
    },
    ...opts.issues.map((i) => ({
      type: "TextBlock",
      text: `• ${i}`,
      wrap: true,
      size: "Small",
      spacing: "None",
      color: "Attention",
    })),
  ];

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    actions: opts.contractUrl
      ? [{ type: "Action.OpenUrl", title: "View Contract", url: opts.contractUrl }]
      : [],
  };
}

export interface ContractDataIssueParams {
  centerCode: string;
  centerName: string;
  reservationId: string;
  eventName: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  plannerEmail: string;
  /** Optional link to the internal contract page (when a short id exists). */
  contractUrl?: string;
  issues: string[];
  /**
   * Blocking mode: the contract was NOT sent because required info is missing,
   * and the BMI project stays in "Send Contract" until it's fixed. Changes the
   * card to a red "not sent" framing. Defaults to the softer "sent anyway" warning.
   */
  blocked?: boolean;
}

/**
 * Post a contract data-issue alert to Teams. In the default (warning) mode the
 * contract was sent anyway; in `blocked` mode it was NOT sent and is held in
 * "Send Contract". Best-effort and de-duped per (reservation, mode, issue-set)
 * for 6h so the every-2-min dispatch cron doesn't spam the same problem.
 * No-op when `issues` is empty. Returns `true` only when a card was actually
 * posted (not deduped / not failed) — callers use this to gate side effects
 * like a BMI note so they share the same 6h throttle.
 */
export async function notifyContractDataIssues(params: ContractDataIssueParams): Promise<boolean> {
  if (!params.issues.length) return false;

  const ns = params.blocked ? "blocked" : "data";
  const dedupKey = `gf:alert:${ns}:${params.reservationId}:${shortHash([...params.issues].sort().join("|"))}`;
  if (!(await shouldAlert(dedupKey, 6 * 60 * 60))) return false;

  const card = buildAlertCard({
    eyebrow: params.blocked
      ? `⛔ CONTRACT NOT SENT — MISSING REQUIRED INFO · BMI #${params.reservationId}`
      : `⚠ CONTRACT SENT WITH MISSING INFO · BMI #${params.reservationId}`,
    title: params.eventName || "(unnamed event)",
    subtitle: params.blocked
      ? `${params.centerName} · Planner: ${params.plannerEmail || "unassigned"} · Fix in BMI and it sends automatically`
      : `${params.centerName} · Planner: ${params.plannerEmail || "unassigned"}`,
    headerStyle: params.blocked ? "attention" : "warning",
    facts: [
      { title: "Guest", value: params.guestName.trim() || "—" },
      { title: "Email", value: params.guestEmail || "— (missing)" },
      { title: "Phone", value: params.guestPhone || "— (missing)" },
      { title: "Planner", value: params.plannerEmail || "— (unassigned)" },
      { title: "Center", value: params.centerName },
      { title: "BMI #", value: params.reservationId },
    ],
    issues: params.issues,
    contractUrl: params.contractUrl,
  });

  try {
    await sendAdaptiveCardToChannel(resolveChatId(params.plannerEmail), card, {
      summaryText: params.blocked
        ? `⛔ ${params.eventName || "Event"}: contract NOT sent — fix required info`
        : `⚠ ${params.eventName || "Event"}: contract sent with missing info`,
    });
    return true;
  } catch (err) {
    console.error(
      `[gf-alert] data-issue card failed for reservation=${params.reservationId}:`,
      err,
    );
    return false;
  }
}

export interface TaxExemptNoCertificateParams {
  centerName: string;
  reservationId: string;
  eventNumber: string | null;
  eventName: string;
  eventDateDisplay: string | null;
  guestName: string;
  guestEmail: string;
  plannerEmail: string | null;
  totalCents: number;
  /** Contract page — where staff can hand the guest the DR-14 upload. */
  contractUrl?: string;
  /** True once the guest has signed: the upload gate can no longer catch this. */
  signed: boolean;
}

/**
 * Post a "tax exempt but no DR-14 on file" alert to Teams.
 *
 * The contract page hard-requires the certificate at SIGN time (`taxValid` in
 * ContractClient), so a correctly-flagged event cannot be signed without one.
 * This covers the cases that gate can never see:
 *   - the event was made exempt in BMI AFTER the guest signed
 *   - the flag was stale at sign time, so the guest was never asked
 *     (12 events, ~$25k, discovered 2026-08-03)
 *
 * Callers derive the exempt condition from `line_items` — NOT `is_tax_exempt` —
 * because that flag is exactly what goes stale. Products are re-synced on every
 * dispatch pass, so they are the trustworthy signal.
 *
 * Best-effort and re-armed weekly per (reservation, signed-state): this is a
 * nag, not a notification. It should keep reappearing until the document
 * actually lands, unlike the 6h data-issue throttle.
 */
export async function notifyTaxExemptNoCertificate(
  params: TaxExemptNoCertificateParams,
): Promise<boolean> {
  const dedupKey = `gf:alert:taxdoc:${params.reservationId}:${params.signed ? "signed" : "unsigned"}`;
  if (!(await shouldAlert(dedupKey, 7 * 24 * 60 * 60))) return false;

  const card = buildAlertCard({
    eyebrow: `⚠ TAX EXEMPT — NO DR-14 ON FILE · BMI #${params.reservationId}`,
    title: params.eventName || "(unnamed event)",
    subtitle:
      `${params.centerName} · Planner: ${params.plannerEmail || "unassigned"} · ` +
      (params.signed ? "Already signed — collect the certificate" : "Collect before the event"),
    headerStyle: "warning",
    facts: [
      { title: "Event #", value: params.eventNumber || "—" },
      { title: "Date", value: params.eventDateDisplay || "—" },
      { title: "Guest", value: params.guestName.trim() || "—" },
      { title: "Email", value: params.guestEmail || "—" },
      { title: "Total", value: `$${(params.totalCents / 100).toFixed(2)}` },
      { title: "Tax charged", value: "$0.00 (exempt)" },
    ],
    issues: [
      "BMI products include “GF Tax Exempt”, so no sales tax was charged.",
      "No DR-14 exemption certificate has been uploaded for this event.",
      params.signed
        ? "The contract is already signed, so the guest will not be asked automatically — request the certificate directly."
        : "The guest will be asked to upload it when they sign.",
    ],
    contractUrl: params.contractUrl,
  });

  try {
    await sendAdaptiveCardToChannel(resolveChatId(params.plannerEmail), card, {
      summaryText: `⚠ ${params.eventName || "Event"}: tax exempt with no DR-14 on file`,
    });
    return true;
  } catch (err) {
    console.error(`[gf-alert] tax-doc card failed for reservation=${params.reservationId}:`, err);
    return false;
  }
}

export interface GiftCardDrainFailedParams {
  reservationId: string;
  eventNumber: string | null;
  eventName: string;
  centerName: string | null;
  plannerEmail?: string | null;
  /** Cards we could NOT zero, with the balance still sitting on them. */
  stranded: Array<{ gan: string; giftCardId: string; balanceCents: number; error?: string }>;
  refundedCents: number;
}

/**
 * A cancelled event's deposit was refunded to the card but its internal deposit
 * gift card could not be zeroed — the same dollars now exist twice until someone
 * adjusts the card down in the Square dashboard.
 *
 * Deliberately NOT de-duped away to nothing: keyed per (reservation, card) for 6h
 * so it re-pings until fixed. The guest is never blocked on this — their refund
 * has already gone out — but the value is live on an instrument our own day-of
 * cron knows how to redeem, so it has to be reconciled by hand.
 */
export async function notifyGiftCardDrainFailed(
  params: GiftCardDrainFailedParams,
): Promise<boolean> {
  if (params.stranded.length === 0) return false;
  const dedupKey = `gf:alert:gcdrain:${params.reservationId}:${shortHash(
    params.stranded.map((s) => s.giftCardId).join(","),
  )}`;
  if (!(await shouldAlert(dedupKey, 6 * 60 * 60))) return false;

  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const card = buildAlertCard({
    eyebrow: `⛔ GIFT CARD NOT ZEROED · BMI #${params.reservationId}`,
    title: "Cancelled event refunded — deposit card still holds value",
    subtitle: `${params.eventName || "Group event"}${
      params.centerName ? ` · ${params.centerName}` : ""
    }`,
    headerStyle: "attention",
    facts: [
      { title: "BMI #", value: params.reservationId },
      { title: "Event #", value: params.eventNumber || "—" },
      { title: "Refunded to card", value: money(params.refundedCents) },
      {
        title: "Still on gift card",
        value: money(params.stranded.reduce((s, x) => s + x.balanceCents, 0)),
      },
    ],
    issues: [
      ...params.stranded.map(
        (s) =>
          `${s.gan || s.giftCardId} still holds ${money(s.balanceCents)}` +
          (s.error ? ` — ${s.error}` : ""),
      ),
      "Zero these cards in Square (Gift Cards → Adjust balance) so the refunded " +
        "money is not also redeemable at the event.",
    ],
  });

  try {
    await sendAdaptiveCardToChannel(resolveChatId(params.plannerEmail), card, {
      summaryText: `⛔ Deposit gift card still funded after refund — BMI #${params.reservationId}`,
    });
    return true;
  } catch (err) {
    console.error(
      `[gf-alert] gift-card drain card failed for reservation=${params.reservationId}:`,
      err,
    );
    return false;
  }
}

export interface DispatchErrorParams {
  reservationId: string;
  centerCode?: string;
  centerName?: string;
  plannerEmail?: string;
  error: unknown;
}

/**
 * Post an unexpected dispatch/scan error to Teams. De-duped per
 * (reservation, error-message) for 1h so a persistent failure re-pings hourly
 * rather than every 2 minutes. Best-effort.
 */
export async function notifyDispatchError(params: DispatchErrorParams): Promise<void> {
  const msg = (params.error instanceof Error ? params.error.message : String(params.error)).slice(
    0,
    800,
  );

  const dedupKey = `gf:alert:error:${params.reservationId}:${shortHash(msg)}`;
  if (!(await shouldAlert(dedupKey, 60 * 60))) return;

  const card = buildAlertCard({
    eyebrow: `⛔ CONTRACT DISPATCH ERROR · BMI #${params.reservationId}`,
    title: "Failed to process a 'Send Contract' event",
    subtitle: params.centerName || params.centerCode || "Group functions",
    headerStyle: "attention",
    facts: [
      { title: "BMI #", value: params.reservationId },
      { title: "Center", value: params.centerName || params.centerCode || "—" },
    ],
    issues: [msg],
  });

  try {
    await sendAdaptiveCardToChannel(resolveChatId(params.plannerEmail), card, {
      summaryText: `⛔ Dispatch error on BMI #${params.reservationId}`,
    });
  } catch (err) {
    console.error(
      `[gf-alert] dispatch-error card failed for reservation=${params.reservationId}:`,
      err,
    );
  }
}
