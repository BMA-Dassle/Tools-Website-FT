/**
 * THE DEAL PROJECTION — a joined row from `data/deals-db` becomes a `Deal`.
 *
 * PURE. No Neon, no Node, no clock of its own: every rule that decides what a
 * deal IS lives here so a test can hold it, and so the three lenses cannot
 * drift apart by each inventing its own fallback.
 *
 * THE FALLBACKS ARE THE POINT. A deal with no `crm_leads` row is not a gap to
 * be filled by writing one; it is a project whose status and owner we can read
 * straight off BMI. `statusFromBmiState` and `repFromProject` below are the
 * same rules `leads/service/adopt-bmi.ts` used to FREEZE into 182 adopted
 * rows — computed at read time instead, which is why those rows are now
 * redundant. Owner, 2026-09-13: "Don't write rows to block gaps we need to do
 * this right before we start using it."
 *
 * COALESCE ORDER IS BMI FIRST, and deliberately. When Office and the signed
 * contract disagree about the date or the centre, Office is where the event
 * actually happens — a reschedule moves the project days before anybody
 * re-issues the PDF (project c31e3aec moved Sep 13 → Sep 19 while the signed
 * document still said Sep 13). Measured: 7 of 491 joined rows disagree on the
 * day and 21 on the centre, and in every case the mirror is the live answer.
 */

import { centreByLocationId } from "../core/centres";
import type { CentreCode } from "../core/types";
import type {
  Deal,
  DealLead,
  DealProject,
  DealQuote,
  DealRep,
  DealRepSource,
  DealSpine,
  DealStatusSource,
} from "./contracts";

// ---------------------------------------------------------------------------
// BMI state → our status
// ---------------------------------------------------------------------------

/**
 * BMI state → our status, for the states a deal can sit in while it is still
 * being SOLD. Read off Office metadata for both tenants on 2026-09-13; the two
 * centres name the same steps with different ids, which is why this is keyed
 * per tenant.
 *
 * The "deposit requested" family maps to `contract` rather than `deposit`: the
 * money has been ASKED for, not received, so the deal is still open work.
 */
export const OPEN_STATE_STATUS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  headpinzftmyers: {
    "3891928": "new", // New Lead
    "7845185": "contacted", // Contacted
    "-2": "quote", // Pending Quote
    "49130082": "contract", // Send Contract
    "48952154": "contract", // Pending Signed Contract
    "3272786": "contract", // Deposit Requested (HPFM)
    "15737202": "contract", // Deposit Requested (FT)
    "48952156": "contract", // New Deposit Requested - FT
  },
  headpinznaples: {
    "1565479": "new", // New Lead
    "3703830": "contacted", // Contacted
    "-2": "quote", // Pending Quote
    "8020645": "contract", // Send Contract
    "8007473": "contract", // Pending Signed Contract
    "1190814": "contract", // Deposit Requested
  },
};

/**
 * The states that mean the deal is WON. Confirmation and its variants are the
 * booked state; Deposit Paid is its own.
 */
export const WON_STATE_STATUS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  headpinzftmyers: {
    "-3": "confirmed", // Confirmation
    "3274635": "confirmed", // Confirmation + Waiver
    "55397028": "confirmed", // Confirmation - Express Lane
    "55466363": "confirmed", // Confirmation - VIP
    "-106": "deposit", // Deposit Paid
  },
  headpinznaples: {
    "-3": "confirmed", // Confirmation
    "1191926": "confirmed", // Confirmation + Waiver
    "8489113": "confirmed", // Confirmation - Kiosk
    "-106": "deposit", // Deposite Paid (Office's spelling)
  },
};

/**
 * Cancellation, in both tenants. A LOST deal is not a gap — it is an answer,
 * and the Contracts screen very much wants it: 9 of the 25 open contracts with
 * no lead sit on a CANCELLED project, 7 of them for a FUTURE event with the
 * contract still out for signature. Adoption skipped those on purpose and that
 * is exactly how they became invisible.
 */
export const LOST_STATE_STATUS: Readonly<Record<string, string>> = {
  "-4": "lost", // Cancellation
};

/** Every state we can name, open, won and lost, flattened per tenant. */
export const ALL_STATE_STATUS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.fromEntries(
    [...new Set([...Object.keys(OPEN_STATE_STATUS), ...Object.keys(WON_STATE_STATUS)])].map(
      (clientKey) => [
        clientKey,
        {
          ...(OPEN_STATE_STATUS[clientKey] ?? {}),
          ...(WON_STATE_STATUS[clientKey] ?? {}),
          ...LOST_STATE_STATUS,
        },
      ],
    ),
  );

