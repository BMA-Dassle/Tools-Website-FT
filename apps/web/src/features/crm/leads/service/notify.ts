/**
 * New-lead notifications (brief §4 B3 "Notifications"):
 *
 *   - the QUEUE card: the same Adaptive Card (`lib/sales-lead-card.ts`) to the
 *     director's chat `CRM_JACOB_TEAMS_CHAT_ID`. The variable is not set yet
 *     (owner item) — the card is SKIPPED with a logged reason, never a throw;
 *   - the planner card + the guest's SMS / email EXACTLY as
 *     `/api/sales-lead/submit` has always done them: planner resolved from
 *     Pandora's `assignedAgent.name`, copy from `lib/sales-lead-copy.ts`,
 *     channel per `preferredContactMethod`, state in Redis `salescard:` (the
 *     Teams buttons read it), audit lines through `appendPrivateNote`.
 *
 * A FAILING NOTIFICATION NEVER FAILS `createLead` (tested): every channel is
 * `allSettled`, every result is a value, and the whole function is wrapped.
 *
 * Guest-facing SMS / email go out for WEB leads only — that is today's
 * behaviour (the form is the only caller). A lead a member of staff logs from
 * a phone call or a walk-in gets the internal cards, not an automated text.
 */

import redis from "@/lib/redis";
import { appendPrivateNote } from "@/lib/bmi-office-notes";
import { canonicalizePhone } from "@/lib/participant-contact";
import {
  buildSalesLeadCardForState,
  buildSalesLeadSummary,
  type SalesLeadLead,
  type SalesLeadState,
} from "@/lib/sales-lead-card";
import { CENTERS, resolvePlanner, type CenterConfig, type Planner } from "@/lib/sales-lead-config";
import {
  buildSalesLeadEmailHtml,
  buildSalesLeadEmailSubject,
  buildSalesLeadEmailText,
  buildSalesLeadSms,
  type SalesLeadCopyContext,
} from "@/lib/sales-lead-copy";
import { sendEmail } from "@/lib/sendgrid";
import { voxSend } from "@/lib/sms-retry";
import { sendAdaptiveCardToChannel } from "@/lib/teams-bot";
import type { CentreCode, LeadSource } from "../../core/types";
import { EVENT_TYPE_LABEL, type LeadView } from "../contracts";
import type { MintOutcome } from "./mint";

export const QUEUE_CHAT_ENV = "CRM_JACOB_TEAMS_CHAT_ID";
const STATE_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days, as today

/** `sales-lead-config.ts` CENTERS is keyed by the form's centerKey; the CRM knows centres. */
export const CENTRE_TO_CENTER_KEY: Record<CentreCode, keyof typeof CENTERS> = {
  HPFM: "headpinz-ft-myers",
  FT: "fasttrax-ft-myers",
  HPN: "headpinz-naples",
};

export function centerConfigFor(centre: CentreCode): CenterConfig {
  return CENTERS[CENTRE_TO_CENTER_KEY[centre]]!;
}

export interface ChannelOutcome {
  ok: boolean;
  status?: number | null;
  error?: string;
  skipped?: boolean;
  reason?: string;
  activityId?: string;
}

export interface NotifyOutcome {
  planner: { displayName: string; isIndividual: boolean } | null;
  queueCard: ChannelOutcome;
  plannerCard: ChannelOutcome;
  sms: ChannelOutcome;
  email: ChannelOutcome;
}

export interface NotifyInput {
  lead: LeadView;
  mint: MintOutcome;
  source: LeadSource;
  preferredContactMethod?: "phone" | "text" | "email";
  bestTimeToCall?: string;
  activityInterest?: string[];
  /** The friendly label shown on cards / emails ("Team building"); defaults to the CRM type label. */
  eventTypeLabel?: string;
}

export interface NotifyDeps {
  sendSms: typeof voxSend;
  sendEmail: typeof sendEmail;
  sendCard: typeof sendAdaptiveCardToChannel;
  redisSet: (key: string, value: string, ttlSeconds: number) => Promise<unknown>;
  appendPrivateNote: typeof appendPrivateNote;
  queueChatId: () => string | undefined;
  now: () => Date;
}

