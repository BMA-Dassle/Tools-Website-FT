/**
 * Session-level checkout orchestrator.
 *
 * Activity-agnostic: iterates session.items[], dispatches each to
 * getService(item.kind).hold(), then handles session-wide concerns
 * (contact registration, bill overview, payment, booking records).
 *
 * PR-B2 wires the race service. Bowling (B5), attractions (B3), and
 * KBF (B6) plug into getService() later — this file doesn't change.
 */
import type { Dispatch } from "react";
import type { Action } from "../state/machine";
import type {
  BookingSession,
  RaceItem,
  RaceHeatAssignment,
  AttractionItem,
  SessionItem,
  PartyMember,
} from "../state/types";
import type { ContactInfo } from "../types";
import { activeComboSpecial, comboChargeLines } from "~/features/combos/combo-pricing";
import { getRaceProductById } from "./race-products";
import { raceUsesZeroBmiModel, cancelRaceOrder, holdRaceItem } from "./race";
import { getPackage, packagePerRacerPrice, POV_PRICE } from "./packages";
import { membershipDiscountsForNames } from "./membership-discounts";
import { LICENSE_PRICE, calculateTax } from "./race-pricing";
import { redemptionsFromSession } from "../data/race-credits";
import { bmiAdapter } from "../data/bmi";
import { registerContact, registerProjectPersons } from "./bmi-register";
import { CURRENT_POLICY_VERSION } from "@/lib/clickwrap";
import { getService } from "./index";

// ── Types ───────────────────────────────────────────────────────────────

export interface BillLine {
  name: string;
  quantity: number;
  amount: number;
  time?: string;
  lineId?: string;
  productGroup?: string;
  /** BMI product id for this line — set on $0-model charge lines so the reserve
   *  route resolves the Square catalog item without re-deriving from the session. */
  bmiProductId?: string;
  /** Set on a per-racer membership-discount split line (e.g. 50 for Employee
   *  Pass). Credit redemption attributes each redeemed heat to the EXACT split
   *  line (productId + this %) its racer is on, so a discount-holder who also
   *  redeems gets their own discounted line zeroed — not a sibling full-price
   *  line, and never double-counted. */
  membershipDiscountPct?: number;
}

export interface BillOverview {
  cashOwed: number;
  creditApplied: number;
  isCreditOrder: boolean;
  subtotal: number;
  tax: number;
  total: number;
  lines: BillLine[];
}

export interface CheckoutResult {
  bmiBillId: string;
  overview: BillOverview;
}

// ── Main orchestrator ───────────────────────────────────────────────────

export async function runCheckout(
  session: BookingSession,
  contact: ContactInfo,
  dispatch: Dispatch<Action>,
  onProgress: (msg: string) => void,
): Promise<CheckoutResult> {
  // Merge contact into session for downstream functions that read it
  const sessionWithContact: BookingSession = {
    ...session,
    contact,
  };

  let billId = session.bmiBillId;

  // 1. Hold phase — book all items via per-activity services
  for (const item of sessionWithContact.items) {
    onProgress(`Booking ${item.kind}…`);
    const svc = getService(item.kind);
    const result = await svc.hold({ session: sessionWithContact, item, dispatch });
    if (!billId && result.holdId) {
      billId = result.holdId;
    }
  }

  if (!billId) {
    throw new Error("No items were booked — nothing to check out");
  }

  // 2. Register billing contact on the combined bill
  onProgress("Registering contact…");
  await registerContact(billId, contact, sessionWithContact.party);

  // 3. Register verified racers as project persons
  onProgress("Registering racers…");
  await registerProjectPersons(billId, session.party);

  // 4. Fetch bill overview for pricing
  onProgress("Loading totals…");
  const bmiOverview = await fetchBillOverview(billId);

  // v2 $0 model: the BMI bill is $0 (heats are $0 build products), so the real
  // amount comes from the registry (race + license + FL tax), not the bill. Build
  // a charge overview that drives BOTH the pay page and the Square cart, so the
  // displayed price always equals what's charged.
  const raceItems = sessionWithContact.items.filter((i): i is RaceItem => i.kind === "race");
  const useZeroModel = raceItems.length > 0 && raceItems.every(raceUsesZeroBmiModel);
  const overview = useZeroModel
    ? buildZeroModelOverview(sessionWithContact, bmiOverview)
    : bmiOverview;

  return { bmiBillId: billId, overview };
}

// Contact + project-person registration live in ./bmi-register (shared so the
// race service can attach the customer at bill creation, not only here).

// ── Bill overview ───────────────────────────────────────────────────────