/**
 * The status a deal with no lead row would have, read off BMI.
 *
 * Returns null for a state we have never mapped — which is an honest "we do
 * not know", and the board shows it in its own tray rather than guessing
 * `new` and putting somebody else's booking in a planner's queue.
 */
export function statusFromBmiState(
  clientKey: string | null,
  stateId: string | null,
): string | null {
  if (!clientKey || !stateId) return null;
  return ALL_STATE_STATUS[clientKey]?.[String(stateId)] ?? null;
}

// ---------------------------------------------------------------------------
// BMI responsible → our rep
// ---------------------------------------------------------------------------

/**
 * OFFICE USER IDS ARE PER TENANT and `crm_reps.bmi_user_id` holds only one.
 *
 * The same person is a different id at each centre — Fort Myers first, Naples
 * second: eric 75262 / 25228 · lori 465247 / 41096 · stephanie 465242 /
 * 1559644 · jacob 7251049 / 3690605 · kelsea 28267036 / 6338800 · gs 30080112
 * / 6400642. The roster column carries the Fort Myers value, so every NAPLES
 * project matched nobody on id alone.
 */
export const OFFICE_ID_ALIASES: Readonly<Record<string, string>> = {
  "25228": "eric",
  "41096": "lori",
  "1559644": "stephanie",
  "3690605": "jacob",
  "6338800": "kelsea",
  "6400642": "gs",
};

/** Office display names that are not the roster's display name. */
export const OFFICE_NAME_ALIASES: Readonly<Record<string, string>> = {
  callcenter: "gs",
  "call center": "gs",
  "guest services": "gs",
};

/** The roster fields the rep match needs — a `CrmRep` satisfies it. */
export interface RepMatchRow {
  id: string;
  slug: string;
  displayName: string;
  firstName: string;
  initials: string;
  email: string | null;
  bmiUserId: string | null;
  bmiUsername: string | null;
}

/**
 * The roster, indexed every way a project or a quote might name its owner.
 *
 * A first name is only accepted when exactly ONE active rep answers to it, so
 * two Kelseas fall through to "no rep" rather than picking one at random.
 * Office's `responsible` is frequently just "Kelsea" or "Lori" — the full name
 * `bmi_username` holds is the exception, not the rule.
 */
export interface RepIndex {
  byOfficeId: Map<string, RepMatchRow>;
  bySlug: Map<string, RepMatchRow>;
  byName: Map<string, RepMatchRow>;
  byEmail: Map<string, RepMatchRow>;
  byId: Map<string, RepMatchRow>;
}

export function buildRepIndex(reps: readonly RepMatchRow[]): RepIndex {
  const byOfficeId = new Map<string, RepMatchRow>();
  const bySlug = new Map<string, RepMatchRow>();
  const byName = new Map<string, RepMatchRow>();
  const byEmail = new Map<string, RepMatchRow>();
  const byId = new Map<string, RepMatchRow>();
  for (const r of reps) {
    byId.set(r.id, r);
    bySlug.set(r.slug, r);
    if (r.bmiUserId) byOfficeId.set(r.bmiUserId, r);
    if (r.email) byEmail.set(r.email.toLowerCase(), r);
    if (r.bmiUsername) byName.set(r.bmiUsername.toLowerCase(), r);
    if (r.displayName) byName.set(r.displayName.toLowerCase(), r);
  }
  const firstNameCounts = new Map<string, number>();
  for (const r of reps) {
    const f = r.firstName?.toLowerCase();
    if (f) firstNameCounts.set(f, (firstNameCounts.get(f) ?? 0) + 1);
  }
  for (const r of reps) {
    const f = r.firstName?.toLowerCase();
    if (f && firstNameCounts.get(f) === 1 && !byName.has(f)) byName.set(f, r);
  }
  return { byOfficeId, bySlug, byName, byEmail, byId };
}

export function repRefOf(rep: RepMatchRow): DealRep {
  return {
    id: rep.id,
    slug: rep.slug,
    displayName: rep.displayName,
    firstName: rep.firstName,
    initials: rep.initials,
  };
}

