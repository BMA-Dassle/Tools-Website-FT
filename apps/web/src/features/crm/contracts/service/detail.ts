/**
 * One contract, everything the Contract / Payments / History tabs need, in as
 * few reads as the data allows:
 *
 *   `contractDetail`  — the row, the line items, the version chain with its
 *                       diffs, the audit ledger, the notification ledger and
 *                       the reminder rules a director may fire. All Neon.
 *   `contractPayments`— the LIVE Square timeline. Its own call, because it is
 *                       four HTTP round trips to Square and the tab must open
 *                       whether or not Square answers. A failure comes back as
 *                       `error`, never as an empty timeline pretending to be
 *                       "no payments".
 *   `contractHistory` — the audit + versions + milestones rail that the
 *                       reservations-admin board already builds
 *                       (`daily-events/service.ts getContractHistory`), reused
 *                       rather than rebuilt so the two boards agree.
 *
 * `cancelPending` is read, never guessed: a cancel whose `-4` re-read did not
 * confirm leaves a `contract-cancel-verify` job outstanding and writes NO
 * "cancelled" audit row. While that job is unresolved the deal says "Cancel
 * pending"; when it finally proves the state it writes the audit row itself
 * and this reads false again.
 */

import { getJobByIdempotencyKey } from "~/features/crm/jobs";
import type { ContractHistoryEntry, SquareTimelineNode } from "~/features/daily-events/types";
import { CENTRE_LIST } from "../../core/centres";
import type {
  ContractAuditView,
  ContractDetail,
  ContractLineItem,
  ContractNotificationView,
  ContractVersionView,
} from "../contracts";
import {
  RULES,
  diffVersionsAgainstLive,
  extractContractSnapshot,
  fetchProjectRaw,
  getAuditLog,
  getContractHistory,
  getContractVersions,
  getEventNotifications,
  getGfQuoteByShortId,
  getSquareTimeline,
  type GroupFunctionQuote,
} from "../transport";
import { auditDetail, auditLabel, notificationRuleLabel } from "./labels";
import { rowContext } from "./list";
import { toContractRow } from "./rows";

export const CONTRACT_AUDIT_ENTITY = "contract";

/**
 * `center_code` → the Office tenant; Fort Myers is the fallback, as elsewhere.
 * FT and HPFM deliberately share `headpinzftmyers` — they are one Office
 * tenant with two centres, which is why the map is by centerCode and not by
 * centre code.
 *
 * Lives HERE, not in `actions.ts`, only because `actions.ts` already imports
 * this module (`cancelVerifyJobKey`) — one definition, and no import cycle.
 * `actions.ts` re-exports it under its original name.
 */
export function clientKeyForCenterCode(centerCode: string): string {
  return CENTRE_LIST.find((c) => c.centerCode === centerCode)?.clientKey ?? "headpinzftmyers";
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : "";
}

/** `line_items` are `{name, price, qty, total}` in DOLLARS; the CRM speaks cents. */
export function toLineItems(raw: unknown): ContractLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const li = (item ?? {}) as { name?: unknown; price?: unknown; qty?: unknown; total?: unknown };
    const qty = Number(li.qty) || 0;
    const unit = Number(li.price) || 0;
    const total = li.total === undefined ? unit * qty : Number(li.total) || 0;
    return {
      name: typeof li.name === "string" ? li.name : "Item",
      qty,
      unitCents: Math.round(unit * 100),
      totalCents: Math.round(total * 100),
    };
  });
}

export function guestUrlFor(quote: GroupFunctionQuote): string | null {
  if (!quote.contract_short_id) return null;
  return `${quote.base_url || "https://headpinz.com"}/contract/${quote.contract_short_id}`;
}

/** The verify job's idempotency key — one outstanding proof per contract. */
export function cancelVerifyJobKey(shortId: string): string {
  return `contract-cancel-verify:${shortId}`;
}

/** An unresolved `contract-cancel-verify` job means the `-4` is still unproven. */
export async function isCancelPending(shortId: string): Promise<boolean> {
  const job = await getJobByIdempotencyKey(cancelVerifyJobKey(shortId)).catch(() => null);
  if (!job) return false;
  return job.status === "pending" || job.status === "running" || job.status === "failed";
}

