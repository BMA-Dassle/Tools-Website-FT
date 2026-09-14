/**
 * New-lead notifications (brief §4 B3 "Notifications", §5.7b):
 *
 *   - the UNASSIGNED card: the same Adaptive Card (`lib/sales-lead-card.ts`)
 *     to "Sales Leads - Assignment Pending" (`CRM_UNASSIGNED_TEAMS_CHAT_ID`,
 *     with the older `CRM_JACOB_TEAMS_CHAT_ID` still accepted). It is sent
 *     ONLY when the lead ended up with NOBODY — parked by a hold rule, or
 *     left unresolved because no rule could name a rep. Since 2026-09-13 the
 *     rules assign at capture, so an ordinary lead is already owned by the
 *     time this runs and gets exactly one card, in its planner's chat; a
 *     second card about the same lead in the director's chat is the thing
 *     this rule exists to prevent. Unset variable → SKIPPED with a logged
 *     reason, never a throw. When the lead has no BMI project the card goes
 *     out WITHOUT its buttons: they resolve against `salescard:{projectID}`,
 *     which exists only once the project does (`withoutCardActions`);
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

import { BMI_ID_FIELDS, parseWithRawIds } from "@ft/db";
import redis from "@/lib/redis";
import { appendPrivateNote } from "@/lib/bmi-office-notes";
import { canonicalizePhone } from "@/lib/participant-contact";
import {
  buildSalesLeadCardForState,
  buildSalesLeadSummary,
  type SalesLeadLead,
  type SalesLeadState,
} from "@/lib/sales-lead-card";
import {
  CENTERS,
  PLANNERS,
  resolvePlanner,
  type CenterConfig,
  type Planner,
} from "@/lib/sales-lead-config";
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
import { updateLeadFields } from "../data/leads-db";
import { EVENT_TYPE_LABEL, type LeadView } from "../contracts";
import type { MintOutcome } from "./mint";

/**
 * "Sales Leads - Assignment Pending" (`19:0c8d8c86…`, owner-created
 * 2026-09-13). `CRM_JACOB_TEAMS_CHAT_ID` is accepted as a fallback so a
 * deployment that has only the older variable keeps working.
 */
export const UNASSIGNED_CHAT_ENV = "CRM_UNASSIGNED_TEAMS_CHAT_ID";
export const UNASSIGNED_CHAT_ENV_FALLBACK = "CRM_JACOB_TEAMS_CHAT_ID";

/**
 * "Sales Leads - Assignment Pending", read off the tenant on 2026-09-13:
 * Jacob, Eric and the HeadPinz bot. A chat id is an ADDRESS, not a secret, and
 * the first lead this branch held went nowhere because the variable was never
 * pasted into Vercel (`unassignedCard {"skipped":true,"reason":
 * "CRM_UNASSIGNED_TEAMS_CHAT_ID not set"}`). A default that is simply correct
 * beats a deployment step somebody has to remember; the env var still wins
 * when it is set, so moving the chat needs no deploy.
 */
export const UNASSIGNED_CHAT_ID_DEFAULT = "19:0c8d8c8667274428a5a81c33a66eff72@thread.v2";

/**
 * Where a Teams card sends somebody who taps it. `NEXT_PUBLIC_SITE_URL` is the
 * repo's convention for an absolute public link (`lib/healthnet-almost-here`,
 * `lib/portal-format`); `CRM_PUBLIC_BASE_URL` overrides it so a preview
 * deployment's cards point at the preview rather than production.
 */
export function crmDealUrl(publicId: string): string {
  const base = (
    process.env.CRM_PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://headpinz.com"
  ).replace(/\/+$/, "");
  return `${base}/admin/crm/deal/${encodeURIComponent(publicId)}`;
}

/**
 * Who the Assignment Pending card @-mentions. AAD object ids (not `29:`
 * prefixed) — Eric's is the `userObjectId` his own Graph token reports, and
 * Jacob's is the other half of their 1:1 chat id
 * (`19:<eric>_<jacob>@unq.gbl.spaces`), whose only two members are the two of
 * them. A mention renders only if the card also carries `<at>Name</at>`, which
 * `mentionBanner` adds.
 */