export async function fetchBillOverview(billId: string): Promise<BillOverview> {
  const res = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${billId}`);
  if (!res.ok) {
    throw new Error(`Bill overview failed: ${res.status}`);
  }
  const data = await res.json();

  let cashOwed = 0;
  let creditApplied = 0;
  let subtotal = 0;
  let tax = 0;
  let isCreditOrder = true;

  const cashTotal = (data.total ?? []).find((t: { depositKind: number }) => t.depositKind === 0);
  const creditTotals = (data.total ?? []).filter(
    (t: { depositKind: number }) => t.depositKind === 2,
  );
  const cashSub = (data.subTotal ?? []).find((t: { depositKind: number }) => t.depositKind === 0);
  const cashTax = (data.totalTax ?? []).find((t: { depositKind: number }) => t.depositKind === 0);

  if (cashTotal) {
    cashOwed = cashTotal.amount;
    isCreditOrder = false;
  }
  if (cashSub) subtotal = cashSub.amount;
  if (cashTax) tax = cashTax.amount;
  for (const ct of creditTotals) creditApplied += Math.abs(ct.amount);

  const lines: BillLine[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const l of (data.lines ?? []) as any[]) {
    // Filter out BMI auto-added membership license (kind=3, productId 11253570)
    if (l.kind === 3 && String(l.productId) === "11253570") {
      const memPrice =
        l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0)?.amount ?? 0;
      const memTax = l.totalTax ?? 0;
      cashOwed -= memPrice + memTax;
      subtotal -= memPrice;
      tax -= memTax;
      continue;
    }
    // Skip ghost / sub-lines BMI sometimes returns with name="" or null
    // (parent/child entries for the same heat). Surfacing them in the
    // review panel renders an empty row with no info, which looks broken.
    // Their price is already rolled into BMI's subtotal/tax (pulled above).
    if (!l.name || !String(l.name).trim()) continue;
    const cashPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0);
    lines.push({
      name: l.name,
      quantity: l.quantity,
      amount: cashPrice?.amount ?? 0,
      time: l.scheduledTime?.start || l.schedules?.[0]?.start || undefined,
      lineId: l.id ? String(l.id) : undefined,
      productGroup: l.productGroup || undefined,
    });
  }

  if (isCreditOrder && cashOwed === 0 && creditApplied > 0) {
    // All covered by credits
  } else {
    isCreditOrder = false;
  }

  const total = cashOwed;

  return { cashOwed, creditApplied, isCreditOrder, subtotal, tax, total, lines };
}

// ── Clickwrap ───────────────────────────────────────────────────────────

export async function recordClickwrap(params: {
  billId: string;
  email?: string;
  phone?: string;
  firstName?: string;
  amountCents: number;
  bookingType: string;
  cardLast4?: string;
  cardBrand?: string;
}): Promise<void> {
  try {
    await fetch("/api/clickwrap/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: new Date().toISOString(),
        billId: params.billId,
        email: params.email,
        phone: params.phone,
        firstName: params.firstName,
        amountCents: params.amountCents,
        cardLast4: params.cardLast4,
        cardBrand: params.cardBrand,
        bookingType: params.bookingType,
        policyVersion: CURRENT_POLICY_VERSION,
      }),
    });
  } catch {
    /* fire-and-forget */
  }
}

// ── Booking persistence ─────────────────────────────────────────────────

export async function saveBookingDetails(
  session: BookingSession,
  billId: string,
  overview: BillOverview,
  contact: Partial<ContactInfo>,
): Promise<void> {
  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  const heatCount = raceItems.reduce((s, r) => s + r.heats.length, 0);
  const firstHeatStart = raceItems[0]?.heats[0]?.heatId ?? "";
  const raceName =
    overview.lines
      .filter((l) => !l.name.toLowerCase().includes("license"))
      .map((l) => `${l.name}${l.quantity > 1 ? ` x${l.quantity}` : ""}`)
      .join(", ") || "Race Booking";

  // Resolve location for venue detection on the confirmation page
  const locationId =
    session.entryBrand === "headpinz"
      ? session.center === "naples"
        ? "naples"
        : "headpinz"
      : "fasttrax";

  const bookingDetails = {
    billId,
    billIds: billId,
    amount: (overview.isCreditOrder ? 0 : overview.cashOwed).toFixed(2),
    race: raceName,
    name: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim(),
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    qty: String(heatCount),
    heat: firstHeatStart,
    isCreditOrder: overview.isCreditOrder ? "true" : "false",
    smsOptIn: contact.smsOptIn ? "true" : "false",
    location: locationId,
    overviews: JSON.stringify([
      {
        _billId: billId,
        lines: overview.lines,
        total: [{ depositKind: 0, amount: overview.cashOwed }],
        subTotal: [{ depositKind: 0, amount: overview.subtotal }],
        totalTax: [{ depositKind: 0, amount: overview.tax }],
      },
    ]),
  };

  // Redis (24h TTL)
  try {
    await fetch("/api/booking-store", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bookingDetails),
    });
  } catch {
    /* non-fatal */
  }

  // localStorage fallback
  try {
    localStorage.setItem(`booking_${billId}`, JSON.stringify(bookingDetails));
  } catch {
    /* non-fatal */
  }

  // Comprehensive booking record (90d TTL)
  const racerAssignments = raceItems.flatMap((r) =>
    r.heats
      .filter((h) => h.assignedTo && h.heatId)
      .map((h) => {
        const member = session.party.find((m) => m.id === h.assignedTo);
        const raceProduct = h.productId ? getRaceProductById(h.productId) : null;
        return {
          racerName: member?.firstName ?? "Unknown",
          personId: member?.bmiPersonId ?? null,
          product: raceProduct?.name ?? "Race",
          productId: h.productId,
          track: h.track,
          heatStart: h.heatId,
          heatName: raceProduct?.name ?? "",
        };
      }),
  );

  const rookiePack = raceItems.some((r) => r.rookiePack === true);
  const packageId = raceItems.find((r) => r.packageId)?.packageId ?? null;

  // Attraction bookings — store slot times for confirmation page display
  const attractionItems = session.items.filter((i): i is AttractionItem => i.kind === "attraction");
  const attractionBookings = attractionItems.map((a) => ({
    slug: a.slug,
    date: a.date,
    slot: a.slot,
    qty: a.qty,
    price: a.price,
  }));

  // Bowling bookings — store time/experience for confirmation page display
  const bowlingItems = session.items.filter((i) => i.kind === "bowling" || i.kind === "kbf");
  const bowlingBookings = bowlingItems.map((b) => ({
    kind: b.kind,
    date: b.date,
    bookedAt: b.bookedAt,
    experienceSlug: b.experienceSlug,
    laneCount: b.laneCount,
    playerCount: b.kind === "bowling" ? b.playerCount : undefined,
    qamfReservationId: b.qamfReservationId,
  }));

  // Express Lane: all returning racers must have valid Pandora waivers.
  // The confirmation page reads bookingRecord.fastLane to skip the live
  // Pandora re-check and immediately show the green express lane experience.
  const returningRacers = session.party.filter((m) => m.bmiPersonId);
  const fastLane =
    returningRacers.length > 0 && returningRacers.every((m) => m.waiverValid === true);

  try {
    await fetch("/api/booking-record", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4",
      },
      body: JSON.stringify({
        billId,
        billIds: [billId],
        contact: {
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone,
        },
        primaryPersonId: session.party.find((m) => m.isBillingCustomer)?.bmiPersonId ?? null,
        racers: racerAssignments,
        isCreditOrder: overview.isCreditOrder,
        cashOwed: overview.cashOwed,
        creditApplied: overview.creditApplied,
        totalAmount: overview.total,
        date: raceItems[0]?.date ?? null,
        createdAt: new Date().toISOString(),
        status: "pending_payment",
        rookiePack,
        package: packageId,
        comboSpecial: session.comboSpecialId ?? undefined,
        fastLane: fastLane || undefined,
        attractions: attractionBookings.length > 0 ? attractionBookings : undefined,
        bowling: bowlingBookings.length > 0 ? bowlingBookings : undefined,
      }),
    });
  } catch {
    /* non-fatal */
  }
}

// ── Credit order confirmation ───────────────────────────────────────────

export async function confirmCreditOrder(billId: string): Promise<void> {
  const body = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":0,"orderId":${billId},"depositKind":2}`;
  const res = await fetch(`/api/bmi?${new URLSearchParams({ endpoint: "payment/confirm" })}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Credit confirmation failed: ${res.status} ${text.slice(0, 100)}`);
  }
}