/** Office's `responsible` → a rep on the roster, by id, alias then name. */
export function repFromProject(
  index: RepIndex,
  responsibleUserId: string | null,
  responsibleName: string | null,
): RepMatchRow | null {
  const byId = responsibleUserId ? index.byOfficeId.get(responsibleUserId) : undefined;
  if (byId) return byId;
  const aliasSlug =
    (responsibleUserId ? OFFICE_ID_ALIASES[responsibleUserId] : undefined) ??
    (responsibleName ? OFFICE_NAME_ALIASES[responsibleName.trim().toLowerCase()] : undefined);
  const byAlias = aliasSlug ? index.bySlug.get(aliasSlug) : undefined;
  if (byAlias) return byAlias;
  return (responsibleName ? index.byName.get(responsibleName.trim().toLowerCase()) : null) ?? null;
}

// ---------------------------------------------------------------------------
// The row the SQL hands back
// ---------------------------------------------------------------------------

/** Exactly the columns `DEAL_SELECT` emits. Ids arrive as text, money as text. */
export interface DealRowRaw {
  spine: DealSpine;
  key_project_id: string | null;
  key_quote_id: string | null;
  key_lead_id: string | null;

  p_project_id: string | null;
  p_client_key: string | null;
  p_location_id: number | null;
  p_number: string | null;
  p_name: string | null;
  p_state_id: string | null;
  p_state_name: string | null;
  p_kind_id: string | null;
  p_responsible_user_id: string | null;
  p_responsible_name: string | null;
  p_event_date: string | null;
  p_event_time: string | null;
  p_event_start: string | null;
  p_persons: number | null;
  p_total_value_cents: string | number | null;
  p_balance_cents: string | number | null;
  p_person_id: string | null;
  p_person_name: string | null;
  p_person_phone: string | null;
  p_person_email: string | null;
  p_synced_at: string | null;

  l_id: string | null;
  l_public_id: string | null;
  l_status_id: string | null;
  l_assigned_rep_id: string | null;
  l_assigned_at: string | null;
  l_first_touch_at: string | null;
  l_next_action_kind: string | null;
  l_next_action_due: string | null;
  l_next_action_label: string | null;
  l_value_cents: string | number | null;
  l_source: string | null;
  l_created_by: string | null;
  l_created_at: string | null;
  l_event_date: string | null;
  l_event_time: string | null;
  l_centre: string | null;
  l_guests: number | null;
  l_rep_slug: string | null;
  l_rep_name: string | null;
  l_guest_first: string | null;
  l_guest_last: string | null;
  l_guest_phone: string | null;
  l_guest_email: string | null;
  l_account_name: string | null;

  q_id: string | null;
  q_contract_short_id: string | null;
  q_status: string | null;
  q_center_code: string | null;
  q_center_name: string | null;
  q_event_name: string | null;
  q_event_number: string | null;
  q_event_date: string | null;
  q_guest_count: number | null;
  q_guest_first_name: string | null;
  q_guest_last_name: string | null;
  q_guest_email: string | null;
  q_guest_phone: string | null;
  q_approval_required: boolean | null;
  q_is_tax_exempt: boolean | null;
  q_total_cents: number | string | null;
  q_tax_cents: number | string | null;
  q_deposit_due_cents: number | string | null;
  q_balance_cents: number | string | null;
  q_collected_cents: number | string | null;
  q_contract_sent_at: string | null;
  q_contract_signed_at: string | null;
  q_deposit_paid_at: string | null;
  q_balance_paid_at: string | null;
  q_balance_link_sent_at: string | null;
  q_square_dayof_order_id: string | null;
  q_square_settled_order_id: string | null;
  q_square_gift_card_gan: string | null;
  q_saved_card_brand: string | null;
  q_saved_card_last4: string | null;
  q_signed_pdf_url: string | null;
  q_planner_email: string | null;
  q_planner_first: string | null;
  q_planner_last: string | null;
  q_created_at: string | null;
  q_updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Neon hands TIMESTAMPTZ back as a Date when the driver is in object mode. */
function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v) return v;
  return null;
}

function ymd(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && v) return v.slice(0, 10);
  return null;
}

/** Money and counts arrive as text from a BIGINT. Never `Number()` an ID. */
function cents(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function centsOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  return cents(v);
}

// ---------------------------------------------------------------------------
// Overlay projections
// ---------------------------------------------------------------------------