export const UNASSIGNED_MENTIONS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "4e38b98c-2aad-4a06-bfce-6abff64dbab4", name: "Jacob Elliott" },
  { id: "307bd04b-4379-4e0c-bd0d-d3ec4ec81b5b", name: "Eric Osborn" },
];
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
  /** The card to "Sales Leads - Assignment Pending"; skipped when someone owns the lead. */
  unassignedCard: ChannelOutcome;
  plannerCard: ChannelOutcome;
  sms: ChannelOutcome;
  email: ChannelOutcome;
}

export interface NotifyInput {
  lead: LeadView;
  mint: MintOutcome;
  source: LeadSource;
  /**
   * Did the rules leave this lead with an owner? `createLead` assigns BEFORE
   * it notifies and passes `lead.rep !== null`; a parked or unresolved lead is
   * false and is the only thing the Assignment Pending chat hears about.
   * Defaults to the lead's own `rep` for callers that have not been updated.
   */
  assigned?: boolean;
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
  redisGet: (key: string) => Promise<string | null>;
  appendPrivateNote: typeof appendPrivateNote;
  /** Stamps `crm_leads.guest_intro_at` — the once-only gate on the welcome. */
  stampGuestIntro: (leadId: string, at: Date) => Promise<unknown>;
  unassignedChatId: () => string | undefined;
  now: () => Date;
}

export function defaultNotifyDeps(): NotifyDeps {
  return {
    sendSms: voxSend,
    sendEmail,
    sendCard: sendAdaptiveCardToChannel,
    redisSet: (key, value, ttl) => redis.set(key, value, "EX", ttl),
    redisGet: (key) => redis.get(key),
    appendPrivateNote,
    stampGuestIntro: (leadId, at) => updateLeadFields(leadId, { guestIntroAt: at }),
    unassignedChatId: () =>
      process.env[UNASSIGNED_CHAT_ENV]?.trim() ||
      process.env[UNASSIGNED_CHAT_ENV_FALLBACK]?.trim() ||
      UNASSIGNED_CHAT_ID_DEFAULT,
    now: () => new Date(),
  };
}

/** The Redis key the Teams buttons read; written only once a project exists. */
export const salesCardKey = (projectId: string) => `salescard:${projectId}`;

/**
 * The welcome that names nobody: Guest Services, with the centre's own phone.
 * `resolvePlanner("")` matches no individual and falls through to it, which is
 * the single definition — this wrapper just gives it a name that says what it
 * is for rather than looking like a bug at the call site.
 */
export function resolveGuestServicesPlanner(center: CenterConfig): Planner {
  return resolvePlanner("", center);
}

/**
 * The planner a lead's OWNER is, or null when nobody owns it.
 *
 * This is the fix for a lead that was held and told the guest otherwise. On
 * 2026-09-13 a 500-guest FastTrax enquiry (L-228) was correctly parked for the
 * Marketing Director by rule R1 — our board showed it unassigned and
 * `assigned_rep_id` was null — while the success screen and the guest's text
 * both said "Kelsea", because the planner was read off Pandora's
 * `assignedAgent.name`. Pandora runs its OWN round robin and stamps a
 * `responsible` on the project whatever our rules decide, so reading it here
 * meant the guest was told the answer of an engine we do not control.
 *
 * The roster slugs that are real people map to `PLANNERS`; `gs` is the Guest
 * Services bucket, which is a legitimate owner but not an individual. Anything
 * else — the Marketing hold bucket, a director, or nobody at all — has no
 * planner to name, and the guest gets the generic copy that says our team will
 * be in touch. Saying less is the only honest option while a human decides.
 */
export function plannerForOwner(
  repSlug: string | null | undefined,
  center: CenterConfig,
): Planner | null {
  if (!repSlug) return null;
  const named = PLANNERS[repSlug];
  if (named) return named;
  // `resolvePlanner("")` is the one definition of the Guest Services planner,
  // whose phone is per-centre.
  if (repSlug === "gs") return resolveGuestServicesPlanner(center);
  return null;
}

/**
 * Does Pandora's `assignedAgent.name` name the same person we picked? Office
 * writes "Kelsea Kosco" where the planner is "Kelsea", so this is a first-name
 * containment check, not equality — it exists only to keep the disagreement
 * log quiet when the two engines happen to agree.
 */
function sameHuman(pandoraName: string, ours: Planner | null): boolean {
  if (!ours) return false;
  return pandoraName.toLowerCase().includes(ours.key.toLowerCase());
}