// ── Cart removal: release early-booked BMI lines ─────────────────────────

/**
 * Best-effort cancel BMI bill lines on the shared session bill (orderId =
 * bmiBillId). Shared by the cart-removal and heat-deselect paths. Non-fatal: logs
 * and continues — the caller has already updated the cart, which is the source of
 * truth for the Square charge; this just keeps the BMI bill from confirming a line
 * the customer dropped. Uses the exact `bmiLineId` (= BMI orderItemId), so it only
 * ever removes the lines passed in, never another item's.
 */
async function removeBmiBillLines(
  session: BookingSession,
  billLineIds: (string | null | undefined)[],
): Promise<void> {
  const billId = session.bmiBillId;
  if (!billId) return;
  const clientKey = session.center === "naples" ? "headpinznaples" : "headpinzftmyers";
  for (const billLineId of billLineIds) {
    if (!billLineId) continue;
    try {
      const r = await bmiAdapter.removeBookingLine({ orderId: billId, billLineId, clientKey });
      if (!r.success) console.warn("[checkout] BMI line not removed:", billLineId);
    } catch (err) {
      console.warn("[checkout] removeBookingLine failed (non-fatal):", billLineId, err);
    }
  }
}

/**
 * Release the BMI lines for specific race heats being DESELECTED that were already
 * booked on a prior heat-picker advance (they carry a `bmiLineId`). Without this the
 * line orphans on the shared bill: dropped from the cart (so the Square charge is
 * short by one heat) yet still confirmed at checkout. Per-heat sibling of
 * releaseItemBmiLines; root cause of the "shows both heats, charges one" report.
 */
export async function releaseHeatBmiLines(
  session: BookingSession,
  heats: { bmiLineId?: string | null }[],
): Promise<void> {
  await removeBmiBillLines(
    session,
    heats.map((h) => h.bmiLineId),
  );
}

/**
 * Release the BMI bill lines a cart item booked EARLY (race heats on heat-picker
 * advance, an attraction slot on slot advance) when the customer removes that item
 * from the cart. Heats/slots are booked onto the shared session bill before the
 * cart, so without this the orphaned lines stay on the bill and get confirmed at
 * checkout — booking (and on legacy bills, charging) something the customer
 * deleted. Uses the exact `bmiLineId` stored at booking (= BMI's orderItemId), so
 * it only removes THIS item's lines, never another item's. Non-fatal per line.
 */
export async function releaseItemBmiLines(
  session: BookingSession,
  item: SessionItem,
): Promise<void> {
  if (item.kind === "race") {
    await removeBmiBillLines(
      session,
      item.heats.map((h) => h.bmiLineId),
    );
  } else if (item.kind === "attraction") {
    await removeBmiBillLines(session, [item.bmiLineId]);
  }
  // Bowling/KBF are QAMF-vendored (not on the BMI bill) — nothing to release here.
}

// ── Abandon: release the whole in-progress booking ───────────────────────

/**
 * Tear down an entire in-progress, UNCONFIRMED booking when the guest chooses to
 * start a new one. Contact-first creates the BMI bill (with the customer attached)
 * the moment the first heat/slot books, so without this an abandoned session
 * leaves a live reservation holding capacity in BMI. Releases every early-created
 * vendor hold so nothing orphans:
 *   - the shared BMI bill — cancels race heats + attraction slots + the attached
 *     contact in one call (whole-bill cancel, not per-line), and
 *   - any QAMF bowling/KBF temporary hold (a separate vendor, not on the BMI bill).
 *
 * Best-effort + non-fatal per vendor: a failed release will TTL out server-side,
 * and the caller still clears the local session. Pair with `clearBookingSession()`
 * on the client. Do NOT call this on a CONFIRMED booking — it cancels the bill.
 */