export async function contractDetail(
  shortId: string,
  now = new Date(),
): Promise<ContractDetail | null> {
  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return null;

  const [versions, audit, notifications, ctx, cancelPending] = await Promise.all([
    getContractVersions(quote.id).catch(() => []),
    getAuditLog(quote.id).catch(() => []),
    getEventNotifications(quote.id).catch(() => []),
    rowContext([quote], now),
    isCancelPending(shortId),
  ]);

  const live = extractContractSnapshot(quote);
  const versionViews: ContractVersionView[] = diffVersionsAgainstLive(versions, live).map((v) => ({
    n: v.version.version_number,
    at: iso(v.version.created_at),
    trigger: v.version.trigger,
    changes: Array.isArray(v.version.changes) ? v.version.changes : [],
    diffs: v.diffs.map((d) => ({
      field: d.field,
      label: d.label,
      before: d.before,
      after: d.after,
    })),
  }));

  const auditViews: ContractAuditView[] = audit.map((a) => ({
    id: String(a.id),
    event: a.event,
    label: auditLabel(a.event),
    detail: auditDetail(a.metadata),
    actor: a.actor_email,
    at: iso(a.created_at),
  }));

  const notificationViews: ContractNotificationView[] = notifications.map((n) => ({
    id: String(n.id),
    ruleKey: n.rule_key,
    label: notificationRuleLabel(n.rule_key),
    channel: n.channel,
    status: n.status,
    error: n.error,
    at: iso(n.created_at),
  }));

  return {
    row: toContractRow(quote, ctx),
    notes: quote.notes,
    lineItems: toLineItems(quote.line_items),
    versions: versionViews,
    audit: auditViews,
    notifications: notificationViews,
    reminderRules: RULES.map((r) => ({ key: r.key, label: r.label })),
    guestUrl: guestUrlFor(quote),
    cancelPending,
  };
}

export interface PaymentsResult {
  timeline: SquareTimelineNode[];
  error: string | null;
}

/** Live Square. A failure is reported, never rendered as "nothing collected". */
export async function contractPayments(shortId: string): Promise<PaymentsResult | null> {
  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return null;
  try {
    return { timeline: await getSquareTimeline(quote.bmi_reservation_id), error: null };
  } catch (err) {
    return { timeline: [], error: err instanceof Error ? err.message : "Square read failed" };
  }
}

export async function contractHistory(shortId: string): Promise<ContractHistoryEntry[] | null> {
  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return null;
  return getContractHistory(quote.bmi_reservation_id).catch(() => []);
}

// ---------------------------------------------------------------------------
// Public notes — the live ones, which is the whole point of the preview
// ---------------------------------------------------------------------------

/**
 * BMI keeps the guest-visible text as the PUBLIC entry in the project's log
 * list (`logs[].public` — older payloads spell it `isPublic`), in `memo`. The
 * same place `updateProjectPublicNotes` writes, read back.
 *
 * PURE, so the shape can be pinned without an Office call.
 */
export function publicNotesFromProject(project: unknown): string | null {
  if (!project || typeof project !== "object") return null;
  const logs = (project as { logs?: unknown }).logs;
  if (!Array.isArray(logs)) return null;
  for (const entry of logs) {
    if (!entry || typeof entry !== "object") continue;
    const log = entry as { public?: unknown; isPublic?: unknown; memo?: unknown };
    const isPublic = log.public ?? log.isPublic;
    if (isPublic !== true) continue;
    return typeof log.memo === "string" ? log.memo : null;
  }
  return null;
}

export interface PublicNotesResult {
  /** What BMI holds right now, or null when Office could not be read. */
  live: string | null;
  /** What the guest's contract page is rendering today (`group_function_quotes.notes`). */
  stored: string | null;
  /**
   * The two disagree, so the guest is still being shown `stored` until
   * `group-quote-dispatch` picks the edit up (it runs every two minutes, AI
   * grammar-cleans the text and writes it back to BMI).
   */
  drifted: boolean;
  error: string | null;
}

/** Normalise for COMPARISON only — never for display. */
function norm(v: string | null): string {
  return (v ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * The live public notes for the guest preview.
 *
 * Its own request, like `contractPayments`: one Office round trip must not
 * decide whether the Contract tab opens. When Office cannot be reached the
 * preview falls back to the stored text and SAYS it is the stored text —
 * showing a stale note under a "live from BMI" caption is the failure this
 * exists to prevent.
 */
export async function contractPublicNotes(shortId: string): Promise<PublicNotesResult | null> {
  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return null;
  const clientKey = clientKeyForCenterCode(quote.center_code);
  try {
    const project = await fetchProjectRaw(clientKey, quote.bmi_reservation_id);
    const live = publicNotesFromProject(project);
    return { live, stored: quote.notes, drifted: norm(live) !== norm(quote.notes), error: null };
  } catch (err) {
    return {
      live: null,
      stored: quote.notes,
      drifted: false,
      error: err instanceof Error ? err.message : "Office read failed",
    };
  }
}