/** Why the Assignment Pending card would be skipped, or null when it must be sent. */
export function unassignedCardSkipReason(
  chatId: string | undefined,
  assigned: boolean,
  ownerName?: string | null,
): string | null {
  if (assigned) return `assigned to ${ownerName?.trim() || "a planner"} — their card is the one`;
  return chatId ? null : `${UNASSIGNED_CHAT_ENV} not set`;
}

const SKIP = (reason: string): ChannelOutcome => ({
  ok: true,
  status: null,
  skipped: true,
  reason,
});

/** The reason every channel carries on a resubmit inside the dedupe window. */
export const ALREADY_SENT = "already sent";

/**
 * A resubmit inside the 15-minute dedupe window (`createLead` short-circuits
 * on an already-minted row): nothing is sent a second time, but the guest must
 * see the SAME planner they were given the first time. Defaulting to Guest
 * Services here named the wrong person for a lead Pandora had routed to a
 * named planner. The planner comes back out of the card state the first
 * submission wrote; if that is gone we return null and let the caller say what
 * it always says rather than guess a name.
 */
export async function notifyAlreadySent(
  input: { lead: LeadView; projectId: string | null },
  deps: NotifyDeps = defaultNotifyDeps(),
): Promise<NotifyOutcome> {
  const skipped = SKIP(ALREADY_SENT);
  let planner: NotifyOutcome["planner"] = null;
  try {
    const raw = input.projectId ? await deps.redisGet(salesCardKey(input.projectId)) : null;
    if (raw) {
      // R1: the state was written by us with quoted ids, but this is a rail
      // that carries `projectID` — read it the way every Pandora read is read.
      const state = parseWithRawIds<SalesLeadState>(raw, [...BMI_ID_FIELDS, "projectID"]);
      const p = state?.planner;
      if (p?.displayName) planner = { displayName: p.displayName, isIndividual: !!p.isIndividual };
    }
  } catch (err) {
    console.error("[crm] could not read the planner for a duplicate submission", {
      lead_id: input.lead.id,
      project_id: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { planner, unassignedCard: skipped, plannerCard: skipped, sms: skipped, email: skipped };
}

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
    return {
      planner: null,
      unassignedCard: failed,
      plannerCard: failed,
      sms: failed,
      email: failed,
    };
  }
}

async function run(input: NotifyInput, deps: NotifyDeps): Promise<NotifyOutcome> {
  const { lead, mint } = input;
  const center = centerConfigFor(lead.centre);
  const now = deps.now();
  const minted = mint.status === "minted";
  // OUR assignment decides who the guest is told about — never Pandora's
  // `assignedAgent`. See `plannerForOwner`.
  const planner = plannerForOwner(lead.repSlug, center);
  const projectID = minted ? mint.projectId : lead.publicId;
  const projectNumber = minted ? mint.projectNumber : lead.publicId;
  // Somebody has to be on the card and in the guest copy; when nobody owns the
  // lead that is Guest Services, which names no individual.
  const guestServices = resolveGuestServicesPlanner(center);
  const cardPlanner = planner ?? guestServices;

  // Two engines still pick a rep for the same lead, and only one of them is
  // ours. Log the disagreement so it is visible until Pandora stops minting.
  const pandoraPick = mint.status === "minted" ? (mint.assignedAgent?.name ?? null) : null;
  if (pandoraPick && !sameHuman(pandoraPick, planner))
    console.warn("[crm] Pandora assigned somebody else", {
      lead_id: lead.id,
      project_id: projectID,
      pandora: pandoraPick,
      ours: planner?.displayName ?? "nobody — held or unresolved",
    });
  const state = stateFor(input, cardPlanner, center, projectID, projectNumber, now);
  const stateKey = salesCardKey(projectID);

  if (minted) await deps.redisSet(stateKey, JSON.stringify(state), STATE_TTL_SECONDS);

  // The guest's welcome text and email introduce a planner BY NAME and carry
  // that planner's direct number. A lead nobody owns yet therefore HOLDS them
  // rather than sending a generic "someone will be in touch" that a real
  // introduction contradicts an hour later (owner, 2026-09-13): the guest gets
  // ONE message, from the person who will actually run their event.
  // `assignLead` sends it the moment a planner picks the lead up, and
  // `sweepHeldGuestIntros` is the backstop so a forgotten lead cannot turn
  // into silence.
  const introP: Promise<GuestIntroOutcome> = !minted
    ? Promise.resolve(bothGuest(SKIP("no BMI project yet")))
    : input.source !== "web"
      ? Promise.resolve(
          bothGuest(SKIP(`staff-logged ${input.source} lead — no automated guest message`)),
        )
      : !planner
        ? Promise.resolve(bothGuest(SKIP(HELD_FOR_PLANNER)))
        : sendGuestIntro(
            {
              lead,
              planner,
              center,
              projectId: projectID,
              projectNumber,
              preferredContactMethod: input.preferredContactMethod,
            },
            deps,
          );

  // Nobody owns this lead → the Assignment Pending chat. `createLead` has
  // already applied the rules by the time it calls us, so `assigned` is the
  // settled answer, not a guess; the `lead.rep` fallback covers a caller that
  // does not pass it.
  const assigned = input.assigned ?? lead.rep !== null;
  const unassignedChatId = deps.unassignedChatId();
  const unassignedSkip = unassignedCardSkipReason(unassignedChatId, assigned, planner?.displayName);
  if (unassignedSkip)
    console.log("[crm] Assignment Pending card skipped", {
      lead_id: lead.id,
      reason: unassignedSkip,
    });

  const [introR, plannerR, unassignedR] = await Promise.allSettled([
    introP,
    !planner
      ? Promise.resolve(SKIP("nobody owns this lead — the Assignment Pending card is the one"))
      : minted
        ? postCard(planner.teamsChatId, state, deps, {
            open: { url: crmDealUrl(lead.publicId), title: "Open in CRM" },
          })
        : Promise.resolve(SKIP("no BMI project yet")),
    unassignedSkip
      ? Promise.resolve(SKIP(unassignedSkip))
      : postCard(unassignedChatId!, state, deps, {
          readOnly: !minted,
          // Nobody owns it — say so to the two people who can fix that, and
          // give them one tap to the screen where they fix it.
          mentions: UNASSIGNED_MENTIONS,
          open: { url: crmDealUrl(lead.publicId), title: "Assign in CRM" },
        }),
  ]);
  const intro: GuestIntroOutcome =
    introR.status === "fulfilled"
      ? introR.value
      : bothGuest({
          ok: false,
          error: introR.reason instanceof Error ? introR.reason.message : String(introR.reason),
        });
  const { sms, email } = intro;
  const plannerCard = settled(plannerR);
  const unassignedCard = settled(unassignedR);

  if (minted) {
    const actor = cardPlanner.displayName;
    await Promise.allSettled([
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
    unassignedCard,
    plannerCard,
    sms,
    email,
  };
}

// ---------------------------------------------------------------------------
// The guest's introduction — held until somebody owns the lead
// ---------------------------------------------------------------------------

/** The reason both guest channels carry while a lead is waiting for an owner. */
export const HELD_FOR_PLANNER = "held — the guest hears from their planner, not before";

export interface GuestIntroOutcome {
  sms: ChannelOutcome;
  email: ChannelOutcome;
}

const bothGuest = (c: ChannelOutcome): GuestIntroOutcome => ({ sms: c, email: c });

export interface GuestIntroInput {
  lead: LeadView;
  /** The OWNER. There is no such thing as an introduction from nobody. */
  planner: Planner;
  center: CenterConfig;
  projectId: string;
  projectNumber: string;
  /** The form's answer; falls back to the contact's stored preference. */
  preferredContactMethod?: "phone" | "text" | "email";
}

/** `crm_contacts.prefers` in the form's vocabulary — "call" is "phone". */
export function prefersToContactMethod(
  prefers: LeadView["guest"]["prefers"],
): "phone" | "text" | "email" | undefined {
  if (prefers === "call") return "phone";
  if (prefers === "text" || prefers === "email") return prefers;
  return undefined;
}

/**
 * The guest's welcome text and email, naming their planner.
 *
 * Called at capture when the rules assigned immediately, and again from
 * `assignLead` for a lead that was held — which is the whole reason it is its
 * own function rather than a branch inside `run`. It stamps `guest_intro_at`
 * on the way out, so a released-then-reassigned lead never introduces a second
 * planner to the same guest.
 */
export async function sendGuestIntro(
  input: GuestIntroInput,
  deps: NotifyDeps = defaultNotifyDeps(),
): Promise<GuestIntroOutcome> {
  const { lead, planner, center, projectId, projectNumber } = input;
  if (lead.guestIntroAt) return bothGuest(SKIP("the guest has already been introduced"));

  const pref = input.preferredContactMethod ?? prefersToContactMethod(lead.guest.prefers);
  const ctx: SalesLeadCopyContext = {
    firstName: lead.guest.first,
    projectNumber,
    plannerName: planner.displayName,
    plannerPhone: planner.phone,
    plannerEmail: planner.email,
    preferredDate: lead.eventDate,
    centerName: center.displayName,
    isIndividualPlanner: planner.isIndividual,
  };
  const skip = SKIP(`skipped — customer prefers ${pref}`);
  const [smsR, emailR] = await Promise.allSettled([
    pref === "text" || pref === undefined
      ? sendGuestSms(lead, ctx, planner, deps)
      : Promise.resolve(skip),
    pref === "email" || pref === "phone" || pref === undefined
      ? sendGuestEmail(lead, ctx, planner, deps)
      : Promise.resolve(skip),
  ]);
  const sms = settled(smsR);
  const email = settled(emailR);

  // Stamped whatever the channels answered. A send that failed is a send that
  // happened as far as "do not introduce a second planner" is concerned, and
  // the failure is on the timeline for a human to act on; retrying it days
  // later, from a different name, is the outcome to avoid.
  await deps.stampGuestIntro(lead.id, deps.now()).catch((err: unknown) =>
    console.error("[crm] guest intro sent but not stamped", {
      lead_id: lead.id,
      error: err instanceof Error ? err.message : String(err),
    }),
  );

  await Promise.allSettled([
    auditLine(deps, projectId, "sms", sms, planner.displayName, lead.guest.phone),
    auditLine(deps, projectId, "email", email, planner.displayName, lead.guest.email),
  ]);
  return { sms, email };
}

/**
 * The planner's Teams card for a lead that was HELD and has now been handed to
 * somebody.
 *
 * At capture, `run` posts this card — but only if the lead already had an
 * owner. A held lead has none, so nobody's chat hears about it until a
 * director assigns it, and until 2026-09-14 nothing posted it then either:
 * the owner assigned a parked 500-guest lead to Kelsea, got the guest email,
 * and Kelsea's channel stayed silent. A hand-off has to tell the person it
 * hands to.
 *
 * The card's buttons resolve against `salescard:{projectID}`, which capture
 * already wrote — so the state is READ back and its planner swapped rather
 * than rebuilt, keeping the guest details the form collected. If it has
 * expired (90 days) the lead itself is enough to rebuild a usable card.
 *
 * A reassign posts too: the new owner needs the card as much as the first one
 * did, and the old owner's card is already stale in their chat.
 */
export async function sendPlannerCardForAssignment(
  input: { lead: LeadView; planner: Planner; center: CenterConfig },
  deps: NotifyDeps = defaultNotifyDeps(),
): Promise<ChannelOutcome> {
  const { lead, planner, center } = input;
  const projectID = lead.bmi.projectId;
  const projectNumber = lead.bmi.projectNumber;
  if (!projectID || !projectNumber) return SKIP("no BMI project yet");

  const stateKey = salesCardKey(projectID);
  let state: SalesLeadState | null = null;
  try {
    const raw = await deps.redisGet(stateKey);
    if (raw) state = parseWithRawIds<SalesLeadState>(raw, [...BMI_ID_FIELDS, "projectID"]);
  } catch (err) {
    console.error("[crm] could not read the card state for a hand-off", {
      lead_id: lead.id,
      project_id: projectID,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const next: SalesLeadState = state
    ? { ...state, planner }
    : stateFor(
        { lead, mint: { status: "none", error: "rebuilt" }, source: lead.source },
        planner,
        center,
        projectID,
        projectNumber,
        deps.now(),
      );

  const card = await postCard(planner.teamsChatId, next, deps, {
    open: { url: crmDealUrl(lead.publicId), title: "Open in CRM" },
  });
  if (card.ok && card.activityId) {
    next.cardActivityId = card.activityId;
    await deps.redisSet(stateKey, JSON.stringify(next), STATE_TTL_SECONDS).catch(() => undefined);
  }
  await auditLine(
    deps,
    projectID,
    "teams",
    card,
    planner.displayName,
    `${planner.displayName}'s chat`,
  ).catch(() => undefined);
  return card;
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

/**
 * The card without its `Action.Execute` buttons.
 *
 * `sales_lead_ack` / `sales_lead_contacted` resolve against
 * `salescard:{projectID}` — which is written only once the project exists, and
 * whose `projectID` for an un-minted lead is the lead's public id. A button on
 * that card could never resolve, so the un-minted queue card ships read-only.
 */
export function withoutCardActions(card: Record<string, unknown>): Record<string, unknown> {
  const body = Array.isArray(card.body) ? (card.body as Array<Record<string, unknown>>) : [];
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(card)) if (k !== "actions" && k !== "body") rest[k] = v;
  return { ...rest, body: body.filter((b) => b?.type !== "ActionSet") };
}

/**
 * Put the @-mentions at the top of the card.
 *
 * Teams renders a mention only where the literal `<at>Name</at>` appears, so
 * the entities on the activity are half the job — this is the other half. A
 * lead nobody owns is the one thing in this system that needs a person to
 * look at it now, which is the whole reason it is allowed to ping two people.
 */
export function mentionBanner(
  card: Record<string, unknown>,
  mentions: ReadonlyArray<{ name: string }>,
): Record<string, unknown> {
  if (!mentions.length) return card;
  const body = Array.isArray(card.body) ? (card.body as unknown[]) : [];
  const at = mentions.map((m) => `<at>${m.name}</at>`).join(" ");
  return {
    ...card,
    body: [
      {
        type: "TextBlock",
        text: `${at} — this lead has nobody on it`,
        wrap: true,
        weight: "Bolder",
        color: "Attention",
      },
      ...body,
    ],
  };
}

/**
 * Add an "open this in the CRM" button.
 *
 * Owner, 2026-09-14: "This needs link that opens CRM to this lead for
 * assignment." The card's other two buttons are `Action.Execute` verbs that
 * mark the lead acknowledged or contacted in place; neither takes anybody to
 * the deal, so a director reading the card had to go and find it by hand.
 *
 * `Action.OpenUrl` goes into the SAME ActionSet as those verbs when there is
 * one, so it sits on the same row rather than starting a second bank of
 * buttons; a read-only card (no project yet, so no verbs) gets its own set.
 */
export function withOpenInCrm(
  card: Record<string, unknown>,
  url: string,
  title: string,
): Record<string, unknown> {
  const open = { type: "Action.OpenUrl", title, url };
  const body = Array.isArray(card.body) ? [...(card.body as Array<Record<string, unknown>>)] : [];
  const i = body.findIndex((b) => b?.type === "ActionSet");
  if (i >= 0) {
    const set = body[i]!;
    const actions = Array.isArray(set.actions) ? set.actions : [];
    body[i] = { ...set, actions: [...actions, open] };
  } else {
    body.push({ type: "ActionSet", actions: [open] });
  }
  return { ...card, body };
}

async function postCard(
  chatId: string,
  state: SalesLeadState,
  deps: NotifyDeps,
  opts: {
    readOnly?: boolean;
    mentions?: ReadonlyArray<{ id: string; name: string }>;
    /** `{url, title}` for the "open in the CRM" button. */
    open?: { url: string; title: string };
  } = {},
): Promise<ChannelOutcome> {
  try {
    let card = buildSalesLeadCardForState(state);
    if (opts.readOnly) card = withoutCardActions(card);
    if (opts.mentions?.length) card = mentionBanner(card, opts.mentions);
    if (opts.open) card = withOpenInCrm(card, opts.open.url, opts.open.title);
    const resp = await deps.sendCard(chatId, card, {
      summaryText: buildSalesLeadSummary(state),
      ...(opts.mentions?.length ? { mentions: [...opts.mentions] } : {}),
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

/** One line for the timeline when the welcome goes out on its own. */
export function summarizeGuestIntro(o: GuestIntroOutcome): string {
  const part = (label: string, c: ChannelOutcome) =>
    c.skipped
      ? `${label} skipped (${c.reason})`
      : c.ok
        ? `${label} sent`
        : `${label} FAILED (${c.error ?? "?"})`;
  return [part("Guest text", o.sms), part("guest email", o.email)].join(" · ");
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
    part("Assignment Pending card", o.unassignedCard),
  ].join(" · ");
}