export function defaultNotifyDeps(): NotifyDeps {
  return {
    sendSms: voxSend,
    sendEmail,
    sendCard: sendAdaptiveCardToChannel,
    redisSet: (key, value, ttl) => redis.set(key, value, "EX", ttl),
    appendPrivateNote,
    queueChatId: () => process.env[QUEUE_CHAT_ENV]?.trim() || undefined,
    now: () => new Date(),
  };
}

/** Why the queue card would be skipped, or null when it can be sent. */
export function queueCardSkipReason(chatId: string | undefined): string | null {
  return chatId ? null : `${QUEUE_CHAT_ENV} not set`;
}

const SKIP = (reason: string): ChannelOutcome => ({
  ok: true,
  status: null,
  skipped: true,
  reason,
});

function settled<T extends ChannelOutcome>(r: PromiseSettledResult<T>): ChannelOutcome {
  if (r.status === "fulfilled") return r.value;
  return { ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
}

function stateFor(
  input: NotifyInput,
  planner: Planner,
  center: CenterConfig,
  projectID: string,
  projectNumber: string,
  now: Date,
): SalesLeadState {
  const { lead } = input;
  const cardLead: SalesLeadLead = {
    firstName: lead.guest.first,
    lastName: lead.guest.last,
    email: lead.guest.email ?? "",
    phone: lead.guest.phone ?? "",
    eventType: input.eventTypeLabel ?? EVENT_TYPE_LABEL[lead.type],
    preferredDate: lead.eventDate,
    preferredTime: lead.eventTime ?? undefined,
    guestCount: lead.guests,
    notes: lead.notes ?? undefined,
    activityInterest: input.activityInterest,
    preferredContactMethod: input.preferredContactMethod,
    bestTimeToCall: input.bestTimeToCall,
  };
  return {
    projectID,
    projectNumber,
    createdAt: now.toISOString(),
    planner,
    center,
    lead: cardLead,
  };
}

export async function notifyNewLead(
  input: NotifyInput,
  deps: NotifyDeps = defaultNotifyDeps(),
): Promise<NotifyOutcome> {
  try {
    return await run(input, deps);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[crm] notifyNewLead failed", { lead_id: input.lead.id, error });
    const failed: ChannelOutcome = { ok: false, error };
    return { planner: null, queueCard: failed, plannerCard: failed, sms: failed, email: failed };
  }
}

async function run(input: NotifyInput, deps: NotifyDeps): Promise<NotifyOutcome> {
  const { lead, mint } = input;
  const center = centerConfigFor(lead.centre);
  const now = deps.now();
  const minted = mint.status === "minted";
  // Pandora picked the responsible; the planner (and everything addressed to
  // or from them) exists only once the project does.
  const planner = minted ? resolvePlanner(mint.assignedAgent?.name ?? "", center) : null;
  const projectID = minted ? mint.projectId : lead.publicId;
  const projectNumber = minted ? mint.projectNumber : lead.publicId;
  const queuePlanner = planner ?? resolvePlanner("", center);
  const state = stateFor(input, queuePlanner, center, projectID, projectNumber, now);
  const stateKey = `salescard:${projectID}`;

  if (minted) await deps.redisSet(stateKey, JSON.stringify(state), STATE_TTL_SECONDS);

  const pref = input.preferredContactMethod;
  const guestChannels = input.source === "web" && minted && planner;
  const shouldSms = !!guestChannels && (pref === "text" || pref === undefined);
  const shouldEmail =
    !!guestChannels && (pref === "email" || pref === "phone" || pref === undefined);
  const skipGuest = !minted
    ? SKIP("no BMI project yet")
    : input.source !== "web"
      ? SKIP(`staff-logged ${input.source} lead — no automated guest message`)
      : SKIP(`skipped — customer prefers ${pref}`);

  const copyCtx: SalesLeadCopyContext | null = planner
    ? {
        firstName: lead.guest.first,
        projectNumber,
        plannerName: planner.displayName,
        plannerPhone: planner.phone,
        plannerEmail: planner.email,
        preferredDate: lead.eventDate,
        centerName: center.displayName,
        isIndividualPlanner: planner.isIndividual,
      }
    : null;

  const queueChatId = deps.queueChatId();
  const queueSkip = queueCardSkipReason(queueChatId);
  if (queueSkip)
    console.log("[crm] queue Teams card skipped", { lead_id: lead.id, reason: queueSkip });

  const [smsR, emailR, plannerR, queueR] = await Promise.allSettled([
    shouldSms && copyCtx && planner
      ? sendGuestSms(lead, copyCtx, planner, deps)
      : Promise.resolve(skipGuest),
    shouldEmail && copyCtx && planner
      ? sendGuestEmail(lead, copyCtx, planner, deps)
      : Promise.resolve(skipGuest),
    minted && planner
      ? postCard(planner.teamsChatId, state, deps)
      : Promise.resolve(SKIP("no BMI project yet")),
    queueSkip ? Promise.resolve(SKIP(queueSkip)) : postCard(queueChatId!, state, deps),
  ]);
  const sms = settled(smsR);
  const email = settled(emailR);
  const plannerCard = settled(plannerR);
  const queueCard = settled(queueR);

  if (minted) {
    const actor = queuePlanner.displayName;
    await Promise.allSettled([
      auditLine(deps, projectID, "sms", sms, actor, lead.guest.phone),
      auditLine(deps, projectID, "email", email, actor, lead.guest.email),
      auditLine(deps, projectID, "teams", plannerCard, actor, `${actor}'s chat`),
    ]);
    if (plannerCard.ok && plannerCard.activityId) {
      state.cardActivityId = plannerCard.activityId;
      await deps
        .redisSet(stateKey, JSON.stringify(state), STATE_TTL_SECONDS)
        .catch(() => undefined);
    }
  }

  return {
    planner: planner
      ? { displayName: planner.displayName, isIndividual: planner.isIndividual }
      : null,
    queueCard,
    plannerCard,
    sms,
    email,
  };
}

async function sendGuestSms(
  lead: LeadView,
  ctx: SalesLeadCopyContext,
  planner: Planner,
  deps: NotifyDeps,
): Promise<ChannelOutcome> {
  const to = canonicalizePhone(lead.guest.phone);
  if (!to) return { ok: false, status: null, error: "invalid phone" };
  const r = await deps.sendSms(to, buildSalesLeadSms(ctx), {
    fromOverride: planner.phone,
    fallbackPrefix: `(From ${planner.displayName}) `,
  });
  return { ok: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}) };
}

