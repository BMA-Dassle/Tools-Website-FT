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
