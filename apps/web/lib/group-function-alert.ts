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

/**
 * Inspect a scanned "Send Contract" item and return a list of human-readable
 * data problems that would degrade (or silently break) the contract send.
 * Empty array = nothing to alert on. Pure — no I/O.
 */
export function collectContractDataIssues(item: HermesQueueItem, centerCode: string): string[] {
  const issues: string[] = [];

  const email = (item.customer.email || "").trim();
  if (!email) {
    issues.push("Guest email is missing");
  } else if (!EMAIL_RE.test(email)) {
    issues.push(`Guest email looks invalid: ${email}`);
  }

  const first = (item.customer.first || "").trim();
  const last = (item.customer.last || "").trim();
  if (!first || !last) {
    issues.push("Guest name is incomplete (first/last)");
  }

  const phoneDigits = (item.customer.phone || "").replace(/\D/g, "");
  if (phoneDigits.length < 10) {
    issues.push("Guest phone is missing or invalid (no SMS will be sent)");
  }

  if (!(item.planner.email || "").trim()) {
    issues.push("Planner email is not set (email sends from default sender, no CC)");
  }

  if (FM_CENTER_CODES.has(centerCode) && !(item.location || "").trim()) {
    issues.push("Location selector not set in BMI — defaulted to HeadPinz Fort Myers");
  }

  return issues;
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
}

/**
 * Post a "contract sent with missing info" warning to Teams. Best-effort and
 * de-duped per (reservation, issue-set) for 6h so the every-2-min dispatch cron
 * doesn't spam the same problem. No-op when `issues` is empty.
 */
export async function notifyContractDataIssues(params: ContractDataIssueParams): Promise<void> {
  if (!params.issues.length) return;

  const dedupKey = `gf:alert:data:${params.reservationId}:${shortHash([...params.issues].sort().join("|"))}`;
  if (!(await shouldAlert(dedupKey, 6 * 60 * 60))) return;

  const card = buildAlertCard({
    eyebrow: `⚠ CONTRACT SENT WITH MISSING INFO · BMI #${params.reservationId}`,
    title: params.eventName || "(unnamed event)",
    subtitle: `${params.centerName} · Planner: ${params.plannerEmail || "unassigned"}`,
    headerStyle: "warning",
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
      summaryText: `⚠ ${params.eventName || "Event"}: contract sent with missing info`,
    });
  } catch (err) {
    console.error(
      `[gf-alert] data-issue card failed for reservation=${params.reservationId}:`,
      err,
    );
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