async function sendGuestEmail(
  lead: LeadView,
  ctx: SalesLeadCopyContext,
  planner: Planner,
  deps: NotifyDeps,
): Promise<ChannelOutcome> {
  if (!lead.guest.email) return { ok: false, status: null, error: "no email" };
  const r = await deps.sendEmail({
    to: lead.guest.email,
    toName: `${lead.guest.first} ${lead.guest.last}`.trim(),
    from: { email: planner.email, name: planner.displayName },
    replyTo: planner.email,
    bcc: planner.email,
    subject: buildSalesLeadEmailSubject(ctx),
    html: buildSalesLeadEmailHtml(ctx),
    text: buildSalesLeadEmailText(ctx),
  });
  return { ok: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}) };
}

async function postCard(
  chatId: string,
  state: SalesLeadState,
  deps: NotifyDeps,
): Promise<ChannelOutcome> {
  try {
    const resp = await deps.sendCard(chatId, buildSalesLeadCardForState(state), {
      summaryText: buildSalesLeadSummary(state),
    });
    return { ok: true, activityId: resp.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "teams send error" };
  }
}

async function auditLine(
  deps: NotifyDeps,
  projectId: string,
  channel: "sms" | "email" | "teams",
  outcome: ChannelOutcome,
  actor: string,
  to: string | null | undefined,
): Promise<void> {
  const toPart = to ? ` to ${to}` : "";
  const message = outcome.skipped
    ? outcome.reason || `skipped${toPart}`
    : outcome.ok
      ? `sent ok${toPart}`
      : `FAILED${toPart}${outcome.status ? ` (${outcome.status})` : ""}: ${outcome.error || "unknown"}`;
  await deps.appendPrivateNote({ projectId, channel, message, actor });
}

/** One line for the timeline: which channels went where. */
export function summarizeNotify(o: NotifyOutcome): string {
  const part = (label: string, c: ChannelOutcome) =>
    c.skipped
      ? `${label} skipped (${c.reason})`
      : c.ok
        ? `${label} sent`
        : `${label} FAILED (${c.error ?? "?"})`;
  return [
    part("Guest text", o.sms),
    part("guest email", o.email),
    part(o.planner ? `Teams card to ${o.planner.displayName}` : "planner card", o.plannerCard),
    part("queue card", o.queueCard),
  ].join(" · ");
}
