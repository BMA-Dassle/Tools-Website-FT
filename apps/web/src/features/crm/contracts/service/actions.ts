/**
 * What a director (or, where the prototype allows it, any rep) can DO to a
 * group-event contract from the CRM.
 *
 * Two rules shape every function here:
 *
 *   R9 — the actor is the SIGNED-IN person. `actor` is always
 *        `requireCrmUser().email`; no body may name an approver, and the CRM
 *        never POSTs to `/api/group-function/approve` (whose only auth is a
 *        body-supplied email against a two-address allowlist).
 *   R5 — never trust a 200. `cancelEvent` is the sharp end: `setProjectState`
 *        takes the PANDORA path for built-in negative ids and returns on
 *        Pandora's 200 with no re-read at all
 *        (`lib/bmi-office-actions.ts:537-546`). So this module does its OWN
 *        proof — `fetchProjectRawIds(...).stateId === "-4"`, polled three
 *        times — and until that proof lands it writes NO "cancelled" audit
 *        row, enqueues `contract-cancel-verify`, and the deal says "Cancel
 *        pending".
 *
 * Every action writes `crm_audit` (who, what, before/after) and a
 * `crm_activities` row on the lead when the contract belongs to one, so the
 * deal timeline and the audit ledger tell the same story.
 *
 * Deps are injected (the `assign.ts` pattern) so the MSW tests drive Office,
 * Pandora and Square without a live call and without a live Neon.
 */

import { recordActivity } from "~/features/crm/activities";
import { getJobByIdempotencyKey, neonJobStore, type JobStore } from "~/features/crm/jobs";
import { listLeadContractRefs } from "~/features/crm/leads";
import { centreByCode, CENTRE_LIST } from "../../core/centres";
import { writeAudit } from "../../core/data/audit-db";
import { getSettingValue } from "../../core/data/settings-db";
import { bmiWritesAllowedFor } from "../../core/flags";
import type { ActivityKind } from "../../core/types";
import type { ContractRow } from "../contracts";
import {
  RULES,
  appendAuditLog,
  appendProjectPrivateNote,
  approveQuote,
  chargeBalanceForQuote,
  createDayofOrder,
  denyQuote,
  eventWaiverLinkUrl,
  fetchProjectRawIds,
  getGfQuoteByShortId,
  noteTimestamp,
  notifyContractSent,
  QuoteNotPendingApprovalError,
  recordEventNotification,
  setProjectState,
  updateGfQuoteDetails,
  type BalanceChargeOutcome,
  type GroupFunctionQuote,
  type RuleContext,
} from "../transport";
import { cancelVerifyJobKey, clientKeyForCenterCode } from "./detail";
import { getContractRow } from "./list";

export const CONTRACT_ENTITY = "contract";
export const CANCEL_VERIFY_JOB_KIND = "contract-cancel-verify";

/** Three polls, 1.2 s apart — the brief's own cadence for the `-4` proof. */
export const CANCEL_VERIFY_ATTEMPTS = 3;
export const CANCEL_VERIFY_GAP_MS = 1200;

/** A refusal the route turns into a status code; never a raw `err.message`. */
export class ContractActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "ContractActionError";
    this.status = status;
    this.code = code;
  }
}

