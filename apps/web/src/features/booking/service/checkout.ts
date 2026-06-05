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
import type { BookingSession, RaceItem, AttractionItem } from "../state/types";
import type { ContactInfo } from "../types";
import { getRaceProductById } from "./race-products";
import { raceUsesZeroBmiModel } from "./race";
import { LICENSE_PRICE, calculateTax } from "./race-pricing";
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

// ── Contact registration ────────────────────────────────────────────────

async function registerContact(
  billId: string,
  contact: Partial<ContactInfo>,
  party: { bmiPersonId?: string; isBillingCustomer?: boolean }[],
): Promise<void> {
  if (!contact.firstName || !contact.email || !contact.phone) return;
  try {
    const regBody: Record<string, unknown> = {
      firstName: contact.firstName,
      lastName: contact.lastName ?? "",
      email: contact.email,
      phone: (contact.phone ?? "").replace(/\D/g, ""),
    };
    const billingMember = party.find((m) => m.isBillingCustomer && m.bmiPersonId);
    let json = `{"orderId":${billId},` + JSON.stringify(regBody).slice(1);
    if (billingMember?.bmiPersonId) {
      json = json.slice(0, -1) + `,"personId":${billingMember.bmiPersonId}}`;
    }
    await fetch(`/api/bmi?${new URLSearchParams({ endpoint: "person/registerContactPerson" })}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    });
  } catch {
    /* non-fatal */
  }
}

async function registerProjectPersons(
  billId: string,
  party: { bmiPersonId?: string; firstName: string; lastName?: string }[],
): Promise<void> {
  for (const member of party) {
    if (!member.bmiPersonId) continue;
    try {
      const regBody = JSON.stringify({
        firstName: member.firstName,
        lastName: member.lastName ?? "",
      });
      const raw = `{"personId":${member.bmiPersonId},"orderId":${billId},` + regBody.slice(1);
      await fetch(`/api/bmi?${new URLSearchParams({ endpoint: "person/registerProjectPerson" })}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
    } catch {
      /* non-fatal */
    }
  }
}

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

/**
 * Charge lines for the v2 $0 model from the hardcoded registry: one line per race
 * product (priced from `RaceProduct.price`, grouped across all race items) plus a
 * `FastTrax License` line ($4.99 × new racers). BMI holds the heats + bundled
 * license at $0; these lines are what Square actually charges. `bmiProductId`
 * lets the reserve route resolve each to its Square catalog object.
 */
function buildRaceChargeLines(session: BookingSession): BillLine[] {
  const grouped = new Map<string, { name: string; unit: number; qty: number }>();
  for (const item of session.items) {
    if (item.kind !== "race") continue;
    for (const heat of item.heats) {
      if (!heat.productId) continue;
      const product = getRaceProductById(heat.productId);
      if (!product) continue;
      const existing = grouped.get(heat.productId);
      if (existing) existing.qty += 1;
      else grouped.set(heat.productId, { name: product.name, unit: product.price, qty: 1 });
    }
  }
  const lines: BillLine[] = [...grouped.entries()].map(([productId, l]) => ({
    name: l.name,
    quantity: l.qty,
    amount: Math.round(l.unit * l.qty * 100) / 100,
    bmiProductId: productId,
  }));
  const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
  if (newRacerCount > 0) {
    lines.push({
      name: "FastTrax License",
      quantity: newRacerCount,
      amount: Math.round(LICENSE_PRICE * newRacerCount * 100) / 100,
      bmiProductId: LICENSE_PRODUCT_ID,
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

// ── Confirmation URL builder ────────────────────────────────────────────

export function buildConfirmationUrl(session: BookingSession, billId: string, v2 = false): string {
  const racerNames = session.party.map((m) => encodeURIComponent(m.firstName)).join(",");
  const personIds = session.party
    .filter((m) => m.bmiPersonId)
    .map((m) => m.bmiPersonId)
    .join(",");
  const base = `/book/confirmation?billId=${billId}&billIds=${billId}&racerNames=${racerNames}&personIds=${personIds}`;
  return v2 ? `${base}&v2=1` : base;
}