export function projectOf(r: DealRowRaw): DealProject | null {
  if (!r.p_project_id) return null;
  return {
    projectId: r.p_project_id,
    clientKey: r.p_client_key ?? "",
    locationId: r.p_location_id ?? null,
    number: r.p_number,
    name: r.p_name,
    stateId: r.p_state_id,
    stateName: r.p_state_name,
    kindId: r.p_kind_id,
    responsibleUserId: r.p_responsible_user_id,
    responsibleName: r.p_responsible_name,
    eventDate: ymd(r.p_event_date),
    eventStart: iso(r.p_event_start),
    persons: r.p_persons ?? null,
    totalValueCents: centsOrNull(r.p_total_value_cents),
    balanceCents: centsOrNull(r.p_balance_cents),
    personId: r.p_person_id,
    personName: r.p_person_name,
    personPhone: r.p_person_phone,
    personEmail: r.p_person_email,
    syncedAt: iso(r.p_synced_at),
  };
}

export function leadOf(r: DealRowRaw): DealLead | null {
  if (!r.l_id || !r.l_public_id) return null;
  return {
    id: r.l_id,
    publicId: r.l_public_id,
    status: r.l_status_id ?? "new",
    repId: r.l_assigned_rep_id,
    repSlug: r.l_rep_slug,
    repName: r.l_rep_name,
    assignedAt: iso(r.l_assigned_at),
    firstTouchAt: iso(r.l_first_touch_at),
    nextAction: r.l_next_action_due
      ? {
          kind: r.l_next_action_kind ?? "call",
          due: iso(r.l_next_action_due) ?? "",
          label: r.l_next_action_label ?? null,
        }
      : null,
    valueCents: cents(r.l_value_cents),
    source: r.l_source ?? "",
    createdBy: r.l_created_by,
    createdAt: iso(r.l_created_at) ?? new Date(0).toISOString(),
    adopted: r.l_created_by === "crm-adopt",
  };
}

