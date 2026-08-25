/**
 * Manage-reservation service: single-reservation detail composition, the
 * lazy Square payment timeline, and the notes / guest-contact mutations.
 *
 * Detail is EAGER-Neon-only (no Square/BMI/QAMF calls) so the manage modal
 * opens instantly; the payment timeline is a separate call made when the
 * Payments tab activates (3–8 live Square reads).
 *
 * BMI ids are strings end to end — never Number() them.
 */
import {
  buildQamfMemo,
  getBowlingReservation,
  getBowlingReservationByBillId,
  listCancelGroupReservations,
  updateBowlingReservationNotes,
  updateGuestContact,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { isDbConfigured, sql } from "@/lib/db";
import { listCancelEventsByAnchors, type CancelEventRow } from "@/lib/reservation-cancel-log";
import { listEditEventsByAnchors, type EditEventRow } from "@/lib/reservation-edit-log";
import { patchReservation } from "@/lib/qamf-bowling";
import {
  fetchGiftCardFacts,
  fetchOrderFacts,
  fetchPaymentFacts,
} from "~/features/cancellation/square-actions";
import { fetchRefundFacts } from "~/features/reservation-edit/square-actions";
import { resolveCenter } from "~/features/cancellation/centers";
import { getCardStatusForReservation } from "~/features/card-vault";
import { listAdminActions, recordAdminAction, type AdminActionRow } from "./audit";
import { syncNoteToBmi } from "./bmi-notes";

// ── Detail ──────────────────────────────────────────────────────────────────

/** Slim per-leg summary for the money-group strip + merged itinerary. */
export interface DetailLeg {
  id: number;
  productKind: string;
  centerCode: string;
  status: string;
  bookedAt: string;
  guestName?: string;
  playerCount?: number;
  depositCents: number;
  totalCents: number;
  comboSpecialId?: string;
  qamfReservationId?: string;
  /** BMI bill id — string, never parsed. */
  bmiBillId?: string;
  squareDepositOrderId?: string;
  squareDayofOrderId?: string;
  dayofOrderLane?: string;
  dayofPaymentId?: string;
  attractionBookings: BowlingReservation["attractionBookings"];
  bookingMetadata?: Record<string, unknown>;
  cancellationOutcome?: string;
  storeCreditGiftCardGan?: string;
  refundCents: number;
  storeCreditCents: number;
}

export type HistoryEntry =
  | { source: "cancel"; at: string; event: CancelEventRow }
  | { source: "action"; at: string; event: AdminActionRow }
  | { source: "edit"; at: string; event: EditEventRow };

export interface ReservationDetail {
  reservation: BowlingReservation & { lines: unknown[] } & EditMoneyFacts;
  /** Every row sharing the anchor's deposit charge (combo legs, mixed carts). */
  group: DetailLeg[];
  history: HistoryEntry[];
}

/**
 * Money facts the board and detail rows need that `rowToReservation` does
 * not carry (both come from the 2026-08-24 edit/refund audit).
 */
export interface EditMoneyFacts {
  /**
   * Cents refunded AFTER booking through Edit/Refund
   * (bowling_reservations.edit_refund_cents). Separate from the cancel
   * cascade's refund_cents, whose semantics (never summed across legs, exported
   * as the cancel refund) must not change.
   */
  editRefundCents: number;
  /**
   * Another row on the SAME day-of order recorded the lane-open payment. A
   * bowling+attraction / bowling+race cart writes two rows sharing one order and
   * only the bowling leg carries dayof_payment_id — the other leg can still
   * refund from that order, so the Refund door must open on it too.
   */
  groupHasDayofPayment: boolean;
}

const NO_MONEY_FACTS: EditMoneyFacts = { editRefundCents: 0, groupHasDayofPayment: false };

/**
 * One batched read for a page of reservation ids. `edit_refund_cents` is read
 * through `to_jsonb(r) ->> …` so the query also works before the engine's
 * `ensureBowlingSchema` has added the column — a display chip must never be
 * able to 500 the board.
 */
export async function fetchEditMoneyFacts(ids: number[]): Promise<Map<number, EditMoneyFacts>> {
  const out = new Map<number, EditMoneyFacts>();
  if (ids.length === 0 || !isDbConfigured()) return out;
  const q = sql();
  const rows = await q`
    SELECT r.id,
           (to_jsonb(r) ->> 'edit_refund_cents') AS edit_refund_cents,
           EXISTS (
             SELECT 1 FROM bowling_reservations s
             WHERE s.square_dayof_order_id = r.square_dayof_order_id
               AND s.id <> r.id
               AND s.dayof_payment_id IS NOT NULL
           ) AS group_has_dayof_payment
    FROM bowling_reservations r
    WHERE r.id = ANY(${ids})
  `;
  for (const row of rows as Array<Record<string, unknown>>) {
    // Plain integer ids / cents — not BMI ids, Number() is safe here.
    out.set(Number(row.id), {
      editRefundCents: Number(row.edit_refund_cents ?? 0) || 0,
      groupHasDayofPayment: row.group_has_dayof_payment === true,
    });
  }
  return out;
}

/**
 * Attach {@link EditMoneyFacts} to rows that already carry a Neon id. Best
 * effort: a failed read leaves every row at the zero facts rather than failing
 * the list — the facts drive a chip and a button, never money.
 */
export async function attachEditMoneyFacts<T extends { id: number }>(
  rows: T[],
): Promise<Array<T & EditMoneyFacts>> {
  let facts = new Map<number, EditMoneyFacts>();
  try {
    facts = await fetchEditMoneyFacts(rows.map((r) => r.id));
  } catch (err) {
    console.warn(
      "[reservations-admin] edit money facts unavailable:",
      err instanceof Error ? err.message : err,
    );
  }
  return rows.map((r) => ({ ...r, ...(facts.get(r.id) ?? NO_MONEY_FACTS) }));
}

function toLeg(r: BowlingReservation): DetailLeg {
  return {
    id: r.id,
    productKind: r.productKind,
    centerCode: r.centerCode,
    status: r.status,
    bookedAt: r.bookedAt,
    guestName: r.guestName,
    playerCount: r.playerCount,
    depositCents: r.depositCents,
    totalCents: r.totalCents,
    comboSpecialId: r.comboSpecialId,
    qamfReservationId: r.qamfReservationId,
    bmiBillId: r.bmiBillId,
    squareDepositOrderId: r.squareDepositOrderId,
    squareDayofOrderId: r.squareDayofOrderId,
    dayofOrderLane: r.dayofOrderLane,
    dayofPaymentId: r.dayofPaymentId,
    attractionBookings: r.attractionBookings ?? [],
    bookingMetadata: r.bookingMetadata,
    cancellationOutcome: r.cancellationOutcome,
    storeCreditGiftCardGan: r.storeCreditGiftCardGan,
    refundCents: r.refundCents,
    storeCreditCents: r.storeCreditCents,
  };
}

export async function getReservationDetail(query: {
  id?: number;
  billId?: string;
}): Promise<ReservationDetail | null> {
  let anchor: BowlingReservation | null = null;
  let lines: unknown[] = [];
  if (query.id !== undefined) {
    const full = await getBowlingReservation(query.id);
    if (full) {
      const { lines: l, ...rest } = full;
      anchor = rest;
      lines = l;
    }
  } else if (query.billId) {
    const byBill = await getBowlingReservationByBillId(query.billId);
    if (byBill) {
      const full = await getBowlingReservation(byBill.id);
      if (full) {
        const { lines: l, ...rest } = full;
        anchor = rest;
        lines = l;
      }
    }
  }
  if (!anchor) return null;

  const group = await listCancelGroupReservations(anchor);
  const legIds = group.map((g) => g.id);

  const [cancelEvents, actions, editEvents, [reservation]] = await Promise.all([
    listCancelEventsByAnchors(legIds),
    listAdminActions(legIds),
    // Edits carry their own money (top-up charges, refunds, store credit) and
    // were previously invisible here — every mutation of a reservation has to
    // be readable from this tab.
    listEditEventsByAnchors(legIds),
    // Post-booking refunds + the shared-order payment fact (Overview chip,
    // Refund door on the non-paying leg).
    attachEditMoneyFacts([{ ...anchor, lines }]),
  ]);

  const history: HistoryEntry[] = [
    ...cancelEvents.map((e): HistoryEntry => ({ source: "cancel", at: e.createdAt, event: e })),
    ...actions.map((e): HistoryEntry => ({ source: "action", at: e.createdAt, event: e })),
    ...(editEvents ?? []).map((e): HistoryEntry => ({ source: "edit", at: e.createdAt, event: e })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return {
    reservation,
    group: group.map(toLeg),
    history,
  };
}

// ── Payment timeline ────────────────────────────────────────────────────────

/** square_dayof_order_id may be a bare id or a JSON array (combo legs). */
export function firstOrderId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return String(parsed[0]);
  } catch {
    /* bare id — fall through */
  }
  return raw;
}

export interface TimelineNode {
  kind: "deposit" | "funding_gift_card" | "dayof_order" | "store_credit" | "refunds";
  label: string;
  /** Which leg this node belongs to (day-of orders); absent for group-level nodes. */
  legId?: number;
  order?: {
    id: string;
    state: string;
    /** Square location id — powers the dashboard transaction deep link. */
    locationId?: string;
    totalCents: number;
    netDueCents: number;
    tenders: Array<{
      paymentId: string;
      amountCents: number;
      status?: string;
      refundedCents?: number;
    }>;
  };
  giftCard?: { id: string; gan: string; state: string; balanceCents: number };
  /**
   * Every refund this money group has issued, from the cancel + edit ledgers,
   * with live Square status. PENDING entries matter: a gift-card credit posts
   * asynchronously, so staff need to see money that is in flight rather than
   * assume a refund that has not landed is missing.
   */
  refunds?: Array<{
    id: string;
    amountCents: number;
    status: string;
    /** Payment the refund was issued against. */
    paymentId: string;
    /** "cancel" | "edit" — which cascade recorded it. */
    source: string;
  }>;
  /** Node-level failure — the rest of the timeline still renders. */
  error?: string;
}

/** Card-vault provenance for the Payments tab's "Card on file" row. */
export interface SavedCardStatus {
  brand: string | null;
  last4: string | null;
  /** True = a Square card id exists on the row. False = nothing was ever
   *  kept: see `captureSkipReason` / `captureLastError` for why. */
  captured: boolean;
  /** True = WE silently captured it at booking (auto-removed ~72h after the
   *  visit); false = the card pre-existed on the customer. */
  weAdded: boolean;
  /** True = never auto-removed (guest opted in / admin grant). */
  permanentConsent: boolean;
  /** ISO timestamp when the sweep disabled it; null = still on file. */
  disabledAt: string | null;
  /** Why no card could be kept: "wallet" | "gift_card" | "no_source_kind" |
   *  "terminal:<SQUARE_CODE>"; null on a real capture or a retrying row. */
  captureSkipReason: string | null;
  /** Last CreateCard error text (a retrying or retired row); null otherwise. */
  captureLastError: string | null;
  captureAttempts: number;
}

export interface PaymentTimeline {
  nodes: TimelineNode[];
  /** Card-on-file status for this money group; null = no vault record. */
  savedCard: SavedCardStatus | null;
}

async function orderNode(
  kind: "deposit" | "dayof_order",
  label: string,
  orderId: string,
  opts?: { legId?: number; withPayments?: boolean },
): Promise<TimelineNode> {
  try {
    const facts = await fetchOrderFacts(orderId);
    let tenders: NonNullable<TimelineNode["order"]>["tenders"] = facts.tenders;
    if (opts?.withPayments) {
      tenders = await Promise.all(
        facts.tenders.map(async (t) => {
          try {
            const p = await fetchPaymentFacts(t.paymentId);
            return { ...t, status: p.status, refundedCents: p.refundedCents };
          } catch {
            return t;
          }
        }),
      );
    }
    return {
      kind,
      label,
      legId: opts?.legId,
      order: {
        id: facts.id,
        state: facts.state,
        locationId: facts.locationId || undefined,
        totalCents: facts.totalCents,
        netDueCents: facts.netDueCents,
        tenders,
      },
    };
  } catch (err) {
    return {
      kind,
      label,
      legId: opts?.legId,
      error: err instanceof Error ? err.message : "order fetch failed",
    };
  }
}

async function giftCardNode(
  kind: "funding_gift_card" | "store_credit",
  label: string,
  giftCardId: string,
): Promise<TimelineNode> {
  try {
    const gc = await fetchGiftCardFacts(giftCardId);
    return {
      kind,
      label,
      giftCard: { id: gc.id, gan: gc.gan, state: gc.state, balanceCents: gc.balanceCents },
    };
  } catch (err) {
    return { kind, label, error: err instanceof Error ? err.message : "gift card fetch failed" };
  }
}

/**
 * Every refund recorded for this money group, resolved against Square for its
 * live status. Reads both ledgers because a reservation can be refunded by a
 * cancellation OR by an edit (item refunds, decreases), and the tab has to
 * show either.
 */
async function refundsNode(legIds: number[]): Promise<TimelineNode> {
  const label = "Refunds";
  try {
    const [cancels, edits] = await Promise.all([
      listCancelEventsByAnchors(legIds),
      listEditEventsByAnchors(legIds),
    ]);
    const seen = new Set<string>();
    const ids: Array<{ id: string; source: string }> = [];
    for (const c of cancels ?? []) {
      for (const id of c.refundIds ?? []) {
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push({ id, source: "cancel" });
        }
      }
    }
    for (const e of edits ?? []) {
      for (const id of e.refundIds ?? []) {
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push({ id, source: "edit" });
        }
      }
    }
    if (ids.length === 0) return { kind: "refunds", label, refunds: [] };

    const refunds = (
      await Promise.all(
        ids.map(async ({ id, source }) => {
          try {
            const f = await fetchRefundFacts(id);
            return {
              id,
              amountCents: f.amountCents,
              status: f.status,
              paymentId: f.paymentId,
              source,
            };
          } catch {
            // An unreadable refund still gets a row — silently dropping money
            // from this view is exactly the failure mode we are fixing.
            return { id, amountCents: 0, status: "UNREADABLE", paymentId: "", source };
          }
        }),
      )
    ).sort((a, b) => a.id.localeCompare(b.id));

    return { kind: "refunds", label, refunds };
  } catch (err) {
    return {
      kind: "refunds",
      label,
      error: err instanceof Error ? err.message : "refund lookup failed",
    };
  }
}