export async function abandonBooking(session: BookingSession): Promise<void> {
  if (session.bmiBillId) {
    await cancelRaceOrder(session.bmiBillId);
  }
  for (const item of session.items) {
    if (
      (item.kind === "bowling" || item.kind === "kbf") &&
      item.qamfReservationId &&
      item.qamfCenterId
    ) {
      try {
        await fetch(`/api/bowling/v2/reserve/hold/${item.qamfReservationId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ centerId: item.qamfCenterId }),
        });
      } catch {
        /* QAMF hold TTLs out on its own — non-fatal */
      }
    }
  }
}

// ── Square customer lookup ──────────────────────────────────────────────

export async function resolveSquareCustomer(contact: Partial<ContactInfo>): Promise<{
  customerId?: string;
  cards?: import("@/components/square/SavedCardSelector").SavedCard[];
}> {
  try {
    const res = await fetch("/api/square/customer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: contact.phone,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    return { customerId: data.customerId, cards: data.cards ?? [] };
  } catch {
    return {};
  }
}

// ── v2 Reserve (deposit + BMI confirm, server-side) ───────────────────

export interface ReserveParams {
  session: BookingSession;
  bmiBillId: string;
  overview: BillOverview;
  contact: Partial<ContactInfo>;
  cardSourceId?: string;
  savedCardId?: string;
  giftCardNonce?: string;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  rewardTierId?: string;
  rewardDiscountCents?: number;
}

export interface ReserveResult {
  neonId: number | null;
  reservationNumber: string | null;
  reservationCode: string | null;
  giftCardGan: string | null;
  dayofOrderId: string;
  dayofTotalCents: number;
  depositCents: number;
}

export async function reserveBooking(params: ReserveParams): Promise<ReserveResult> {
  const { session, bmiBillId, overview, contact } = params;

  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  const raceItem = raceItems[0];
  const bookingKind: "race" | "attraction" = raceItem ? "race" : "attraction";

  const centerCode = session.center ?? "fort-myers";
  const bmiClientKey = centerCode === "naples" ? "headpinznaples" : "headpinzftmyers";

  const useZeroModel = raceItems.length > 0 && raceItems.every(raceUsesZeroBmiModel);
  // The `overview` IS the charge in both models — legacy = BMI bill lines; zero
  // model = registry race + license (+ any non-race BMI lines), built in
  // buildZeroModelOverview. Mapping it straight to the Square cart guarantees the
  // charge equals what the customer was shown (displayed price = charge-time price).
  const cartItems = overview.lines
    .filter((l) => l.amount > 0 || overview.isCreditOrder)
    .map((l) => ({
      bmiProductId: l.bmiProductId ?? resolveProductId(session, l) ?? "",
      name: l.name,
      quantity: l.quantity,
      unitPriceCents: Math.round((l.amount * 100) / l.quantity),
    }));

  const bookingMetadata: Record<string, unknown> = {};
  if (raceItem) {
    bookingMetadata.heats = raceItem.heats.map((h) => ({
      productId: h.productId,
      track: h.track,
      heatId: h.heatId,
      assignedTo: h.assignedTo,
    }));
    bookingMetadata.racerNames = session.party.map((m) => m.firstName);
  }

  const cardSourceId = params.savedCardId ?? params.cardSourceId;

  // Per-racer credit redemptions (returning racers paying with a race credit).
  // The server re-validates the live balance, charges $0 for these heats, and
  // deducts one credit each. Derived from session.party redeemCredits opt-in.
  const creditRedemptions = redemptionsFromSession(session);

  const res = await fetch("/api/booking/v2/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bmiBillId,
      bmiClientKey,
      depositPct: 100,
      cardSourceId: cardSourceId ?? undefined,
      giftCardNonce: params.giftCardNonce ?? undefined,
      squareCustomerId: params.squareCustomerId ?? undefined,
      ...(params.loyaltyAccountId ? { loyaltyAccountId: params.loyaltyAccountId } : {}),
      ...(params.rewardTierId
        ? {
            rewardTierId: params.rewardTierId,
            rewardDiscountCents: params.rewardDiscountCents,
          }
        : {}),
      contact: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone,
      },
      bookingKind,
      bookingMetadata,
      cartItems,
      centerCode,
      // $0 model: the whole BMI bill is $0 (heats + bundled license all $0), so
      // confirm it as a $0 credit. Square holds the real money. Omitted on legacy.
      bmiConfirmAmountCents: useZeroModel ? 0 : undefined,
      ...(creditRedemptions.length ? { creditRedemptions } : {}),
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || "Reservation failed");
  }

  return {
    neonId: data.neonId,
    reservationNumber: data.reservationNumber,
    reservationCode: data.reservationCode,
    giftCardGan: data.giftCardGan,
    dayofOrderId: data.dayofOrderId,
    dayofTotalCents: data.dayofTotalCents,
    depositCents: data.depositCents,
  };
}

/** BMI license product id. The line's name ("FastTrax License") resolves to
 *  SQ.LICENSE via NAME_CATALOG_MAP in the reserve route, so the unmapped id here
 *  is fine — it's just carried for traceability. */
const LICENSE_PRODUCT_ID = "43473520";
/** $5 POV camera SKU — carried for traceability on the standalone POV Square
 *  line. The $0 BMI booking uses product 50361293 (race.ts), so the money lives
 *  only on Square; the name resolves to an ad-hoc line (no POV catalog object). */
const POV_PRODUCT_ID = "43746981";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Distinct racers (by assignedTo) across a set of heats — the "pack count" for
 *  combos (each racer = one pack of raceCount heats) and the racer count for
 *  package bundle pricing. Never below 1. */
function distinctRacerCount(heats: RaceHeatAssignment[]): number {
  return new Set(heats.map((h) => h.assignedTo).filter(Boolean)).size || 1;
}

/**
 * Canonical Square charge lines for ONE race item under the $0 model — the
 * SINGLE source the credit reserve path, the cash reserve path, AND the cart
 * estimate all consume, so displayed == charged by construction:
 *   - PACKAGE → one bundle line at `packagePerRacerPrice × racers` (already
 *     includes the $4.99 license + $5 POV per racer).
 *   - COMBO   → one line per pack at the pack TOTAL (`product.price × packs`,
 *     packs = distinct racers), NOT price × heats.
 *   - SINGLE  → one line per category product at the per-heat price × heats.
 * Session-level lines (non-package license, standalone POV) are added by
 * `buildRaceChargeLines`, not here.
 */
/** Per-racer racing discount (percent + label) for a heat's assigned racer.
 *  Defaults to no discount — keeps callers that don't pass it byte-identical. */
type RacingDiscountFor = (racerId?: string | null) => { percent: number; label: string | null };
const NO_DISCOUNT: RacingDiscountFor = () => ({ percent: 0, label: null });

/** Raw per-racer racing discount (% + label) from the racer's active memberships
 *  (Employee Pass 50%, League Racer 20%, …). Credit-redemption status is NOT a
 *  factor: a redeeming racer keeps the discount on any heats they pay cash for,
 *  and `applyCreditRedemptionsToOverview` attributes each credit to the matching
 *  (productId, discount%) line — so displayed == charged whether they redeem all,
 *  some, or none of their heats. Single source for the line build AND the credit
 *  attribution, so the two can't disagree on which line a racer is on. */
function racingDiscountForMember(m: PartyMember | undefined): {
  percent: number;
  label: string | null;
} {
  if (!m || !m.memberships?.length) return { percent: 0, label: null };
  let percent = 0;
  let label: string | null = null;
  for (const d of membershipDiscountsForNames(m.memberships)) {
    if (d.categories.includes("racing") && d.percentOff > percent) {
      percent = d.percentOff;
      label = d.label;
    }
  }
  return { percent, label };
}

export function raceItemChargeLines(
  item: RaceItem,
  excludeHeats?: Set<RaceHeatAssignment>,
  racingDiscountFor: RacingDiscountFor = NO_DISCOUNT,
): BillLine[] {
  // Credit-redeemed HEATS are charged $0 (a credit is deducted instead). The cash
  // path passes the exact redeemed heat objects (redeemedHeatSet) so ONLY those
  // drop from the Square charge — a racer with fewer credits than heats still pays
  // cash for the uncovered heats (previously the whole racer was excluded, which
  // zeroed every heat and could leave the order with no line items to charge). The
  // credit path passes nothing and splits via applyCreditRedemptionsToOverview.
  // Keyed on the heat OBJECT, not heatId (several racers can share one heatId).
  const keep = (h: RaceHeatAssignment): boolean => !!h.heatId && !excludeHeats?.has(h);

  // Split one logical charge line into a full-price line + a discounted line per
  // distinct racing discount %, grouping the heats by their racer's discount.
  // `perRacer` = price is charged per racer (package bundle / combo pack);
  // otherwise per heat (single races). With no discounts this yields exactly one
  // group → the same single line as before.
  const splitByDiscount = (
    heats: RaceHeatAssignment[],
    perRacer: boolean,
    name: string,
    unitPrice: number,
    bmiProductId: string,
  ): BillLine[] => {
    const groups = new Map<number, { label: string | null; heats: RaceHeatAssignment[] }>();
    for (const h of heats) {
      const { percent, label } = racingDiscountFor(h.assignedTo);
      const g = groups.get(percent) ?? { label, heats: [] };
      g.heats.push(h);
      groups.set(percent, g);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0]) // full-price line first
      .map(([percent, g]) => {
        const qty = perRacer ? distinctRacerCount(g.heats) : g.heats.length;
        const base = unitPrice * qty;
        return {
          name: percent > 0 ? `${name} (${g.label ?? "Member"} −${percent}%)` : name,
          quantity: qty,
          amount: round2(percent > 0 ? base * (1 - percent / 100) : base),
          bmiProductId,
          time: earliestHeatStart(g.heats),
          ...(percent > 0 ? { membershipDiscountPct: percent } : {}),
        };
      });
  };

  if (item.packageId) {
    const pkg = getPackage(item.packageId);
    if (!pkg) return [];
    const kept = item.heats.filter(keep);
    if (kept.length === 0) return [];
    return splitByDiscount(kept, true, pkg.name, packagePerRacerPrice(pkg), pkg.cartLineKey);
  }
  const lines: BillLine[] = [];
  for (const category of ["adult", "junior"] as const) {
    const pid = category === "adult" ? item.productIdAdult : item.productIdJunior;
    if (!pid) continue;
    const product = getRaceProductById(pid);
    if (!product) continue;
    const catHeats = item.heats.filter((h) => (h.category ?? "adult") === category && keep(h));
    if (catHeats.length === 0) continue;
    // combo = one pack per racer at the pack TOTAL; single = per heat.
    lines.push(
      ...splitByDiscount(
        catHeats,
        product.packType === "combo",
        product.name,
        product.price,
        product.productId,
      ),
    );
  }
  return lines;
}

/**
 * The charge-line key a heat rolls up into — keyed identically to
 * `raceItemChargeLines` (package `cartLineKey`, else the category's selected
 * `productId`). Used by credit redemption to attribute a redeemed heat to its
 * line even when the heat's own `productId` differs from the category's selected
 * product (new- vs existing-racer ids for the same race). Returns null when the
 * category has no selected product (e.g. cleared by the "add another race" loop).
 */
function chargeLineKeyForHeat(item: RaceItem, heat: RaceHeatAssignment): string | null {
  if (item.packageId) {
    return getPackage(item.packageId)?.cartLineKey ?? null;
  }
  const pid = (heat.category ?? "adult") === "junior" ? item.productIdJunior : item.productIdAdult;
  return getRaceProductById(pid)?.productId ?? null;
}

/** Earliest heat start ISO among a set of heats (ISO sorts lexically). Drives the
 *  heat time + racer-name display on the checkout review's race lines. */
function earliestHeatStart(heats: RaceHeatAssignment[]): string | undefined {
  const starts = heats
    .map((h) => h.heatId)
    .filter((s): s is string => !!s)
    .sort();
  return starts[0];
}

/**
 * Charge lines for the v2 $0 model: per-item race lines (package bundle / combo
 * pack / single) from `raceItemChargeLines`, plus session-level `FastTrax
 * License` ($4.99 × NON-package new racers — package license rides the bundle)
 * and standalone `POV Race Video` ($5 × non-package POV cameras). BMI holds the
 * heats + bundled license + POV at $0; these lines are what Square charges.
 *
 * Exported + `excludeHeats`-parameterized so BOTH reserve paths build the SAME
 * race lines (the cash path passes the credit-redeemed heat objects from
 * `redeemedHeatSet` to drop their $0 heats; the credit path passes nothing and
 * splits via applyCreditRedemptionsToOverview) — displayed == charged by construction.
 */
export function buildRaceChargeLines(
  session: BookingSession,
  excludeHeats?: Set<RaceHeatAssignment>,
): BillLine[] {
  const lines: BillLine[] = [];
  const packageRacerIds = new Set<string>();
  let standalonePovQty = 0;

  // Combo special (features/combos): when the session was seeded by a
  // /book/combo entry AND the strict gate passes (exactly the combo's
  // itinerary present), the per-item race product lines are REPLACED by the
  // flat per-person combo line(s). Bowling line items are suppressed by the
  // combo-aware callers (buildCombinedLineItems / CheckoutStep) — the combo
  // line is the whole race+bowl charge. The combo PRICE INCLUDES the racing
  // license and `includedPovPerRacer` POV videos (registry flags), so those
  // Square lines are suppressed below too — their $0 BMI records still book.
  // Race credits don't combine with the flat price (the checkout hides the
  // redeem opt-in in combo mode), so excludeHeats is moot.
  const activeCombo = activeComboSpecial(session);
  const comboLines = activeCombo ? comboChargeLines(session) : null;
  if (comboLines) lines.push(...comboLines);

  // Per-racer racing discount from the racer's own active BMI memberships (e.g.
  // Employee Pass 50%, League Racer 20%). ONLY the membership-holder's own heats
  // are discounted — others on the bill pay full price. A redeeming racer KEEPS
  // the discount on any heats they pay cash for; the credit-redeemed heats are
  // attributed to this same (productId, discount%) line by
  // applyCreditRedemptionsToOverview and zeroed there, so displayed == charged.
  const racingDiscountFor: RacingDiscountFor = (racerId) =>
    racingDiscountForMember(racerId ? session.party.find((p) => p.id === racerId) : undefined);

  for (const item of session.items) {
    if (item.kind !== "race") continue;
    if (!comboLines) lines.push(...raceItemChargeLines(item, excludeHeats, racingDiscountFor));
    if (item.packageId) {
      for (const h of item.heats) if (h.assignedTo) packageRacerIds.add(h.assignedTo);
    } else if (item.povQuantity > 0) {
      standalonePovQty += item.povQuantity;
    }
  }

  const newRacerCount = session.party.filter(
    (m) => m.isNewRacer && !packageRacerIds.has(m.id),
  ).length;
  if (newRacerCount > 0 && !activeCombo?.combo.includesLicense) {
    lines.push({
      name: "FastTrax License",
      quantity: newRacerCount,
      amount: round2(LICENSE_PRICE * newRacerCount),
      bmiProductId: LICENSE_PRODUCT_ID,
    });
  }

  // Combo-included POV ($0 on Square — part of the flat price). Any quantity
  // BEYOND the included count would still charge, but the combo flow auto-sets
  // exactly includedPovPerRacer × racers and hides the POV upsell step.
  if (activeCombo) {
    standalonePovQty = Math.max(
      0,
      standalonePovQty - activeCombo.combo.includedPovPerRacer * activeCombo.racerIds.length,
    );
  }
  if (standalonePovQty > 0) {
    lines.push({
      name: "POV Race Video",
      quantity: standalonePovQty,
      amount: round2(POV_PRICE * standalonePovQty),
      bmiProductId: POV_PRODUCT_ID,
    });
  }

  return lines;
}

/**
 * Build the charge overview for the v2 $0 model. The BMI bill is $0 (heats are $0
 * build products), so the amount the customer pays comes from the registry: race
 * lines + license, plus any non-race priced BMI lines (e.g. attractions), + FL
 * tax. This is the single source for BOTH the pay page and the Square cart, so the
 * two can't drift — `isCreditOrder` is false because real money is owed.
 */
function buildZeroModelOverview(session: BookingSession, bmiOverview: BillOverview): BillOverview {
  const raceLines = buildRaceChargeLines(session);
  // Non-race priced lines on the BMI bill (heats are $0, so amount>0 leaves only
  // things like attractions). Race heats and the bundled license stay $0 on BMI.
  const otherLines = bmiOverview.lines.filter((l) => l.amount > 0);
  const lines = [...raceLines, ...otherLines];
  const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const tax = calculateTax(subtotal);
  const total = Math.round((subtotal + tax) * 100) / 100;
  return { lines, subtotal, tax, total, cashOwed: total, creditApplied: 0, isCreditOrder: false };
}

/**
 * Apply per-racer credit redemptions to a charge overview: split each race line
 * into the charged portion (racers paying cash) and a $0 "credit" portion (racers
 * redeeming a credit), then recompute subtotal/tax/total. The $0 credit lines are
 * kept so the reserve cart stays non-empty and the review renders "Credit". A
 * racer is redeeming when their PartyMember has `redeemCredits` set.
 *
 * Pure — used by the checkout UI for display AND for the cart sent to the credit
 * reserve path (/reserve). The cash/mixed path (unifiedReserve) rebuilds from the
 * session with the same rule, so displayed price == charge-time price.
 */
export function applyCreditRedemptionsToOverview(
  overview: BillOverview,
  session: BookingSession,
): BillOverview {
  // Derive the zeroed heats from the SAME capped redemption list the server
  // validates + deducts (redemptionsFromSession), so a racer with fewer credits
  // than heats gets exactly `balance` heats at $0 and pays cash for the rest —
  // displayed == charged == deducted.
  const redemptions = redemptionsFromSession(session);
  if (redemptions.length === 0) return overview;
  // Map each heat ref to BOTH the CHARGE-LINE key it belongs to AND the racer who
  // owns it. The line key is keyed the same way raceItemChargeLines builds the
  // line (package cartLineKey, else the category's selected productId), NOT the
  // heat's own productId — those can diverge (e.g. a mixed party where the line
  // uses the existing-Mega id but the heats were picked under the new-Mega id),
  // and keying off the heat's id then left the credit unmatched. The racer is
  // needed because lines are split per racing-discount %: two lines can share a
  // productId (full-price + discounted), so the redeemed heat must land on the
  // split line matching its racer's discount.
  const refToLineKey = new Map<string, string>();
  const refToRacer = new Map<string, string | null>();
  for (const item of session.items) {
    if (item.kind !== "race") continue;
    item.heats.forEach((h, i) => {
      const ref = h.heatId ?? `${item.id}:${i}`;
      const key = chargeLineKeyForHeat(item, h);
      if (key) refToLineKey.set(ref, key);
      refToRacer.set(ref, h.assignedTo ?? null);
    });
  }
  // (charge-line key + discount %) -> heats redeemed on that EXACT split line.
  // The discount % is computed the SAME way the displayed lines were built (raw
  // membership discount via racingDiscountForMember), so a redeeming discount-
  // holder's credit lands on their own discounted line — not skipped (the old
  // bug: "-1 credit" shown but the charge never reduced), not double-counted
  // onto a sibling full-price line.
  const compositeKey = (productId: string, pct: number) => `${productId}::${pct}`;
  const redeemedByLine = new Map<string, number>();
  let redeemedCount = 0;
  for (const r of redemptions) {
    const key = refToLineKey.get(r.ref);
    if (!key) continue;
    const racerId = refToRacer.get(r.ref);
    const pct = racingDiscountForMember(
      racerId ? session.party.find((p) => p.id === racerId) : undefined,
    ).percent;
    const ck = compositeKey(key, pct);
    redeemedByLine.set(ck, (redeemedByLine.get(ck) ?? 0) + 1);
    redeemedCount += 1;
  }
  if (redeemedCount === 0) return overview;

  const lines: BillLine[] = [];
  for (const line of overview.lines) {
    // Attribute redeemed heats to the EXACT split line (productId + discount %)
    // its racer is on — so a discount-holder who also redeems gets their own
    // discounted line zeroed, while any sibling full-price line for the same
    // product is left untouched.
    const redeemed = line.bmiProductId
      ? (redeemedByLine.get(compositeKey(line.bmiProductId, line.membershipDiscountPct ?? 0)) ?? 0)
      : 0;
    if (redeemed <= 0) {
      lines.push(line);
      continue;
    }
    const unit = line.quantity > 0 ? line.amount / line.quantity : 0;
    const creditQty = Math.min(redeemed, line.quantity);
    const chargedQty = Math.max(0, line.quantity - creditQty);
    if (chargedQty > 0) {
      lines.push({
        ...line,
        quantity: chargedQty,
        amount: Math.round(unit * chargedQty * 100) / 100,
      });
    }
    // Keep the redeemed portion as a $0 line so the cart isn't empty and the
    // review shows it as "Credit".
    lines.push({ ...line, quantity: creditQty, amount: 0 });
  }

  const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const tax = calculateTax(Math.max(0, subtotal));
  const total = Math.round((subtotal + tax) * 100) / 100;
  return {
    ...overview,
    lines,
    subtotal,
    tax,
    total,
    cashOwed: Math.max(0, total),
    creditApplied: redeemedCount,
    isCreditOrder: subtotal <= 0,
  };
}

function resolveProductId(session: BookingSession, line: BillLine): string | null {
  for (const item of session.items) {
    if (item.kind === "race") {
      for (const h of item.heats) {
        if (h.productId && line.name.toLowerCase().includes("race")) {
          return h.productId;
        }
      }
    }
    if (item.kind === "attraction") {
      const attr = item as AttractionItem;
      if (attr.productId) return attr.productId;
    }
  }
  return null;
}

// ── Unified reserve (all item types, one Square Order) ──────────────────

export interface ReserveAllParams {
  session: BookingSession;
  contact: ContactInfo;
  cardSourceId?: string;
  giftCardNonce?: string;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  rewardTierId?: string;
  rewardDiscountCents?: number;
}

export interface ReserveAllResult {
  neonIds: number[];
  shortCodes: string[];
  qamfReservationIds: string[];
  bmiReservationNumber: string | null;
  bmiReservationCode: string | null;
  squareDayofOrderId: string;
  giftCardGan: string | null;
  depositCents: number;
  totalCents: number;
}

export async function reserveAll(params: ReserveAllParams): Promise<ReserveAllResult> {
  const res = await fetch("/api/booking/v2/reserve-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: params.session,
      contact: {
        firstName: params.contact.firstName,
        lastName: params.contact.lastName,
        email: params.contact.email,
        phone: params.contact.phone,
      },
      cardSourceId: params.cardSourceId,
      giftCardNonce: params.giftCardNonce,
      squareCustomerId: params.squareCustomerId,
      loyaltyAccountId: params.loyaltyAccountId,
      rewardTierId: params.rewardTierId,
      rewardDiscountCents: params.rewardDiscountCents,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || "Reservation failed");
  }

  return data as ReserveAllResult;
}

// ── Re-validate / rebuild the BMI bill right before charging ────────────

/**
 * Guard against BMI's 20-minute auto-cancel: re-check the held bill is still
 * live IMMEDIATELY before charging, and if BMI already auto-cancelled it (the
 * Pending-Online timeout strips the bill's products), rebuild the race heats
 * into a FRESH bill and return its id.
 *
 * Returns the (possibly new) bmiBillId — the original when the bill is still
 * healthy or there are no race items. Throws when a heat's time is no longer
 * bookable, so the caller can tell the customer to pick again and NEVER charges
 * a dead bill.
 *
 * Client-only: heat booking goes through the client `bmiAdapter`. Only the BMI
 * race bill is rebuilt — bowling/QAMF holds are left untouched (the old
 * auto-cancelled bill stays `-4` in BMI; no cleanup needed).
 */
export async function rebuildRaceBillIfExpired(
  session: BookingSession,
  contact: ContactInfo,
  dispatch: Dispatch<Action>,
): Promise<string | null> {
  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  if (raceItems.length === 0 || !session.bmiBillId) return session.bmiBillId ?? null;

  // A healthy bill returns its heat line items; an auto-cancelled one returns
  // none. (Same signal the server-side bmiBillIsLive guard uses.)
  let live = false;
  try {
    const ov = await fetchBillOverview(session.bmiBillId);
    live = ov.lines.length > 0;
  } catch {
    live = false; // overview unreachable → treat as expired and rebuild
  }
  if (live) return session.bmiBillId;

  // Rebuild: clear the stale bill id + per-heat line ids so holdRaceItem re-books
  // into a new bill. povSold is reset so POV + the package memo re-attach.
  let cleared: BookingSession = {
    ...session,
    contact,
    bmiBillId: null,
    items: session.items.map((it) =>
      it.kind === "race"
        ? { ...it, povSold: false, heats: it.heats.map((h) => ({ ...h, bmiLineId: null })) }
        : it,
    ),
  };

  let newBillId: string | undefined;
  for (const item of cleared.items) {
    if (item.kind !== "race") continue;
    const result = await holdRaceItem(cleared, item, dispatch);
    newBillId = result.bmiBillId;
    cleared = { ...cleared, bmiBillId: newBillId };
  }
  if (!newBillId) {
    throw new Error("Could not rebuild the reservation — please go back and pick a time again.");
  }

  // holdRaceItem only books heats; re-attach the contact + verified racers to the
  // fresh bill (runCheckout does this on the normal path).
  await registerContact(newBillId, contact, session.party);
  await registerProjectPersons(newBillId, session.party);

  dispatch({ type: "setBmiBillId", id: newBillId });
  return newBillId;
}

// ── Confirmation URL builder ────────────────────────────────────────────

export function buildConfirmationUrl(session: BookingSession, billId: string, v2 = false): string {
  const racerNames = session.party.map((m) => encodeURIComponent(m.firstName)).join(",");
  const personIds = session.party
    .filter((m) => m.bmiPersonId)
    .map((m) => m.bmiPersonId)
    .join(",");
  // v2 bookings (multi-activity capable) land on the v2 confirmation route;
  // v1 keeps serving /book/confirmation for legacy/bookmarked links.
  const path = v2 ? "/book/confirmation/v2" : "/book/confirmation";
  const base = `${path}?billId=${billId}&billIds=${billId}&racerNames=${racerNames}&personIds=${personIds}`;
  return v2 ? `${base}&v2=1` : base;
}