export function quoteOf(r: DealRowRaw): DealQuote | null {
  if (!r.q_id) return null;
  return {
    quoteId: r.q_id,
    shortId: r.q_contract_short_id,
    status: (r.q_status ?? "pending") as DealQuote["status"],
    centerCode: r.q_center_code ?? "",
    centerName: r.q_center_name ?? "",
    eventName: r.q_event_name,
    eventNumber: r.q_event_number,
    eventDate: ymd(r.q_event_date) ?? "",
    guestCount: r.q_guest_count ?? null,
    guestFirstName: r.q_guest_first_name ?? "",
    guestLastName: r.q_guest_last_name ?? "",
    guestEmail: r.q_guest_email ?? "",
    guestPhone: r.q_guest_phone,
    approvalRequired: r.q_approval_required === true,
    isTaxExempt: r.q_is_tax_exempt === true,
    totalCents: cents(r.q_total_cents),
    taxCents: cents(r.q_tax_cents),
    depositDueCents: cents(r.q_deposit_due_cents),
    balanceCents: cents(r.q_balance_cents),
    collectedCents: cents(r.q_collected_cents),
    sentAt: iso(r.q_contract_sent_at),
    signedAt: iso(r.q_contract_signed_at),
    depositPaidAt: iso(r.q_deposit_paid_at),
    balancePaidAt: iso(r.q_balance_paid_at),
    balanceLinkSentAt: iso(r.q_balance_link_sent_at),
    dayofOrderId: r.q_square_dayof_order_id,
    settledOrderId: r.q_square_settled_order_id,
    giftCardGan: r.q_square_gift_card_gan,
    savedCardBrand: r.q_saved_card_brand,
    savedCardLast4: r.q_saved_card_last4,
    signedPdfUrl: r.q_signed_pdf_url,
    plannerEmail: r.q_planner_email ? r.q_planner_email.toLowerCase() : null,
    plannerFirst: r.q_planner_first,
    plannerLast: r.q_planner_last,
    createdAt: iso(r.q_created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(r.q_updated_at) ?? new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The merged deal
// ---------------------------------------------------------------------------

function centreOf(project: DealProject | null, quote: DealQuote | null, leadCentre: string | null) {
  const fromProject = project?.locationId ? centreByLocationId(project.locationId) : null;
  if (fromProject) return { centre: fromProject.code, centerCode: fromProject.centerCode };
  if (quote?.centerCode) {
    const c = centreByCenterCode(quote.centerCode);
    return { centre: c, centerCode: quote.centerCode };
  }
  if (leadCentre) return { centre: leadCentre as CentreCode, centerCode: null };
  return { centre: null, centerCode: null };
}

function centreByCenterCode(centerCode: string): CentreCode | null {
  if (centerCode === "fort-myers") return "HPFM";
  if (centerCode === "fasttrax") return "FT";
  if (centerCode === "naples") return "HPN";
  return null;
}

/** "Juniper Landscaping" — the event name, else the guest, else the number. */
function titleOf(
  project: DealProject | null,
  quote: DealQuote | null,
  guestName: string,
  number: string | null,
): string {
  const fromQuote = quote?.eventName?.trim();
  if (fromQuote) return fromQuote;
  const fromProject = project?.name?.trim();
  if (fromProject) return fromProject;
  if (guestName) return guestName;
  return number ? `Event ${number}` : "Untitled event";
}

export interface ToDealContext {
  reps: RepIndex;
}

/**
 * One joined row → one `Deal`.
 *
 * The merge order is stated once, here, and every lens obeys it: BMI (the
 * spine) first, the contract second, our own lead row last. The only field
 * where the lead wins is the one it owns outright — the sales status and the
 * assignment a planner made by hand.
 */
export function toDeal(r: DealRowRaw, ctx: ToDealContext): Deal {
  const project = projectOf(r);
  const lead = leadOf(r);
  const quote = quoteOf(r);

  const projectId = r.key_project_id ?? project?.projectId ?? null;
  const key = projectId
    ? projectId
    : r.key_quote_id
      ? `q:${r.key_quote_id}`
      : `l:${r.key_lead_id ?? lead?.id ?? "unknown"}`;

  const { centre, centerCode } = centreOf(project, quote, r.l_centre);

  const guestName =
    [quote?.guestFirstName, quote?.guestLastName].filter(Boolean).join(" ").trim() ||
    [r.l_guest_first, r.l_guest_last].filter(Boolean).join(" ").trim() ||
    (project?.personName ?? "").trim();

  // Our status when a planner owns it; BMI's mapped state when nobody does.
  // A deal that is cancelled in Office is `lost` even if a stale lead row still
  // says `contract` — Office is where a cancellation actually happens.
  let status: string | null = null;
  let statusSource: DealStatusSource = "none";
  if (lead) {
    status = lead.status;
    statusSource = "lead";
  } else {
    const fromBmi = statusFromBmiState(project?.clientKey ?? null, project?.stateId ?? null);
    if (fromBmi) {
      status = fromBmi;
      statusSource = "bmi";
    } else if (quote) {
      status = null;
      statusSource = "quote";
    }
  }

  let rep: DealRep | null = null;
  let repSource: DealRepSource = "none";
  const leadRep = lead?.repId ? ctx.reps.byId.get(lead.repId) : undefined;
  if (leadRep) {
    rep = repRefOf(leadRep);
    repSource = "lead";
  } else {
    const fromProject = project
      ? repFromProject(ctx.reps, project.responsibleUserId, project.responsibleName)
      : null;
    if (fromProject) {
      rep = repRefOf(fromProject);
      repSource = "bmi";
    } else if (quote?.plannerEmail) {
      const fromPlanner = ctx.reps.byEmail.get(quote.plannerEmail);
      if (fromPlanner) {
        rep = repRefOf(fromPlanner);
        repSource = "planner";
      }
    }
  }

  const eventDate = project?.eventDate ?? quote?.eventDate ?? ymd(r.l_event_date);
  // `p_event_time` is rendered by Postgres from `event_start`, not sliced off
  // an ISO instant: `ISO()` normalises to UTC and the slice would report a
  // 14:00 party as 18:00 for half the year.
  const eventTime = r.p_event_time ?? r.l_event_time ?? null;

  return {
    key,
    spine: r.spine,
    projectId,
    project,
    lead,
    quote,
    centre,
    centerCode,
    eventDate,
    eventTime,
    title: titleOf(project, quote, guestName, project?.number ?? quote?.eventNumber ?? null),
    guestName,
    guestPhone: quote?.guestPhone ?? r.l_guest_phone ?? project?.personPhone ?? null,
    guestEmail: quote?.guestEmail ?? r.l_guest_email ?? project?.personEmail ?? null,
    guests: quote?.guestCount ?? project?.persons ?? r.l_guests ?? null,
    valueCents: quote ? quote.totalCents : (project?.totalValueCents ?? lead?.valueCents ?? 0),
    status,
    statusSource,
    rep,
    repSource,
    hasQuote: quote !== null,
    hasLead: lead !== null,
  };
}