/**
 * Live Square facts for the whole money group: deposit order (+ tender
 * payment statuses) → funding gift card → per-leg day-of order(s) → refunds
 * → store-credit outcome card. Each node fails independently.
 */
export async function getPaymentTimeline(neonId: number): Promise<PaymentTimeline | null> {
  const anchor = await getBowlingReservation(neonId);
  if (!anchor) return null;
  const group = await listCancelGroupReservations(anchor);
  const legIds = group.map((g) => g.id);

  const tasks: Promise<TimelineNode>[] = [];

  if (anchor.squareDepositOrderId) {
    tasks.push(
      orderNode(
        "deposit",
        group.length > 1 ? "Deposit charge — covers every part" : "Deposit charge",
        anchor.squareDepositOrderId,
        { withPayments: true },
      ),
    );
  }

  // Funding gift card (the internal deposit card) — one per group.
  const funding = group.find((g) => g.squareGiftCardId);
  if (funding?.squareGiftCardId) {
    tasks.push(giftCardNode("funding_gift_card", "Funding gift card", funding.squareGiftCardId));
  }

  // Day-of order per DISTINCT order id (combo legs can share one pre-split).
  const seenOrders = new Set<string>();
  for (const leg of group) {
    const orderId = firstOrderId(leg.squareDayofOrderId);
    if (!orderId || seenOrders.has(orderId)) continue;
    seenOrders.add(orderId);
    const kindLabel = leg.productKind === "race" ? "racing" : leg.productKind;
    tasks.push(
      orderNode(
        "dayof_order",
        group.length > 1 ? `Day-of order — ${kindLabel} leg` : "Day-of order",
        orderId,
        // withPayments so a partially-refunded day-of tender shows its
        // refunded amount, not just the original charge.
        { legId: leg.id, withPayments: true },
      ),
    );
  }

  // Store-credit outcome (cancelled → HeadPinz FastTrax Gift Card).
  const credited = group.find((g) => g.storeCreditGiftCardId);
  if (credited?.storeCreditGiftCardId) {
    tasks.push(
      giftCardNode(
        "store_credit",
        "HeadPinz FastTrax Gift Card (cancellation store credit)",
        credited.storeCreditGiftCardId,
      ),
    );
  }

  // Refunds across BOTH ledgers, with live Square status. Without this the
  // tab shows orders and cards but never the money going back — and a
  // gift-card credit that is still PENDING looks like nothing happened.
  tasks.push(refundsNode(legIds));

  // Card-vault status (silent capture provenance) — Neon-only read, keyed on
  // the group's deposit order. Failure never blanks the Square timeline.
  const savedCardRow = await getCardStatusForReservation(
    anchor.squareDepositOrderId ?? null,
    anchor.squareCustomerId ?? null,
  ).catch(() => null);

  const nodes = (await Promise.all(tasks)).filter(
    // Most reservations have never been refunded — don't add an empty row to
    // every timeline. A lookup FAILURE still shows (that is information).
    (n) => n.kind !== "refunds" || (n.refunds?.length ?? 0) > 0 || !!n.error,
  );

  return {
    nodes,
    savedCard: savedCardRow
      ? {
          brand: savedCardRow.cardBrand,
          last4: savedCardRow.cardLast4,
          captured: !!savedCardRow.squareCardId,
          weAdded: savedCardRow.weAdded,
          permanentConsent: savedCardRow.permanentConsent,
          disabledAt: savedCardRow.disabledAt,
          captureSkipReason: savedCardRow.captureSkipReason,
          captureLastError: savedCardRow.captureLastError,
          captureAttempts: savedCardRow.captureAttempts,
        }
      : null,
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────

export interface NotesUpdateResult {
  ok: true;
  /** True when the QAMF memo was re-patched (bowling/KBF with a live QAMF id). */
  memoSynced: boolean;
  /** True when the note was appended to the BMI project's private log
   *  (race/attraction rows — merge-append, existing combo/VIP memos kept). */
  bmiMemoSynced: boolean;
}

/**
 * Save the reservation notes, then sync downstream so the desk sees them:
 * - QAMF (Conqueror) for bowling/KBF: buildQamfMemo embeds notes — re-patch
 *   the reservation Notes (reschedule-route precedent).
 * - BMI for rows with a bill (race/attraction, combo race legs): APPEND to
 *   the Office project's private log via the read-merge-write path — never
 *   the overwriting public booking/memo, so the booking-time memos
 *   (Ultimate VIP banner, express lane, POV codes) are preserved.
 * Both syncs are best-effort and reported so the UI can say what the desk
 * actually sees.
 */
export async function updateReservationNotes(
  neonId: number,
  notes: string,
): Promise<NotesUpdateResult | null> {
  const existing = await getBowlingReservation(neonId);
  if (!existing) return null;
  const value = notes.trim() === "" ? null : notes;

  await updateBowlingReservationNotes(neonId, value);

  let memoSynced = false;
  const isBowling = existing.productKind === "open" || existing.productKind === "kbf";
  if (isBowling && existing.qamfReservationId) {
    try {
      const memo = await buildQamfMemo(neonId);
      if (memo) {
        const center = resolveCenter(existing.centerCode, existing.productKind);
        await patchReservation(center.qamfCenterId, existing.qamfReservationId, { Notes: memo });
        memoSynced = true;
      }
    } catch (err) {
      console.warn(
        `[reservations-admin] notes memo re-sync failed res=${neonId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // BMI side: only when there's a note to show (clearing a note doesn't
  // append an empty log line) and the row carries a bill.
  let bmiMemoSynced = false;
  if (value && existing.bmiBillId) {
    bmiMemoSynced = await syncNoteToBmi(existing, value);
  }

  await recordAdminAction({
    reservationId: neonId,
    action: "notes_edit",
    outcome: "success",
    detail: { from: existing.notes ?? null, to: value, memoSynced, bmiMemoSynced },
  });

  return { ok: true, memoSynced, bmiMemoSynced };
}

export interface GuestUpdateResult {
  ok: true;
  changed: Record<string, { from: string | null; to: string }>;
}

/**
 * Partial guest-contact edit. Updates Neon only — future confirmations and
 * resends read from Neon so they pick the fix up immediately; the Square
 * customer is never renamed (loyalty identity), and QAMF converges on the
 * next reschedule (createReservation rebuilds Customer.Guest from Neon).
 */
export async function updateGuestContactService(
  neonId: number,
  fields: { guestName?: string; guestEmail?: string; guestPhone?: string },
): Promise<GuestUpdateResult | null> {
  const existing = await getBowlingReservation(neonId);
  if (!existing) return null;

  const changed: GuestUpdateResult["changed"] = {};
  if (fields.guestName !== undefined && fields.guestName !== existing.guestName) {
    changed.guestName = { from: existing.guestName ?? null, to: fields.guestName };
  }
  if (fields.guestEmail !== undefined && fields.guestEmail !== existing.guestEmail) {
    changed.guestEmail = { from: existing.guestEmail ?? null, to: fields.guestEmail };
  }
  if (fields.guestPhone !== undefined && fields.guestPhone !== existing.guestPhone) {
    changed.guestPhone = { from: existing.guestPhone ?? null, to: fields.guestPhone };
  }

  if (Object.keys(changed).length > 0) {
    await updateGuestContact(neonId, fields);
    await recordAdminAction({
      reservationId: neonId,
      action: "guest_edit",
      outcome: "success",
      detail: { changed },
    });
  }

  return { ok: true, changed };
}