export interface ActionDeps {
  getQuote: (shortId: string) => Promise<GroupFunctionQuote | null>;
  getRow: (shortId: string, now: Date) => Promise<{ row: ContractRow } | null>;
  approveQuote: typeof approveQuote;
  denyQuote: typeof denyQuote;
  chargeBalanceForQuote: typeof chargeBalanceForQuote;
  notifyContractSent: typeof notifyContractSent;
  createDayofOrder: typeof createDayofOrder;
  updateGfQuoteDetails: typeof updateGfQuoteDetails;
  appendAuditLog: typeof appendAuditLog;
  recordEventNotification: typeof recordEventNotification;
  eventWaiverLinkUrl: typeof eventWaiverLinkUrl;
  setProjectState: typeof setProjectState;
  fetchProjectRawIds: typeof fetchProjectRawIds;
  appendProjectPrivateNote: typeof appendProjectPrivateNote;
  writeAudit: typeof writeAudit;
  recordActivity: typeof recordActivity;
  listLeadContractRefs: typeof listLeadContractRefs;
  getSettingValue: typeof getSettingValue;
  jobs: Pick<JobStore, "enqueue">;
  getJobByIdempotencyKey: typeof getJobByIdempotencyKey;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export function defaultActionDeps(): ActionDeps {
  return {
    getQuote: getGfQuoteByShortId,
    getRow: (shortId, now) => getContractRow(shortId, now),
    approveQuote,
    denyQuote,
    chargeBalanceForQuote,
    notifyContractSent,
    createDayofOrder,
    updateGfQuoteDetails,
    appendAuditLog,
    recordEventNotification,
    eventWaiverLinkUrl,
    setProjectState,
    fetchProjectRawIds,
    appendProjectPrivateNote,
    writeAudit,
    recordActivity,
    listLeadContractRefs,
    getSettingValue,
    jobs: neonJobStore,
    getJobByIdempotencyKey,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}

export interface ActionInput {
  shortId: string;
  /** `requireCrmUser().email` — never a body field (R9). */
  actor: string;
}

export interface ActionResult {
  message: string;
  row: ContractRow | null;
}

async function loadQuote(shortId: string, deps: ActionDeps): Promise<GroupFunctionQuote> {
  const quote = await deps.getQuote(shortId);
  if (!quote) throw new ContractActionError(404, "contract_not_found");
  return quote;
}

async function refreshedRow(shortId: string, deps: ActionDeps): Promise<ContractRow | null> {
  const found = await deps.getRow(shortId, deps.now()).catch(() => null);
  return found?.row ?? null;
}

/** The CRM lead this contract belongs to, for the deal timeline. */
async function leadIdFor(quote: GroupFunctionQuote, deps: ActionDeps): Promise<string | null> {
  const refs = await deps
    .listLeadContractRefs({
      shortIds: quote.contract_short_id ? [quote.contract_short_id] : [],
      projectIds: [quote.bmi_reservation_id],
    })
    .catch(() => []);
  return refs[0]?.id ?? null;
}

/** One audit row + one timeline entry. Never throws — the deed already landed. */
async function record(
  quote: GroupFunctionQuote,
  deps: ActionDeps,
  entry: {
    action: string;
    actor: string;
    kind: ActivityKind;
    body: string;
    before?: unknown;
    after?: unknown;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  const shortId = quote.contract_short_id ?? String(quote.id);
  await deps.writeAudit({
    entity: CONTRACT_ENTITY,
    entityId: shortId,
    action: entry.action,
    actorEmail: entry.actor,
    before: entry.before,
    after: entry.after,
  });
  const leadId = await leadIdFor(quote, deps);
  await deps.recordActivity({
    leadId,
    actorEmail: entry.actor,
    kind: entry.kind,
    occurredAt: deps.now(),
    subject: shortId,
    body: entry.body,
    meta: { shortId, projectId: quote.bmi_reservation_id, ...(entry.meta ?? {}) },
  });
}

/** A private BMI note. Never fatal — the action it describes already happened. */
async function note(quote: GroupFunctionQuote, deps: ActionDeps, text: string): Promise<void> {
  try {
    await deps.appendProjectPrivateNote({
      centerCode: quote.center_code,
      projectId: quote.bmi_reservation_id,
      note: `[${noteTimestamp()}] ${text}`,
    });
  } catch (err) {
    console.error("[crm] contract private note failed", {
      short_id: quote.contract_short_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function approveContract(
  input: ActionInput & { memo?: string | null },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult> {
  const quote = await loadQuote(input.shortId, deps);
  try {
    await deps.approveQuote(quote, { approverEmail: input.actor, memo: input.memo ?? null });
  } catch (err) {
    if (err instanceof QuoteNotPendingApprovalError) {
      throw new ContractActionError(409, "not_pending_approval", err.message);
    }
    throw err;
  }
  await record(quote, deps, {
    action: "approve",
    actor: input.actor,
    kind: "payment",
    body: `Post-paid contract approved and sent${input.memo ? ` — ${input.memo}` : ""}`,
    before: { status: quote.status },
    after: { status: "contract_sent", approvedBy: input.actor, memo: input.memo ?? null },
  });
  return {
    message: "Approved · contract sent to the guest",
    row: await refreshedRow(input.shortId, deps),
  };
}

export async function denyContract(
  input: ActionInput & { reason: string },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult> {
  const quote = await loadQuote(input.shortId, deps);
  try {
    await deps.denyQuote(quote, { approverEmail: input.actor, reason: input.reason });
  } catch (err) {
    if (err instanceof QuoteNotPendingApprovalError) {
      throw new ContractActionError(409, "not_pending_approval", err.message);
    }
    throw err;
  }
  await record(quote, deps, {
    action: "deny",
    actor: input.actor,
    kind: "payment",
    body: `Post-paid contract denied — ${input.reason}`,
    before: { status: quote.status },
    after: { status: "denied", deniedBy: input.actor, reason: input.reason },
  });
  return { message: "Denied · planner notified", row: await refreshedRow(input.shortId, deps) };
}

// ---------------------------------------------------------------------------
// Resend and reminders
// ---------------------------------------------------------------------------

/**
 * Resend the SAME link and the SAME version, through the rail the automatic
 * send uses. The prototype's sheet offered a channel picker and one-off
 * phone/email overrides; neither exists behind `notifyContractSent`, and
 * faking a picker that always sends both — or editing the contract's contact
 * details to route one message — would be worse than saying so. The sheet
 * states what will happen instead.
 */
export async function resendContract(
  input: ActionInput & { note?: string | null },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult> {
  const quote = await loadQuote(input.shortId, deps);
  await deps.notifyContractSent(quote);
  await deps.appendAuditLog({
    quoteId: quote.id,
    event: "resend_contract",
    actorEmail: input.actor,
    metadata: { note: input.note ?? null, source: "crm" },
  });
  await note(
    quote,
    deps,
    `Contract resent (email + text) by ${input.actor}${input.note ? ` — ${input.note}` : ""}`,
  );
  await record(quote, deps, {
    action: "resend",
    actor: input.actor,
    kind: "payment",
    body: `Contract resent to guest (email + text)${input.note ? ` — ${input.note}` : ""}`,
    after: { to: quote.guest_email, phone: quote.guest_phone },
  });
  return { message: "Contract resent", row: await refreshedRow(input.shortId, deps) };
}

/**
 * Fire one reminder rule NOW, ignoring its once-only gate — the same thing
 * `/api/admin/group-functions/reminders` does, and deliberately the same
 * ledger rows, so a hand-fired reminder is visible on both boards.
 */
export async function fireReminder(
  input: ActionInput & { ruleKey: string },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult> {
  const quote = await loadQuote(input.shortId, deps);
  const rule = RULES.find((r) => r.key === input.ruleKey);
  if (!rule) throw new ContractActionError(400, "unknown_rule");

  let waiverCache: string | null = null;
  let waiverDone = false;
  const ctx: RuleContext = {
    quote,
    getWaiverUrl: async () => {
      if (!waiverDone) {
        waiverCache = await deps.eventWaiverLinkUrl(quote);
        waiverDone = true;
      }
      return waiverCache;
    },
    firedEvents: new Set(),
    allowSms: true,
    dryRun: false,
  };

  const result = await rule.send(ctx);
  for (const ch of result.channelsAttempted) {
    const ok = ch === "email" ? result.emailOk : result.smsOk;
    await deps.recordEventNotification({
      quoteId: quote.id,
      ruleKey: rule.key,
      dedupKey: rule.dedupKey ?? rule.key,
      channel: ch,
      status: ok === false ? "failed" : ok === null || ok === undefined ? "skipped" : "sent",
      provider: ch === "sms" ? "vox" : "sendgrid",
      providerMessageId: ch === "sms" ? result.providerMessageId : undefined,
      toAddress: ch === "email" ? quote.guest_email : quote.guest_phone || undefined,
      error: result.error,
      metadata: { manualFire: true, actor: input.actor, source: "crm" },
    });
  }
  await record(quote, deps, {
    action: "remind",
    actor: input.actor,
    kind: "system",
    body: `Reminder fired by hand — ${rule.label}`,
    after: { ruleKey: rule.key, channels: result.channelsAttempted, error: result.error ?? null },
  });
  return { message: `${rule.label} fired`, row: await refreshedRow(input.shortId, deps) };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const CHARGE_MESSAGE: Record<BalanceChargeOutcome, string> = {
  auto_charged: "Balance charged · loaded to the day-of gift card",
  link_sent: "Payment page sent to the guest by email + text",
  skipped: "Nothing to do — another run got there first, or the balance is already settled",
};

export async function chargeBalance(
  input: ActionInput & { reason?: string | null; mode?: "auto" | "link" },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult & { outcome: BalanceChargeOutcome }> {
  const quote = await loadQuote(input.shortId, deps);
  const mode = input.mode ?? "auto";
  if (mode === "auto" && !quote.saved_card_id) {
    throw new ContractActionError(409, "no_card_on_file");
  }
  const outcome = await deps.chargeBalanceForQuote(quote, {
    actor: input.actor,
    reason: input.reason ?? null,
    mode,
  });
  await record(quote, deps, {
    action: mode === "link" ? "send-balance-link" : "charge-balance",
    actor: input.actor,
    kind: "payment",
    body:
      mode === "link"
        ? `Balance payment page sent${input.reason ? ` — ${input.reason}` : ""}`
        : `Balance charge run by hand${input.reason ? ` — ${input.reason}` : ""} (${outcome})`,
    before: { balanceCents: quote.balance_cents, status: quote.status },
    after: { outcome, reason: input.reason ?? null },
  });
  return {
    message: CHARGE_MESSAGE[outcome],
    outcome,
    row: await refreshedRow(input.shortId, deps),
  };
}

/**
 * Create the Square day-of order that the deposit flow failed to create.
 * Delegates to `createDayofOrder`, which `group-function-dayof.ts` declares
 * the single source of truth — this is the second CALLER, never a second copy
 * (the first copy is how a tax misclassification survived being fixed).
 */
export async function backfillDayofOrder(
  input: ActionInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult & { dayofOrderId: string | null; created: boolean }> {
  const quote = await loadQuote(input.shortId, deps);
  if (quote.square_dayof_order_id) {
    return {
      message: "Day-of order already exists",
      created: false,
      dayofOrderId: quote.square_dayof_order_id,
      row: await refreshedRow(input.shortId, deps),
    };
  }
  const dayof = await deps.createDayofOrder(quote, `crm-${input.shortId}-${Date.now()}`);
  if (!dayof) throw new ContractActionError(502, "dayof_order_failed");
  await deps.updateGfQuoteDetails(quote.id, { square_dayof_order_id: dayof.id });
  await record(quote, deps, {
    action: "backfill-dayof",
    actor: input.actor,
    kind: "payment",
    body: `Day-of Square order created (${dayof.id})`,
    after: { dayofOrderId: dayof.id, totalCents: dayof.totalCents },
  });
  return {
    message: "Day-of order created",
    created: true,
    dayofOrderId: dayof.id,
    row: await refreshedRow(input.shortId, deps),
  };
}

// ---------------------------------------------------------------------------
// Cancel — the one that must prove itself
// ---------------------------------------------------------------------------

export interface CancelResult extends ActionResult {
  verified: boolean;
  observedStateId: string | null;
  jobEnqueued: boolean;
}

export const CANCELLED_STATE_ID = "-4";

/** Poll Office for the project's state; `null` when it could not be read. */
export async function pollProjectState(
  clientKey: string,
  projectId: string,
  deps: ActionDeps,
  attempts = CANCEL_VERIFY_ATTEMPTS,
  gapMs = CANCEL_VERIFY_GAP_MS,
): Promise<string | null> {
  let observed: string | null = null;
  for (let i = 0; i < attempts; i++) {
    const project = await deps.fetchProjectRawIds(clientKey, projectId).catch(() => null);
    const stateId = project?.stateId;
    observed = stateId === undefined || stateId === null ? null : String(stateId);
    if (observed === CANCELLED_STATE_ID) return observed;
    if (i < attempts - 1) await deps.sleep(gapMs);
  }
  return observed;
}

/**
 * Cancel the event: flip the BMI project to Cancellation (`-4`) and PROVE it.
 *
 * `setProjectState` sends built-in negative ids through Pandora and returns as
 * soon as Pandora answers 200 — with no re-read. Pandora's 200 has been a lie
 * before (it 200s and no-ops custom state ids; it propagates to Firebird
 * asynchronously), so a 200 is not a cancellation. This waits for Office to
 * SAY `-4` and only then writes the "cancelled" audit row that lets the money
 * rail (`/api/cron/group-quote-sync`) take over: that cron is what refunds and
 * drains the gift cards, and it acts on what Office reports, not on us.
 *
 * Unproven → NO audit row, a `contract-cancel-verify` job, and the deal reads
 * "Cancel pending" until the job proves it.
 */
export async function cancelEvent(
  input: ActionInput & { reason: string; note?: string | null },
  deps: ActionDeps = defaultActionDeps(),
): Promise<CancelResult> {
  const quote = await loadQuote(input.shortId, deps);
  const clientKey = clientKeyForCenterCode(quote.center_code);

  const setting = await deps.getSettingValue("bmi_writes").catch(() => null);
  if (!bmiWritesAllowedFor(clientKey, setting)) {
    throw new ContractActionError(409, "bmi_writes_paused");
  }

  await deps.setProjectState({
    centerCode: quote.center_code,
    projectId: quote.bmi_reservation_id,
    stateId: CANCELLED_STATE_ID,
    label: "Cancellation",
  });

  const observedStateId = await pollProjectState(clientKey, quote.bmi_reservation_id, deps);
  const verified = observedStateId === CANCELLED_STATE_ID;

  if (verified) {
    await note(
      quote,
      deps,
      `Event cancelled by ${input.actor} — ${input.reason}${input.note ? ` | ${input.note}` : ""}`,
    );
    await record(quote, deps, {
      action: "cancel",
      actor: input.actor,
      kind: "payment",
      body: `Event cancelled · ${input.reason}${input.note ? ` — ${input.note}` : ""} · BMI state Cancellation confirmed`,
      before: { status: quote.status, stateId: null },
      after: { stateId: CANCELLED_STATE_ID, reason: input.reason, note: input.note ?? null },
      meta: { verified: true },
    });
    return {
      message: "Event cancelled · BMI confirmed · refund in progress",
      verified: true,
      observedStateId,
      jobEnqueued: false,
      row: await refreshedRow(input.shortId, deps),
    };
  }

  // NOT proven. No "cancelled" audit row — a cancellation nobody can see in
  // Office is not a cancellation, and an audit row saying otherwise is the
  // thing a refund dispute would be read against.
  let jobEnqueued = false;
  try {
    await deps.jobs.enqueue({
      kind: CANCEL_VERIFY_JOB_KIND,
      idempotencyKey: cancelVerifyJobKey(input.shortId),
      payload: {
        shortId: input.shortId,
        projectId: quote.bmi_reservation_id,
        centerCode: quote.center_code,
        clientKey,
        reason: input.reason,
        note: input.note ?? null,
        actor: input.actor,
      },
      createdBy: input.actor,
    });
    jobEnqueued = true;
  } catch (err) {
    console.error("[crm] cancel verify enqueue failed", {
      short_id: input.shortId,
      actor_email: input.actor,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await deps.recordActivity({
    leadId: await leadIdFor(quote, deps),
    actorEmail: input.actor,
    kind: "system",
    occurredAt: deps.now(),
    subject: input.shortId,
    body: `Cancel sent to BMI — Office still reads ${observedStateId ?? "unreadable"}; waiting for confirmation`,
    meta: {
      shortId: input.shortId,
      projectId: quote.bmi_reservation_id,
      observedStateId,
      jobEnqueued,
    },
  });

  return {
    message: "Cancel sent to BMI — waiting for Office to confirm",
    verified: false,
    observedStateId,
    jobEnqueued,
    row: await refreshedRow(input.shortId, deps),
  };
}

/**
 * The `contract-cancel-verify` job: re-read the project and, if it now says
 * `-4`, write the audit row the cancel could not. Still not `-4` → an ordinary
 * failure, retried with the runner's backoff and parked when the attempts are
 * spent (a director then sees it on My Day).
 */
export async function runCancelVerifyJob(
  payload: Record<string, unknown>,
  deps: ActionDeps = defaultActionDeps(),
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; park?: boolean }> {
  const shortId = typeof payload.shortId === "string" ? payload.shortId : "";
  if (!shortId) return { ok: false, error: "cancel verify: no shortId", park: true };
  const quote = await deps.getQuote(shortId);
  if (!quote)
    return { ok: false, error: `cancel verify: contract ${shortId} not found`, park: true };

  const clientKey =
    typeof payload.clientKey === "string"
      ? payload.clientKey
      : clientKeyForCenterCode(quote.center_code);
  const observed = await pollProjectState(clientKey, quote.bmi_reservation_id, deps, 1, 0);
  if (observed !== CANCELLED_STATE_ID) {
    return { ok: false, error: `Office reads ${observed ?? "unreadable"}, expected -4` };
  }

  const actor = typeof payload.actor === "string" ? payload.actor : "system";
  const reason = typeof payload.reason === "string" ? payload.reason : "Event cancelled";
  const note0 = typeof payload.note === "string" ? payload.note : null;
  await note(quote, deps, `Event cancellation confirmed in BMI (requested by ${actor})`);
  await record(quote, deps, {
    action: "cancel",
    actor,
    kind: "payment",
    body: `Event cancelled · ${reason}${note0 ? ` — ${note0}` : ""} · BMI state Cancellation confirmed`,
    after: { stateId: CANCELLED_STATE_ID, reason, note: note0 },
    meta: { verified: true, viaJob: true },
  });
  return { ok: true, result: { shortId, stateId: CANCELLED_STATE_ID, confirmedBy: "job" } };
}

/** Exported for the route: is a cancel still waiting on Office? */
export async function cancelPendingFor(
  shortId: string,
  deps: ActionDeps = defaultActionDeps(),
): Promise<boolean> {
  const job = await deps.getJobByIdempotencyKey(cancelVerifyJobKey(shortId)).catch(() => null);
  if (!job) return false;
  return job.status === "pending" || job.status === "running" || job.status === "failed";
}

/** The centre a contract belongs to, for the screens that need the code. */
export function centreCodeForQuote(quote: Pick<GroupFunctionQuote, "center_code">) {
  return CENTRE_LIST.find((c) => c.centerCode === quote.center_code)?.code ?? null;
}

/** Re-exported so a route can name the same centre helpers the rows use. */
export { centreByCode, clientKeyForCenterCode };
