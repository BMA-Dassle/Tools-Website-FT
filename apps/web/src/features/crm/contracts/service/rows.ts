/**
 * `group_function_quotes` → `ContractRow` — the projection every contracts
 * screen reads, and the only place the v1 column names are spelled.
 *
 * PURE (apart from the clock it is handed): the rep join and the lead join are
 * passed in as lookups, so the whole mapping is testable without Neon.
 *
 * Money stays in CENTS and ids stay STRINGS. `bmi_reservation_id` is a
 * 17-digit Office project id — it is TEXT in the database and text here; it is
 * never parsed, compared numerically or round-tripped through a number.
 */

import { CENTRE_LIST } from "../../core/centres";
import { daysOut } from "../../core/dates";
import type { CentreCode, CrmRep, GfStatus } from "../../core/types";
import type { ContractRepRef, ContractRow } from "../contracts";
import { attentionReasons } from "./attention";

/** The columns a row projection reads — a `GroupFunctionQuote` satisfies it. */
export interface QuoteRowSource {
  id: number | string;
  contract_short_id: string | null;
  bmi_reservation_id: string;
  center_code: string;
  center_name: string;
  event_name: string | null;
  event_number: string | null;
  event_date: string;
  guest_count: number | null;
  guest_first_name: string;
  guest_last_name: string;
  guest_email: string;
  guest_phone: string | null;
  status: GfStatus;
  approval_required: boolean;
  is_tax_exempt: boolean;
  total_cents: number;
  tax_cents: number;
  deposit_due_cents: number;
  balance_cents: number;
  collected_cents: number;
  contract_sent_at: string | null;
  contract_signed_at: string | null;
  deposit_paid_at: string | null;
  balance_paid_at: string | null;
  balance_link_sent_at: string | null;
  square_dayof_order_id: string | null;
  square_settled_order_id: string | null;
  square_gift_card_gan: string | null;
  saved_card_brand: string | null;
  saved_card_last4: string | null;
  signed_pdf_url: string | null;
  planner_email: string | null;
  planner_first: string | null;
  planner_last: string | null;
  created_at: string;
  updated_at: string;
}

/** Neon hands TIMESTAMPTZ back as a Date when the driver is in object mode. */
function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v) return v;
  return null;
}

function ymd(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "string" ? v.slice(0, 10) : "";
}

/**
 * FT and HPFM share one Office tenant but NOT one `center_code`, so the slug
 * is the reliable key — never the clientKey (`core/centres.ts` says the same).
 */
export function centreForCenterCode(centerCode: string): CentreCode | null {
  return CENTRE_LIST.find((c) => c.centerCode === centerCode)?.code ?? null;
}

export function repRef(rep: CrmRep): ContractRepRef {
  return {
    slug: rep.slug,
    displayName: rep.displayName,
    firstName: rep.firstName,
    initials: rep.initials,
  };
}

/** email (lowercased) → rep, for the planner join. */
export function repIndexByEmail(reps: readonly CrmRep[]): Map<string, CrmRep> {
  const out = new Map<string, CrmRep>();
  for (const r of reps) if (r.email) out.set(r.email.toLowerCase(), r);
  return out;
}

export interface RowContext {
  now: Date;
  /** From `repIndexByEmail(await listReps())`. */
  repsByEmail: Map<string, CrmRep>;
  /** shortId → the CRM lead's public id, when a lead exists for the contract. */
  leadByShortId?: Map<string, string>;
  /** BMI project id → the CRM lead's public id (the join for pre-contract leads). */
  leadByProjectId?: Map<string, string>;
  /** Short ids with an unproven `-4` write in flight. */
  cancelPending?: ReadonlySet<string>;
}

export function toContractRow(q: QuoteRowSource, ctx: RowContext): ContractRow {
  const guestName = `${q.guest_first_name} ${q.guest_last_name}`.trim();
  const eventDate = ymd(q.event_date);
  const shortId = q.contract_short_id;
  const plannerEmail = q.planner_email ? q.planner_email.toLowerCase() : null;
  const rep = plannerEmail ? (ctx.repsByEmail.get(plannerEmail) ?? null) : null;
  const plannerName =
    [q.planner_first, q.planner_last].filter(Boolean).join(" ").trim() ||
    (rep ? rep.displayName : null);

  const base = {
    status: q.status,
    eventDate,
    sentAt: iso(q.contract_sent_at),
    balanceCents: q.balance_cents,
    createdAt: iso(q.created_at) ?? new Date(0).toISOString(),
    dayofOrderId: q.square_dayof_order_id,
    settledOrderId: q.square_settled_order_id,
  };

  const leadPublicId =
    (shortId ? ctx.leadByShortId?.get(shortId) : undefined) ??
    ctx.leadByProjectId?.get(q.bmi_reservation_id) ??
    null;

  return {
    quoteId: String(q.id),
    shortId,
    projectId: String(q.bmi_reservation_id),
    title: q.event_name?.trim() || guestName || `Event ${q.event_number ?? ""}`.trim(),
    guestName,
    guestPhone: q.guest_phone,
    guestEmail: q.guest_email,
    centre: centreForCenterCode(q.center_code),
    centerCode: q.center_code,
    centerName: q.center_name,
    eventDate,
    eventNumber: q.event_number,
    guests: q.guest_count,
    status: q.status,
    postPaid: Boolean(q.approval_required),
    taxExempt: Boolean(q.is_tax_exempt),
    totalCents: q.total_cents,
    taxCents: q.tax_cents,
    depositDueCents: q.deposit_due_cents,
    balanceCents: q.balance_cents,
    collectedCents: q.collected_cents,
    sentAt: base.sentAt,
    signedAt: iso(q.contract_signed_at),
    depositPaidAt: iso(q.deposit_paid_at),
    balancePaidAt: iso(q.balance_paid_at),
    balanceLinkSentAt: iso(q.balance_link_sent_at),
    dayofOrderId: q.square_dayof_order_id,
    settledOrderId: q.square_settled_order_id,
    giftCardGan: q.square_gift_card_gan,
    savedCardBrand: q.saved_card_brand,
    savedCardLast4: q.saved_card_last4,
    signedPdfUrl: q.signed_pdf_url,
    plannerEmail,
    plannerName,
    rep: rep ? repRef(rep) : null,
    leadPublicId,
    daysOut: daysOut(eventDate, ctx.now),
    sentAgoDays: base.sentAt
      ? Math.max(0, Math.floor((ctx.now.getTime() - Date.parse(base.sentAt)) / 86_400_000))
      : null,
    reasons: attentionReasons(base, ctx.now),
    createdAt: base.createdAt,
    updatedAt: iso(q.updated_at) ?? base.createdAt,
  };
}
