/**
 * Unified reserve service — ONE Square Order per session.
 *
 * Handles mixed carts (bowling + racing + attractions) with a single
 * Square day-of order, one deposit charge, then fans out backend
 * confirmations to QAMF (bowling) and BMI (race/attraction).
 *
 * Per restructuring rules: business logic lives here, API route is a thin shell.
 */
import { randomBytes, randomUUID } from "crypto";
import { buildGanPrefix } from "@/lib/gan";
import {
  createDepositAndCharge,
  createDepositOrder,
  finalizeDepositFromExternalPayment,
  type ExternalTerminalPayment,
} from "./deposit";
import { kioskTerminalEnabled, kioskGzCartEnabled } from "~/features/kiosk/flags";
import { resolveCartPurchase } from "~/features/game-cards/cart-purchase";
import { startTxn, markCharged, markLoadState } from "~/features/game-cards/data/transactions-log";
import {
  kioskRacePacksEnabled,
  resolveKioskPacks,
  computePackCoverage,
  type ResolvedKioskPack,
  type PackCoverage,
} from "./race-pack-kiosk";
import { grantKioskRacePacks } from "./race-pack-grant.server";
import { upsertPackPurchases, markPackCharged } from "../data/race-pack-purchases-db";
import { SQUARE_RACE_PACK_CATALOG_ID } from "../data/packs";
import { centerCodeFor } from "~/config/intercard-centers";
import { after } from "next/server";
import { captureCardFromDeposit, type PaymentSourceKind } from "~/features/card-vault";
import { confirmBmiPayment, bmiBillIsLive } from "./bmi-confirm";
import { reserveBaseKey } from "./reserve-idempotency";
import {
  createReservation,
  getReservation,
  setReservationCustomer,
  setReservationStatus,
  patchReservation,
  setLanePlayers,
  extendReservation,
} from "@/lib/qamf-bowling";
import {
  lookupCatalogId,
  lookupCatalogIdByName,
  LOCATION_TAX,
  SQUARE_LOCATIONS,
} from "../data/square-catalog-map";
import { getRaceProductById } from "./race-products";
import { patchHeatSetups } from "./session-setup";
import { raceUsesZeroBmiModel } from "./race";
import { buildRaceChargeLines, raceHeatsMetadata } from "./checkout";
import { bowlingBookedPricingStamp } from "./bowling-booked-pricing";
import { promoFactor } from "./promo-pricing";
import { recordRedemption, getDiscountCodeByCode } from "~/features/discount-codes";
import { activeComboSpecial, comboOrderGroups } from "~/features/combos/combo-pricing";
import { getComboSpecial } from "~/features/combos/combo-specials";
import { wallClockMs } from "~/features/combos/combo-itinerary";
import { notifyComboBooked } from "~/features/combos/combo-notify";
import { redemptionsFromSession, redeemedHeatSet } from "../data/race-credits";
import { validateCreditRedemptions, deductCreditRedemptions } from "./race-credit-redeem";
import {
  isWorldCupBowlingItem,
  validateWorldCupBooking,
  WorldCupReservationError,
  worldCupQamfTitle,
  worldCupQamfBanner,
  fixtureForBookedAt,
  fixtureLabel,
} from "~/features/world-cup";
import { enrichFixture } from "~/features/world-cup/live-teams";
import { notifyWorldCupBooked } from "~/features/world-cup/notify.server";
import {
  insertBowlingReservation,
  insertReservationPlayers,
  updateBowlingReservationNotes,
  updateBowlingReservationShortCode,
  findReusableReservation,
  getBowlingReservationByBillId,
  updateBowlingReservationConfirmed,
  updateBowlingReservationConfirmFailed,
  updateBowlingReservationSquareIds,
  raceHeatsForPersonsOnDate,
  type ReservationProductKind,
} from "@/lib/bowling-db";
import { findCrossBookingConflict, heatClockLabel } from "./conflict";
import { shortenUrl } from "@/lib/short-url";
import type {
  BookingSession,
  BowlingItem,
  KbfItem,
  RaceItem,
  AttractionItem,
} from "../state/types";
import type { ContactInfo } from "../types";
import redis from "@/lib/redis";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";
const BOOKING_FEE_CATALOG_ID = "7VKAFU3HDPRSKY7ZB6CKXTRW";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

// ── Input / Output types ──────────────────────────────────────────────

export interface UnifiedReserveInput {
  session: BookingSession;
  contact: ContactInfo;
  cardSourceId?: string;
  giftCardNonce?: string;
  /**
   * How cardSourceId was produced (PaymentForm tag: typed card / wallet /
   * saved card / gift-card-only). Drives the card-vault silent capture —
   * wallet tokens are never vaulted as cards.
   */
  sourceKind?: PaymentSourceKind;
  /** Checkout opt-in: "Save this card to my account for faster checkout". */
  saveCardConsent?: boolean;
  squareCustomerId?: string;
  loyaltyAccountId?: string;
  rewardTierId?: string;
  rewardDiscountCents?: number;
  /**
   * Kiosk direct-Terminal charge (owner rule: NO saved card). When set, the
   * guest's card was ALREADY captured on the paired reader against OUR deposit
   * order; reserve funds the gift card from that completed paymentId and NEVER
   * charges a token. Only honored when kioskTerminalEnabled(). See
   * tasks/kiosk-terminal-charge.md.
   */
  externalPayment?: ExternalTerminalPayment;
}

/** Result of prepareUnifiedDeposit — the deposit order the reader must pay. */
export interface PrepareDepositResult {
  __prepare: true;
  seed: string;
  depositOrderId: string;
  depositCents: number;
  locationId: string;
}

/**
 * KIOSK: Game Zone cards charged with the booking — the row pointers the
 * confirmation screen fulfills (dispense+load for new cards, bridge-load for
 * reloads). Amounts/tokens are informational for the progress UI; the server
 * re-validates everything at /load-card time.
 */
export interface GameCardFulfillment {
  mode: "new_card" | "reload";
  groupId: string;
  locationCode: number;
  cards: Array<{
    txnId: string;
    packageId: string;
    accountNumber: string;
    tokens: number;
    bonusTokens: number;
  }>;
}

export interface UnifiedReserveResult {
  neonIds: number[];
  shortCodes: string[];
  qamfReservationIds: string[];
  bmiReservationNumber: string | null;
  bmiReservationCode: string | null;
  squareDayofOrderId: string;
  giftCardGan: string | null;
  depositCents: number;
  totalCents: number;
  /** Present only when Game Zone cards rode this booking (kiosk). */
  gameCards?: GameCardFulfillment;
  /** Present only when kiosk race packs rode this booking — per pack:
   *  "{usedToday} used today, {banked} banked"; granted=false means the retry
   *  sweep owns the grant (confirmation copy degrades honestly). */
  racePacks?: Array<{
    memberName: string;
    label: string;
    raceCount: number;
    usedToday: number;
    banked: number;
    granted: boolean;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────────────

type BowlingLikeItem = BowlingItem | KbfItem;

function isBowlingLike(item: { kind: string }): item is BowlingLikeItem {
  return item.kind === "bowling" || item.kind === "kbf";
}

// FastTrax-operated attractions. Everything else attraction-wise (gel blaster,
// laser tag, shuffly) is HeadPinz. Race is always FastTrax. Keeps the two
// Fort-Myers entities' Square revenue separate.
const FASTTRAX_ATTRACTION_SLUGS = new Set<string>(["duck-pin"]);

/**
 * KIOSK deposit location — the kiosk's OWN Square location (by its configured
 * brand/center), NOT the activity's owning entity. A paired Square Terminal can
 * only charge orders created at ITS device's location; a FastTrax kiosk
 * legitimately sells HeadPinz attractions (gel blasters — owner 2026-07-18:
 * "it's just a deposit"), which used to die with "the device's location must
 * match the order's location". Revenue is untouched: the DAY-OF order keeps the
 * owning entity's location (resolveLocationId), and the deposit gift card
 * redeems cross-location — exactly how the combo's one-GC/two-entity model has
 * worked in production since 6/11.
 */
function resolveKioskDepositLocationId(session: BookingSession): string {
  if (session.center === "naples") return SQUARE_LOCATIONS.HEADPINZ_NAP;
  return session.entryBrand === "headpinz"
    ? SQUARE_LOCATIONS.HEADPINZ_FM
    : SQUARE_LOCATIONS.FASTTRAX_FM;
}

function resolveLocationId(session: BookingSession): string {
  // Route the Square day-of order to the entity that OWNS the products:
  //   HeadPinz (FM/Naples by center) — bowling, KBF, gel blaster, laser tag, shuffly
  //   FastTrax FM                    — race, duck pin
  // Previously ONLY bowling routed to HeadPinz and everything else fell through
  // to FastTrax, so standalone gel/laser/Naples attractions leaked into the
  // FastTrax entity's Square account.
  const hasHeadpinzProduct = session.items.some(
    (i) =>
      isBowlingLike(i) ||
      (i.kind === "attraction" && !FASTTRAX_ATTRACTION_SLUGS.has((i as AttractionItem).slug ?? "")),
  );
  if (hasHeadpinzProduct) {
    return session.center === "naples"
      ? SQUARE_LOCATIONS.HEADPINZ_NAP
      : SQUARE_LOCATIONS.HEADPINZ_FM;
  }
  return SQUARE_LOCATIONS.FASTTRAX_FM;
}

function resolveBmiClientKey(session: BookingSession): string {
  return session.center === "naples" ? "headpinznaples" : "headpinzftmyers";
}

interface SquareLineItem {
  name: string;
  quantity: string;
  catalogObjectId?: string;
  basePriceMoney?: { amount: number; currency: "USD" };
  note?: string;
}

// ── Build combined line items from all session items ──────────────────

function buildCombinedLineItems(session: BookingSession): {
  sqLineItems: SquareLineItem[];
  depositPct: number;
  promoSavingsCents: number;
  kioskPacks: ResolvedKioskPack[];
  packCoverage: PackCoverage;
} {
  const sqLineItems: SquareLineItem[] = [];
  let totalPriceCents = 0;
  let totalDepositCents = 0;
  let promoSavingsCents = 0; // USA250 cents removed across all lines (for the ledger)

  // Combo special: the flat combo line (emitted inside buildRaceChargeLines
  // below) IS the whole race+bowl charge, so the bowling item's own line items
  // are suppressed — charging both would double-charge the bowling. Raw $0
  // pass-through items + the booking fee still ride along (not bowling value).
  // The QAMF reservation is still created/confirmed downstream. CheckoutStep
  // suppresses the same lines from the review, so displayed == charged.
  const comboActive = activeComboSpecial(session) != null;

  // Bowling / KBF items
  for (const item of session.items) {
    if (!isBowlingLike(item)) continue;

    // USA250: reduce the price key on priced bowling lines. Catalog-only
    // lines with no local price (fees) carry priceCents 0 → factor 1 → untouched.
    const bowlVisitDate = item.date ?? item.bookedAt?.slice(0, 10) ?? undefined;
    for (const li of comboActive ? [] : item.lineItems) {
      const fullCents = li.priceCents ?? 0;
      const factor =
        fullCents > 0
          ? promoFactor({ domain: "bowling", visitDate: bowlVisitDate }, session.appliedPromo)
          : 1;
      const priceCents = factor === 1 ? fullCents : Math.round(fullCents * factor);
      const depPct = li.depositPct ?? 100;
      const lineTotal = priceCents * li.quantity;
      totalPriceCents += lineTotal;
      totalDepositCents += Math.round(lineTotal * (depPct / 100));
      promoSavingsCents += (fullCents - priceCents) * li.quantity;

      if (li.squareCatalogObjectId && factor === 1) {
        sqLineItems.push({
          name: li.label ?? "Bowling",
          quantity: String(li.quantity),
          catalogObjectId: li.squareCatalogObjectId,
        });
      } else if (li.squareCatalogObjectId) {
        // Discounted catalog line: keep the catalog link for categorization but
        // override the price key with the reduced amount.
        sqLineItems.push({
          name: li.label ?? "Bowling",
          quantity: String(li.quantity),
          catalogObjectId: li.squareCatalogObjectId,
          basePriceMoney: { amount: priceCents, currency: "USD" },
        });
      } else {
        sqLineItems.push({
          name: li.label ?? "Bowling",
          quantity: String(li.quantity),
          basePriceMoney: { amount: priceCents, currency: "USD" },
        });
      }
    }

    // Raw items (pizza/soda $0 passthrough)
    for (const ri of item.rawItems) {
      sqLineItems.push({
        name: ri.name,
        quantity: String(ri.quantity),
        catalogObjectId: ri.catalogObjectId,
        ...(ri.note ? { note: ri.note } : {}),
      });
    }

    // Booking fee
    if (item.hasBookingFee) {
      sqLineItems.push({
        name: "Booking Fee",
        quantity: "1",
        catalogObjectId: BOOKING_FEE_CATALOG_ID,
      });
      totalPriceCents += 299;
      totalDepositCents += 299;
    }
  }

  // Race items — $0 model. Build the SAME charge lines the credit path uses
  // (buildRaceChargeLines: package bundle / combo pack / single + license + POV),
  // so displayed == charged, then map each to a Square line. Credit-redeemed HEATS
  // are excluded (charged $0; one credit deducted each) — capped per racer at their
  // combined eligible balance, so a racer with fewer credits than heats still pays
  // cash for the uncovered heats instead of zeroing the whole order.
  const redeemedHeats = redeemedHeatSet(session);

  // KIOSK race packs (CREDIT packs, owner final design 2026-07-18): the pack
  // line rides THIS day-of order (owner: "race packs sold via race flow go on
  // the day-of order") at 100% deposit, and the assignee's today heats are
  // pack-covered — excluded here exactly like credit-redeemed heats ($0 on
  // Square; one credit deducted post-grant). Net = the owner's sentence:
  // "one payment, one race today, two added to the account." resolveKioskPacks
  // throws on any bad pointer (fail-closed — never charge on a broken pack).
  const kioskPacks: ResolvedKioskPack[] =
    session.context?.kiosk && kioskRacePacksEnabled()
      ? resolveKioskPacks(
          session.items.flatMap((i) => (i.kind === "race" ? (i.creditPacks ?? []) : [])),
          session.party,
        )
      : [];
  const packCoverage: PackCoverage = computePackCoverage(session, kioskPacks, redeemedHeats);
  const excludedHeats =
    packCoverage.heats.size > 0
      ? new Set([...redeemedHeats, ...packCoverage.heats])
      : redeemedHeats;

  for (const bl of buildRaceChargeLines(session, excludedHeats)) {
    const totalCents = Math.round(bl.amount * 100);
    const unitCents = bl.quantity > 0 ? Math.round(totalCents / bl.quantity) : totalCents;
    const catalogId =
      (bl.bmiProductId ? lookupCatalogId(bl.bmiProductId) : null) ?? lookupCatalogIdByName(bl.name);
    totalPriceCents += totalCents;
    totalDepositCents += totalCents; // 100% deposit for race
    // Race + combo savings (combo lines flow through here too, pre-stamped).
    promoSavingsCents +=
      bl.originalAmount != null ? Math.round((bl.originalAmount - bl.amount) * 100) : 0;

    sqLineItems.push({
      name: bl.name,
      quantity: String(bl.quantity),
      ...(catalogId
        ? { catalogObjectId: catalogId, basePriceMoney: { amount: unitCents, currency: "USD" } }
        : { basePriceMoney: { amount: unitCents, currency: "USD" } }),
    });
  }

  // Attraction items
  for (const item of session.items) {
    if (item.kind !== "attraction") continue;
    const attr = item as AttractionItem;
    if (!attr.productId) continue;

    const catalogId = lookupCatalogId(attr.productId);
    // USA250: reduce the price key on the attraction line when eligible.
    const fullUnitCents = Math.round(attr.price * 100);
    const factor = promoFactor(
      { domain: "attractions", visitDate: attr.date, productSlug: attr.slug },
      session.appliedPromo,
    );
    const unitCents = factor === 1 ? fullUnitCents : Math.round(fullUnitCents * factor);
    const lineTotal = unitCents * attr.qty;
    totalPriceCents += lineTotal;
    totalDepositCents += lineTotal; // 100% deposit for attractions
    promoSavingsCents += (fullUnitCents - unitCents) * attr.qty;

    sqLineItems.push({
      name: attr.slug ?? "Attraction",
      quantity: String(attr.qty),
      ...(catalogId
        ? { catalogObjectId: catalogId, basePriceMoney: { amount: unitCents, currency: "USD" } }
        : { basePriceMoney: { amount: unitCents, currency: "USD" } }),
    });
  }

  // Pack lines LAST (after every booked-thing line) — one revenue line per
  // pack on the day-of order, web race-pack Square SKU, collected in FULL
  // (credits grant right after payment, so the deposit must cover them).
  for (const p of kioskPacks) {
    totalPriceCents += p.priceCents;
    totalDepositCents += p.priceCents;
    sqLineItems.push({
      name: `Race Pack — ${p.label} · ${p.memberName}`,
      quantity: "1",
      catalogObjectId: SQUARE_RACE_PACK_CATALOG_ID,
      basePriceMoney: { amount: p.priceCents, currency: "USD" },
    });
  }

  const depositPct =
    totalPriceCents > 0 ? Math.round((totalDepositCents / totalPriceCents) * 100) : 100;

  return { sqLineItems, depositPct, promoSavingsCents, kioskPacks, packCoverage };
}

// ── Kiosk direct-Terminal persist-first anchor ────────────────────────
//
// The reader charges the deposit order BEFORE reserve runs (the inversion), so a
// durable record must exist the instant the order is prepared and the instant the
// card is captured — otherwise a browser death between tap and reserve strands a
// captured payment with no pointer. We key a small Redis record on the session
// seed. Square itself is the source of truth for the captured funds (the deposit
// order + payment live there forever); this anchor is the fast pointer the
// terminal-orphan reconcile follows. 48h TTL comfortably outlives a kiosk session.
interface TerminalAnchor {
  depositOrderId: string;
  depositCents: number;
  locationId: string;
  baseKey: string;
  paymentId?: string;
  stampedAt?: string;
  /**
   * KIOSK Game Zone cards riding this deposit order (owner 2026-07-18): the
   * ledger rows persisted at PREPARE, so finalize can mark them charged and
   * hand them to the confirmation screen for fulfillment. Order matches the
   * session's cards at prepare time.
   */
  gameCards?: {
    mode: "new_card" | "reload";
    groupId: string;
    locationCode: number;
    totalCents: number;
    cards: Array<{ txnId: string; packageId: string; accountNumber: string }>;
  };
}
const TERMINAL_ANCHOR_TTL_S = 48 * 3600;
const terminalAnchorKey = (seed: string) => `kiosk:terminal:anchor:${seed}`;

async function writeTerminalAnchor(seed: string, anchor: TerminalAnchor): Promise<void> {
  try {
    await redis.set(terminalAnchorKey(seed), JSON.stringify(anchor), "EX", TERMINAL_ANCHOR_TTL_S);
  } catch {
    /* Redis down — Square still holds the durable order/payment; reconcile can
       recover from Square by the deposit order's reference_id (the seed). */
  }
}

/** Stamp a captured paymentId onto the prepare anchor (persist-at-capture). Called
 *  by the terminal-checkout poll route on COMPLETED AND by reserve's finalize
 *  catch, so an orphan always leaves a pointer. Merges onto the existing anchor. */
export async function stampTerminalPaymentOnAnchor(seed: string, paymentId: string): Promise<void> {
  try {
    const raw = await redis.get(terminalAnchorKey(seed));
    const prev: Partial<TerminalAnchor> =
      typeof raw === "string"
        ? (JSON.parse(raw) as Partial<TerminalAnchor>)
        : raw
          ? (raw as Partial<TerminalAnchor>)
          : {};
    await redis.set(
      terminalAnchorKey(seed),
      JSON.stringify({ ...prev, paymentId, stampedAt: new Date().toISOString() }),
      "EX",
      TERMINAL_ANCHOR_TTL_S,
    );
  } catch {
    /* non-fatal */
  }
}

/** Read a terminal anchor (reconcile / diagnostics). */
export async function readTerminalAnchor(seed: string): Promise<TerminalAnchor | null> {
  try {
    const raw = await redis.get(terminalAnchorKey(seed));
    if (!raw) return null;
    return typeof raw === "string" ? (JSON.parse(raw) as TerminalAnchor) : (raw as TerminalAnchor);
  } catch {
    return null;
  }
}

// ── Route-entry idempotency guard + lock ──────────────────────────────

/**
 * Rebuild a UnifiedReserveResult for an already-confirmed BMI bill from the
 * `bmi:confirmed` cache + the Neon row — NO Square / BMI calls. confirmBmiPayment
 * is NOT idempotent (a 2nd confirm reverts BMI state), so this short-circuit is
 * what makes a retry / double-submit safe for the race + attraction path.
 * Returns null when the bill hasn't been confirmed yet.
 */
async function unifiedCachedSuccess(bmiBillId: string): Promise<UnifiedReserveResult | null> {
  let cached: unknown;
  try {
    cached = await redis.get(`bmi:confirmed:${bmiBillId}`);
  } catch {
    return null;
  }
  if (!cached) return null;
  let c: { reservationNumber?: string; reservationCode?: string };
  try {
    c = typeof cached === "string" ? JSON.parse(cached) : (cached as typeof c);
  } catch {
    return null;
  }
  const row = await getBowlingReservationByBillId(bmiBillId).catch(() => null);
  return {
    neonIds: row?.id ? [row.id] : [],
    shortCodes: [],
    qamfReservationIds: [],
    bmiReservationNumber: c.reservationNumber ?? row?.bmiReservationNumber ?? null,
    bmiReservationCode: c.reservationCode ?? null,
    squareDayofOrderId: row?.squareDayofOrderId ?? "",
    giftCardGan: row?.squareGiftCardGan ?? null,
    depositCents: row?.depositCents ?? 0,
    totalCents: row?.totalCents ?? 0,
  };
}

export class ReserveInProgressError extends Error {
  code = "RESERVE_IN_PROGRESS";
  constructor() {
    super("A booking for this reservation is already in progress.");
  }
}

/**
 * Thrown when a race bill auto-cancelled in BMI before the customer paid (BMI
 * strips the products off a Pending-Online hold past the center's timeout). We
 * detect it BEFORE charging, so the card is never touched — the customer is
 * told their held time lapsed and to pick again.
 */
export class BillExpiredError extends Error {
  code = "BILL_EXPIRED";
  constructor() {
    super(
      "Your held race time expired before payment, so we didn't charge you. Please go back and choose a time again.",
    );
    this.name = "BillExpiredError";
  }
}

/**
 * Thrown when a cart heat is too close to a heat the SAME racer already holds
 * in another reservation (cross-reservation spacing — see conflict.ts). Raised
 * BEFORE any Square write, so nothing was charged.
 */
export class ExistingBookingConflictError extends Error {
  code = "EXISTING_BOOKING_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ExistingBookingConflictError";
  }
}

/** Rejection copy for a cross-reservation spacing conflict. */
export function existingBookingConflictMessage(conflict: {
  cart: { heatId: string | null; racer?: string | null };
  existing: { heatId: string };
}): string {
  const who = conflict.cart.racer || "One of your racers";
  const cartLabel = conflict.cart.heatId ? heatClockLabel(conflict.cart.heatId) : "the selected";
  return `${who} already has a race booked at ${heatClockLabel(conflict.existing.heatId)} — too close to the ${cartLabel} heat. Please pick a different time.`;
}

// ── Main orchestrator ─────────────────────────────────────────────────

/**
 * Public entry: idempotency guard (already-confirmed short-circuit + per-session
 * NX lock) wrapped around the charge/confirm fan-out. The lock prevents two
 * concurrent submits from both fanning out (QAMF createReservation has no
 * idempotency key); the deterministic baseKey inside makes Square replay-safe.
 */
export async function unifiedReserve(input: UnifiedReserveInput): Promise<UnifiedReserveResult> {
  const { session } = input;
  const bowlingItems = session.items.filter(isBowlingLike);
  // Stable per-session anchor for the seed + lock. bmiBillId for BMI sessions;
  // the Square session order or QAMF hold id otherwise.
  const seedSource =
    session.bmiBillId ?? session.squareOrderId ?? bowlingItems[0]?.qamfReservationId ?? null;

  // 1) Already confirmed? Return the first call's result (no second charge /
  //    confirm). Only meaningful for BMI sessions (the cache key is the bill).
  if (session.bmiBillId) {
    const cached = await unifiedCachedSuccess(session.bmiBillId).catch(() => null);
    if (cached) return cached;
  }

  // 2) In-flight? NX lock keyed on the session anchor.
  const lockKey = seedSource ? `reserve:lock:${seedSource}` : null;
  let lockHeld = false;
  if (lockKey) {
    try {
      lockHeld = (await redis.set(lockKey, "1", "EX", 120, "NX")) === "OK";
    } catch {
      lockHeld = true; // Redis down — deterministic keys still prevent a double charge
    }
    if (!lockHeld) {
      if (session.bmiBillId) {
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const cached = await unifiedCachedSuccess(session.bmiBillId).catch(() => null);
          if (cached) return cached;
        }
      }
      throw new ReserveInProgressError();
    }
  }

  try {
    // The full path never sets prepareOnly, so the result is always a
    // UnifiedReserveResult (prepareUnifiedDeposit is the only prepareOnly caller).
    return (await unifiedReserveInner(input, seedSource)) as UnifiedReserveResult;
  } finally {
    if (lockKey && lockHeld) {
      await redis.del(lockKey).catch(() => {});
    }
  }
}

/**
 * KIOSK direct-Terminal PREPARE (owner: NO saved card). Runs the SAME pre-charge
 * guards + day-of order creation as reserve (so nothing fallible remains after
 * the money moves — H3074 rule), then creates the GIFT_CARD deposit order the
 * paired reader will pay and writes a persist-first anchor. The client taps the
 * reader against `depositOrderId`, then calls reserve-all with the completed
 * paymentId as `externalPayment`. Idempotent via the session seed → reserve
 * replays the SAME day-of + deposit orders. Serialized by the same NX lock as
 * reserve so a prepare and a reserve can't race. Flag-gated at the route.
 */
export async function prepareUnifiedDeposit(
  input: UnifiedReserveInput,
): Promise<PrepareDepositResult> {
  const { session } = input;
  const bowlingItems = session.items.filter(isBowlingLike);
  const seedSource =
    session.bmiBillId ?? session.squareOrderId ?? bowlingItems[0]?.qamfReservationId ?? null;

  const lockKey = seedSource ? `reserve:lock:${seedSource}` : null;
  let lockHeld = false;
  if (lockKey) {
    try {
      lockHeld = (await redis.set(lockKey, "1", "EX", 120, "NX")) === "OK";
    } catch {
      lockHeld = true;
    }
    if (!lockHeld) throw new ReserveInProgressError();
  }
  try {
    const result = (await unifiedReserveInner(input, seedSource, true)) as PrepareDepositResult;
    return result;
  } finally {
    if (lockKey && lockHeld) {
      await redis.del(lockKey).catch(() => {});
    }
  }
}

async function unifiedReserveInner(
  input: UnifiedReserveInput,
  seedSource: string | null,
  prepareOnly = false,
): Promise<UnifiedReserveResult | PrepareDepositResult> {
  const { session, contact } = input;
  // Day-of order → the entity that OWNS the products (revenue split stays
  // exact). Deposit/gift-card/payment → the KIOSK's own location when this is a
  // kiosk session (the paired reader can only charge its device's location);
  // web sessions keep the single entity location for both.
  const dayofLocationId = resolveLocationId(session);
  const locationId = session.context?.kiosk
    ? resolveKioskDepositLocationId(session)
    : dayofLocationId;
  // Deterministic idempotency seed — same session anchor → same Square keys on
  // every retry, so all 7 keys replay the SAME order / payment / gift card.
  const baseKey = seedSource ? reserveBaseKey(seedSource) : randomBytes(8).toString("hex");

  const bowlingItems = session.items.filter(isBowlingLike);
  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  const attractionItems = session.items.filter((i): i is AttractionItem => i.kind === "attraction");
  const hasBmi = raceItems.length > 0 || attractionItems.length > 0;

  // ── 0. Guard: never charge against an auto-cancelled BMI bill ──────
  // BMI auto-cancels a Pending-Online hold after the center's timeout, stripping
  // the bill's products. If that happened during the customer's dwell, charging
  // here would take money for a reservation that no longer exists (BMI then
  // returns BillNotFound at payment/confirm — AFTER the card is captured, the
  // "charged but empty" failure). Re-check the bill is live BEFORE any Square
  // write. Fail-open on a transient overview error: a BMI hiccup must never block
  // a legitimate paying customer, and the auto-cancel case returns a clean empty
  // overview (caught), not an error.
  if (hasBmi && session.bmiBillId) {
    let live = true;
    try {
      live = await bmiBillIsLive(resolveBmiClientKey(session), session.bmiBillId);
    } catch (err) {
      console.error("[unifiedReserve] bill liveness check errored (failing open):", err);
    }
    if (!live) {
      console.error(
        `[unifiedReserve] BILL_EXPIRED — bmiBillId ${session.bmiBillId} auto-cancelled before payment; refusing to charge`,
      );
      throw new BillExpiredError();
    }
  }

  // ── 0b. Guard: cross-reservation heat spacing ──────────────────────
  // A racer must not dodge the same-track / cross-track spacing rules by
  // booking each heat in a SEPARATE reservation. Match the cart's heats (by
  // each racer's bmiPersonId) against the party's already-booked heats for the
  // same day in Neon, and reject BEFORE any Square write. Fail-open on a query
  // error — an outage must never block a legitimate paying customer.
  if (raceItems.length > 0) {
    const cartHeats = raceItems
      .flatMap((r) => raceHeatsMetadata(r.heats, session.party))
      .filter((h) => typeof h.heatId === "string" && typeof h.bmiPersonId === "string")
      .map((h) => ({
        heatId: h.heatId as string,
        track: (h.track as string | null) ?? null,
        bmiPersonId: h.bmiPersonId as string,
        racer: (h.racer as string | null) ?? null,
      }));
    const personIds = [...new Set(cartHeats.map((h) => h.bmiPersonId))];
    const dates = [...new Set(cartHeats.map((h) => h.heatId.slice(0, 10)))];
    if (personIds.length > 0) {
      try {
        const existing = (
          await Promise.all(
            dates.map((date) =>
              raceHeatsForPersonsOnDate({ date, personIds, excludeBillId: session.bmiBillId }),
            ),
          )
        ).flat();
        const conflict = findCrossBookingConflict(cartHeats, existing);
        if (conflict) {
          console.error(
            `[unifiedReserve] EXISTING_BOOKING_CONFLICT — person ${conflict.cart.bmiPersonId} cart ${conflict.cart.heatId} vs booked ${conflict.existing.heatId}`,
          );
          throw new ExistingBookingConflictError(existingBookingConflictMessage(conflict));
        }
      } catch (err) {
        if (err instanceof ExistingBookingConflictError) throw err;
        console.error("[unifiedReserve] cross-reservation check errored (failing open):", err);
      }
    }
  }

  // ── 1. Extend QAMF holds as safety net ────────────────────────────
  for (const item of bowlingItems) {
    if (item.qamfReservationId && item.qamfCenterId) {
      try {
        await extendReservation(item.qamfCenterId, item.qamfReservationId);
      } catch {
        // Non-fatal — confirm step handles expired holds
      }
    }
  }

  // ── 2. Build combined Square line items ────────────────────────────
  const { sqLineItems, depositPct, promoSavingsCents, kioskPacks, packCoverage } =
    buildCombinedLineItems(session);

  if (sqLineItems.length === 0) {
    throw new Error("No line items to charge");
  }

  // ── 2a-packs. Persist race-pack grant obligations BEFORE any money moves
  // (persist-first: throws if the DB is down — never charge on an unpersisted
  // obligation). Idempotent on baseKey, so prepare + finalize re-write the
  // same rows.
  if (kioskPacks.length > 0) {
    await upsertPackPurchases({ purchaseKey: baseKey, surface: "booking", packs: kioskPacks });
  }

  // ── 2b. Validate credit redemptions (charge-time re-eval) ─────────
  // Re-check each redeeming racer's LIVE balance before charging. Throws
  // CreditRedemptionError (→ 400 in the route) on a stale/insufficient balance,
  // so we never charge or give a free race on a credit they no longer hold.
  // Combo special: race credits never combine with the flat combo price — the
  // checkout hides the opt-in, and this guard makes sure no stale opt-in can
  // deduct credits the combo line didn't discount for.
  const creditRedemptions =
    activeComboSpecial(session) != null ? [] : redemptionsFromSession(session);
  if (creditRedemptions.length > 0) {
    await validateCreditRedemptions(creditRedemptions);
  }

  // ── 2c. Validate World Cup match windows (fail-closed) ────────────
  // Config-driven server check against the fixture table: a stale or doctored
  // client session can't book a disabled center or a non-kickoff start.
  // Throws WorldCupReservationError (→ 409 in reserve-all) BEFORE any Square
  // or QAMF write — nothing is charged.
  for (const item of bowlingItems) {
    if (item.kind === "bowling" && isWorldCupBowlingItem(item)) {
      validateWorldCupBooking({ center: session.center, bookedAt: item.bookedAt });
      if (item.optionId == null) {
        throw new WorldCupReservationError(
          "World Cup booking is missing its lane time option — please re-pick your match.",
        );
      }
    }
  }

  // ── 3. Create the Square day-of order(s) ──────────────────────────
  // Default: ONE order at the session's location. COMBO SPLIT: the itemized
  // revenue lines are grouped by entity (FastTrax racing + HeadPinz bowling)
  // into TWO orders at their own locations, each with its own location tax —
  // so revenue books where it belongs. One deposit + one shared gift card
  // fund both (a Square gift card is seller-wide), and each location's
  // settlement (race-dayof-pay / lane-open) charges the card for ITS order's
  // own outstanding total. See tasks/combo-split-orders-plan.md.
  const createDayofOrder = async (
    locId: string,
    items: SquareLineItem[],
    keySuffix: string,
  ): Promise<{ orderId: string; totalCents: number }> => {
    const taxCatalogId = LOCATION_TAX[locId];
    const orderTaxes = taxCatalogId
      ? [{ uid: "location-sales-tax", catalog_object_id: taxCatalogId, scope: "ORDER" }]
      : [];
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `unified-dayof-${baseKey}-${keySuffix}`,
        order: {
          location_id: locId,
          ...(input.squareCustomerId ? { customer_id: input.squareCustomerId } : {}),
          line_items: items.map((li) => {
            if (li.catalogObjectId) {
              return {
                catalog_object_id: li.catalogObjectId,
                quantity: li.quantity,
                ...(li.basePriceMoney ? { base_price_money: li.basePriceMoney } : {}),
                ...(li.note ? { note: li.note } : {}),
              };
            }
            return {
              name: li.name,
              quantity: li.quantity,
              base_price_money: li.basePriceMoney,
              ...(li.note ? { note: li.note } : {}),
            };
          }),
          ...(orderTaxes.length > 0 ? { taxes: orderTaxes } : {}),
        },
      }),
    });
    const data = await res.json();
    if (!res.ok || data.errors) {
      const sqErr = data.errors?.[0];
      throw new Error(`Square order failed: ${sqErr?.code}: ${sqErr?.detail}`);
    }
    const orderId: string = data.order?.id;
    if (!orderId) throw new Error("Square order returned no ID");
    return { orderId, totalCents: data.order?.total_money?.amount ?? 0 };
  };

  // squareDayofOrderId = the PRIMARY order (race/BMI anchor + the return value).
  // bowlingDayofOrderId = the order the bowling Neon row settles against (its
  // own order in a combo; the same single order otherwise).
  const orderGroups = comboOrderGroups(session);
  let squareDayofOrderId: string;
  let dayofTotalCents: number;
  let bowlingDayofOrderId: string;
  // Per-order tax-inclusive totals, stored on each Neon row so settlement +
  // reporting reflect that order's share (not the combined combo total).
  // Both equal dayofTotalCents for a single order.
  let bowlingOrderTotalCents: number;
  let raceOrderTotalCents: number;
  // Pre-reward total of the ONE order the loyalty reward attaches to
  // (squareDayofOrderId). The reward block below subtracts this order's
  // reduction from the COMBINED total — see the reward fix there.
  let primaryDayofPreRewardCents: number;
  if (orderGroups) {
    const byEntity: Record<string, { orderId: string; totalCents: number }> = {};
    for (const g of orderGroups) {
      const locId =
        g.entity === "fasttrax-fm" ? SQUARE_LOCATIONS.FASTTRAX_FM : SQUARE_LOCATIONS.HEADPINZ_FM;
      const items: SquareLineItem[] = g.lines.map((l) => ({
        name: l.name,
        quantity: String(l.quantity),
        catalogObjectId: l.catalogObjectId,
        basePriceMoney: { amount: l.unitCents, currency: "USD" },
      }));
      byEntity[g.entity] = await createDayofOrder(locId, items, g.entity);
    }
    const ft = byEntity["fasttrax-fm"];
    const hp = byEntity["headpinz-fm"];
    // FastTrax racing order anchors the BMI/race side; HeadPinz order settles
    // via lane-open. If a combo ever has only one entity, both point at it.
    squareDayofOrderId = ft?.orderId ?? hp!.orderId;
    bowlingDayofOrderId = hp?.orderId ?? squareDayofOrderId;
    bowlingOrderTotalCents = hp?.totalCents ?? 0;
    raceOrderTotalCents = ft?.totalCents ?? 0;
    dayofTotalCents = (ft?.totalCents ?? 0) + (hp?.totalCents ?? 0);
    // The reward applies to squareDayofOrderId (ft when present, else hp).
    primaryDayofPreRewardCents = ft?.totalCents ?? hp?.totalCents ?? 0;
  } else {
    // Entity-owned location — NOT the kiosk deposit location (revenue routing).
    const single = await createDayofOrder(dayofLocationId, sqLineItems, "single");
    squareDayofOrderId = single.orderId;
    bowlingDayofOrderId = single.orderId;
    bowlingOrderTotalCents = single.totalCents;
    raceOrderTotalCents = single.totalCents;
    dayofTotalCents = single.totalCents;
    primaryDayofPreRewardCents = single.totalCents;
  }

  // ── 4. Loyalty reward ─────────────────────────────────────────────
  let loyaltyRewardId: string | undefined;
  const rewardDiscountCents = input.rewardDiscountCents ?? 0;

  if (input.rewardTierId && input.loyaltyAccountId && SQUARE_TOKEN) {
    try {
      const createRes = await fetch(`${SQUARE_BASE}/loyalty/rewards`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          reward: {
            loyalty_account_id: input.loyaltyAccountId,
            reward_tier_id: input.rewardTierId,
            order_id: squareDayofOrderId,
          },
          idempotency_key: `reward-${squareDayofOrderId}-${input.rewardTierId}`,
        }),
      });
      const createData = await createRes.json();
      if (createRes.ok && createData.reward?.id) {
        loyaltyRewardId = createData.reward.id;

        // Re-fetch order total after reward adjustment
        try {
          const orderRes = await fetch(`${SQUARE_BASE}/orders/${squareDayofOrderId}`, {
            headers: sqHeaders(),
          });
          if (orderRes.ok) {
            const orderData = await orderRes.json();
            const adjusted = orderData.order?.total_money?.amount;
            if (typeof adjusted === "number") {
              // The reward discounts ONLY the order it's attached to
              // (squareDayofOrderId), whose pre-reward total is
              // primaryDayofPreRewardCents. Subtract THAT order's reduction from
              // the COMBINED total. The old code overwrote dayofTotalCents with
              // this one order's post-reward total — which, for a combo split
              // (two day-of orders), dropped the OTHER order entirely and
              // undercharged the deposit by the bowling leg's full amount.
              // (Marudas incident, 2026-06-23.)
              const rewardReduction = primaryDayofPreRewardCents - adjusted;
              if (rewardReduction > 0) dayofTotalCents -= rewardReduction;
            }
          }
        } catch {
          // Non-fatal
        }
      } else {
        // Square rejected the reward create — log WHY (scope/points/account
        // mismatch) so the hard-fail below is diagnosable. Mirrors the bowling
        // path's logging.
        const e = createData.errors?.[0];
        console.error(
          `[unified-reserve] Loyalty reward creation failed: ${createRes.status} ${e?.code}: ${e?.detail}`,
        );
      }
    } catch (err) {
      console.error("[unified-reserve] Loyalty reward error:", err);
      if (loyaltyRewardId) {
        await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
          method: "DELETE",
          headers: sqHeaders(),
        }).catch(() => {});
        loyaltyRewardId = undefined;
      }
    }
  }

  if (rewardDiscountCents > 0 && !loyaltyRewardId) {
    throw new RewardFailedError();
  }

  // Note: no separate displayed==charged guard here. The USA250 reduction is
  // computed by the SAME deterministic helper (promo-pricing) on both the display
  // and charge sides, so the discounted price matches by construction — exactly
  // like the per-racer membership discount. A naive total-compare guard is unsafe
  // in this flow: the client "due now" (credits/partial deposit) and the server's
  // full post-reward order total are different quantities and would false-positive.

  // ── 5. Charge ONE deposit ─────────────────────────────────────────
  // CRITICAL (combo split): dayofTotalCents is the SUM of BOTH day-of orders
  // (FastTrax racing + HeadPinz bowling, tax-inclusive). The single deposit is
  // depositPct% of that combined total, so the one shared gift card is loaded
  // with the full amount and each order's settlement can draw its own share.
  const rawDepositCents = Math.round((dayofTotalCents * depositPct) / 100);
  const depositCents = Math.max(0, rawDepositCents - (loyaltyRewardId ? 0 : rewardDiscountCents));

  let depositResult: {
    depositOrderId: string | null;
    depositPaymentId: string | null;
    giftCardId: string | null;
    giftCardGan: string | null;
  } = { depositOrderId: null, depositPaymentId: null, giftCardId: null, giftCardGan: null };
  /** KIOSK: charged Game Zone card rows for the confirmation screen to fulfill. */
  let gameCardFulfillment: GameCardFulfillment | undefined;
  /** KIOSK: race-pack outcomes for the confirmation screen ("1 used, 2 banked"). */
  let racePacksResult: UnifiedReserveResult["racePacks"];

  const useTerminal = kioskTerminalEnabled() && !!input.externalPayment;

  // ── KIOSK Game Zone cards riding this cart (owner 2026-07-18) ────────
  // Resolved server-side from TOKEN_PACKAGES — the session carries pointers
  // only, never prices. The card lines ride the DEPOSIT order (never day-of);
  // their total adds to the reader charge; the gift card still funds the
  // booking deposit alone. Terminal (reader) rail only — the kiosk client
  // gates "Add to my visit" on the reader, and we fail CLOSED here so a
  // non-terminal payment can never silently drop paid-for cards.
  const gzPurchase =
    session.context?.kiosk && kioskGzCartEnabled()
      ? resolveCartPurchase(session.gameCardPurchase)
      : null;
  const gzCents = gzPurchase?.totalCents ?? 0;
  if (gzPurchase && !prepareOnly && !useTerminal) {
    throw new Error(
      "Game Zone cards in the cart require the reader payment — please see the front desk.",
    );
  }
  if (gzPurchase && depositCents <= 0) {
    // Fully-credit-covered booking + cards would leave nothing for the GC line
    // to anchor. Rare edge — buy the cards standalone instead.
    throw new Error(
      "This booking is fully covered by credits — please buy the Game Zone cards separately.",
    );
  }
  const gzLocationCode = gzPurchase
    ? centerCodeFor(session.center ?? "fort-myers", session.entryBrand)
    : null;

  if (depositCents > 0) {
    const ganPrefix = buildGanPrefix("WEB", locationId);
    // Stable GAN suffix from the session anchor (matches reserve's bill.slice(-8))
    // so a retry replays gc-${baseKey} with the SAME requested GAN — one card,
    // never a second.
    const ganSuffix = (
      session.bmiBillId ??
      bowlingItems[0]?.qamfReservationId ??
      seedSource ??
      baseKey
    ).slice(-8);
    const depositNote = `Deposit - ${ganPrefix}${ganSuffix} - ${new Date().toISOString().slice(0, 10)}`;

    // ── KIOSK PREPARE: create the deposit order the reader will pay, persist a
    // recoverable anchor, then STOP. The full reserve re-runs (idempotently)
    // once the reader has captured the card. All fallible guards above already
    // ran, so no money moves after a step that can still fail (H3074 rule). ──
    if (prepareOnly) {
      console.log(
        `[kiosk-terminal] PREPARE dayofTotalCents=${dayofTotalCents} depositPct=${depositPct} → depositCents=${depositCents} gzCents=${gzCents} loc=${locationId} seed=${seedSource ?? baseKey}`,
      );
      // Game Zone cards: persist one ledger row per card BEFORE the order exists
      // (persist-first — every card durable before any money moves), and stash
      // the row pointers on the anchor so finalize can mark them charged.
      let anchorGameCards: TerminalAnchor["gameCards"];
      if (gzPurchase && gzLocationCode != null) {
        const groupId = randomUUID();
        const cards: NonNullable<TerminalAnchor["gameCards"]>["cards"] = [];
        for (const c of gzPurchase.cards) {
          const txnId = randomUUID();
          await startTxn({
            txnId,
            groupId,
            kind: gzPurchase.mode,
            locationCode: gzLocationCode,
            accountNumber: c.accountNumber,
            packageId: c.packageId,
            tokens: c.pkg.tokens,
            bonusTokens: c.pkg.bonusTokens,
            amountCents: c.pkg.priceCents,
            tpiTransactionId: `${gzPurchase.mode === "new_card" ? "newcard" : "reload"}-${txnId}`,
            contact: {
              name: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || undefined,
              email: contact.email,
              phone: contact.phone,
            },
          });
          cards.push({ txnId, packageId: c.packageId, accountNumber: c.accountNumber });
        }
        anchorGameCards = {
          mode: gzPurchase.mode,
          groupId,
          locationCode: gzLocationCode,
          totalCents: gzCents,
          cards,
        };
      }
      const { depositOrderId } = await createDepositOrder({
        baseKey,
        locationId,
        amountCents: depositCents,
        note: depositNote,
        asGiftCardLine: true,
        extraLines: gzPurchase?.orderLines,
      });
      console.log(`[kiosk-terminal] PREPARE created deposit order ${depositOrderId}`);
      await writeTerminalAnchor(seedSource ?? baseKey, {
        depositOrderId,
        depositCents,
        locationId,
        baseKey,
        ...(anchorGameCards ? { gameCards: anchorGameCards } : {}),
      });
      return {
        __prepare: true,
        seed: seedSource ?? baseKey,
        depositOrderId,
        // The reader charges the ORDER TOTAL: booking deposit + card lines.
        depositCents: depositCents + gzCents,
        locationId,
      };
    }

    if (useTerminal) {
      // Reader already captured the card against OUR deposit order — record it,
      // never re-charge. finalize verifies the payment server-side + funds the GC.
      const ep = input.externalPayment!;
      // Game Zone cards riding the order: the row pointers live on the PREPARE
      // anchor (this exact session wrote them); the payment must cover the
      // booking deposit + the card lines, while the GC funds the deposit only.
      const anchorForGz = gzPurchase ? await readTerminalAnchor(seedSource ?? baseKey) : null;
      const anchorGz = anchorForGz?.gameCards ?? null;
      if (gzPurchase && !anchorGz) {
        // Anchor lost (Redis) — the payment covered card lines we can't tie to
        // ledger rows. Fail LOUD (payment stays put; ops reconciles from the
        // order's card lines) rather than silently confirming without cards.
        await stampTerminalPaymentOnAnchor(seedSource ?? baseKey, ep.paymentId).catch(() => {});
        throw new Error(
          "Game Zone card records for this payment couldn't be found — please see the front desk (do not pay again).",
        );
      }
      try {
        const dr = await finalizeDepositFromExternalPayment({
          baseKey,
          locationId,
          amountCents: depositCents,
          ganPrefix,
          ganSuffix,
          note: depositNote,
          externalPaymentId: ep.paymentId,
          extraLines: gzPurchase?.orderLines,
          extraCents: gzCents,
        });
        depositResult = {
          depositOrderId: dr.depositOrderId,
          depositPaymentId: dr.depositPaymentId,
          giftCardId: dr.giftCardId,
          giftCardGan: dr.giftCardGan,
        };
      } catch (err) {
        // Money is ALREADY captured on the reader. Do NOT re-charge; stamp the
        // paymentId on the anchor (persist-first) so the terminal-orphan
        // reconcile finds it, then rethrow to page on-call.
        await stampTerminalPaymentOnAnchor(seedSource ?? baseKey, ep.paymentId).catch(() => {});
        throw err;
      }
      // Payment verified: mark every card row charged (reloads additionally go
      // pending-awaiting-bridge, standalone-reload parity) and build the
      // fulfillment payload the kiosk confirmation screen dispenses/loads from.
      if (anchorGz) {
        for (const c of anchorGz.cards) {
          await markCharged(c.txnId, depositResult.depositOrderId ?? "", {
            card: ep.paymentId,
          });
          if (anchorGz.mode === "reload") {
            await markLoadState(c.txnId, "pending", "awaiting on-prem bridge load");
          }
        }
        gameCardFulfillment = {
          mode: anchorGz.mode,
          groupId: anchorGz.groupId,
          locationCode: anchorGz.locationCode,
          cards: anchorGz.cards.map((c) => {
            const resolved = gzPurchase!.cards.find((r) => r.packageId === c.packageId);
            return {
              txnId: c.txnId,
              packageId: c.packageId,
              accountNumber: c.accountNumber,
              tokens: resolved?.pkg.tokens ?? 0,
              bonusTokens: resolved?.pkg.bonusTokens ?? 0,
            };
          }),
        };
      }
    } else {
      if (!input.cardSourceId && !input.giftCardNonce) {
        throw new Error("Card or gift card required for paid orders");
      }
      try {
        const dr = await createDepositAndCharge({
          amountCents: depositCents,
          locationId,
          cardSourceId: input.cardSourceId,
          giftCardNonce: input.giftCardNonce,
          squareCustomerId: input.squareCustomerId,
          ganPrefix,
          ganSuffix,
          note: depositNote,
          baseKey,
        });
        depositResult = {
          depositOrderId: dr.depositOrderId,
          depositPaymentId: dr.depositPaymentId,
          giftCardId: dr.giftCardId,
          giftCardGan: dr.giftCardGan,
        };
      } catch (err) {
        // Clean up loyalty reward if deposit fails
        if (loyaltyRewardId) {
          await fetch(`${SQUARE_BASE}/loyalty/rewards/${loyaltyRewardId}`, {
            method: "DELETE",
            headers: sqHeaders(),
          }).catch(() => {});
        }
        throw err;
      }
    }
  } else if (prepareOnly) {
    // $0 deposit (fully credit-covered etc.) — nothing to charge on the reader.
    return {
      __prepare: true,
      seed: seedSource ?? baseKey,
      depositOrderId: "",
      depositCents: 0,
      locationId,
    };
  }

  // Race packs: the deposit (which includes the full pack price) is captured —
  // stamp the ledger rows charged with the order/payment ids (audit + recovery).
  if (kioskPacks.length > 0) {
    await markPackCharged(baseKey, {
      squareOrderId: squareDayofOrderId,
      squarePaymentId: depositResult.depositPaymentId,
    }).catch((err) => console.error("[race-pack] markPackCharged failed (non-fatal):", err));
  }

  // ── Record the USA250 redemption (idempotent, soft-fail) ──────────
  // The deposit is captured + squareDayofOrderId exists, so log the use now —
  // keyed on the order id so a retry never double-counts. A combo's two orders
  // share ONE redemption (the anchor). NEVER fail a captured booking on this.
  if (session.appliedPromo && promoSavingsCents > 0) {
    try {
      const codeRow = await getDiscountCodeByCode(session.appliedPromo.code);
      if (codeRow) {
        await recordRedemption({
          codeId: codeRow.id,
          domain: session.appliedPromo.domains[0] ?? "racing",
          externalRef: squareDayofOrderId,
          amountOffCents: promoSavingsCents,
          squareCustomerId: input.squareCustomerId,
        });
      }
    } catch (err) {
      console.error("[unified-reserve] discount redemption record failed (non-fatal):", err);
    }
  }

  // ── 6. Fan out confirmations ──────────────────────────────────────

  const neonIds: number[] = [];
  const shortCodes: string[] = [];
  const qamfReservationIds: string[] = [];
  let bmiReservationNumber: string | null = null;
  let bmiReservationCode: string | null = null;

  // QAMF confirmations (bowling/kbf)
  const logKey = `unified-reserve:log:${baseKey}`;
  const logEntries: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    logEntries.push(`${new Date().toISOString()} ${msg}`);
  };

  log(
    `[unified-reserve] bowlingItems=${bowlingItems.length} raceItems=${raceItems.length} attractionItems=${attractionItems.length}`,
  );

  // Per-row coupon attribution for the admin board: bowling rows record their
  // own lines' savings; the race/attraction anchor row records the remainder
  // of the cart-wide total (races, attractions, combo lines).
  let bowlingPromoSavingsCents = 0;

  for (const item of bowlingItems) {
    const centerId = item.qamfCenterId ?? 9172;
    const playerCount =
      item.kind === "bowling"
        ? (item as BowlingItem).playerCount
        : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;

    // Kiosk flows collect the roster (names/shoe sizes/bumpers) UP FRONT —
    // when it's on the item, use it (QAMF lane setup + Neon persist below);
    // web keeps the placeholder names, updated post-booking as today.
    const rosterPlayers = (item as BowlingItem).players;
    const players =
      rosterPlayers && rosterPlayers.length > 0
        ? rosterPlayers.map((p, i) => ({
            name: p.name.trim() || `Bowler ${i + 1}`,
            shoeSize: p.shoeSize || null, // "" = own shoes
            bumpers: p.bumpers ?? null,
          }))
        : Array.from({ length: playerCount }, (_, i) => ({
            name: `Bowler ${i + 1}`,
            shoeSize: null as string | null,
            bumpers: null as boolean | null,
          }));

    const guest = {
      name: `${contact.firstName} ${contact.lastName}`.trim(),
      phone: contact.phone ?? "",
      email: contact.email ?? "",
    };
    const bookedAt = item.bookedAt ?? new Date().toISOString();
    const webOfferId = item.webOfferId ?? 0;
    const optionId = item.optionId;
    const optionType = item.optionType ?? "Game";
    const service = "BookForLater";

    const qamfOptions: Record<string, Array<{ Id: number }>> = {};
    if (optionId) {
      if (optionType === "Time") qamfOptions.Time = [{ Id: optionId }];
      else if (optionType === "Unlimited") qamfOptions.Unlimited = [{ Id: optionId }];
      else qamfOptions.Game = [{ Id: optionId }];
    }

    log(
      `[unified-reserve] QAMF confirm: centerId=${centerId} holdId=${item.qamfReservationId ?? "NONE"} ` +
        `webOfferId=${webOfferId} optionId=${optionId} bookedAt=${bookedAt} players=${playerCount} ` +
        `guest=${JSON.stringify(guest)}`,
    );

    // ── QAMF confirm — INLINE from v1 bowling reserve (proven working) ──
    let qamfReservationId: string;
    let qamfConfirmed = false;
    let qamfLanes: Array<{ Id?: string; LaneNumber: number }> = [];

    async function attachAndConfirm(resId: string): Promise<boolean> {
      await setReservationCustomer(centerId, resId, {
        Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
      });
      return setReservationStatus(centerId, resId, "Confirmed");
    }

    try {
      if (item.qamfReservationId) {
        qamfReservationId = item.qamfReservationId;
        log(`[unified-reserve] Hold-first path: ${qamfReservationId}`);

        let holdCustomerAttached = false;
        try {
          await Promise.all([
            setReservationCustomer(centerId, qamfReservationId, {
              Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
            }),
            patchReservation(centerId, qamfReservationId, {
              Title: `${guest.name} (${players.length}p)`,
            }).catch(() => {}),
          ]);
          holdCustomerAttached = true;
          log(`[unified-reserve] Customer attached to ${qamfReservationId}`);
        } catch (err) {
          log(
            `[unified-reserve] Customer attach failed: ${err instanceof Error ? err.message : err}`,
          );
        }

        if (holdCustomerAttached) {
          qamfConfirmed = await setReservationStatus(centerId, qamfReservationId, "Confirmed");
          log(`[unified-reserve] Status confirm result: ${qamfConfirmed}`);
          // Rename title AFTER confirm (hold title stays "Hold (Np)" otherwise)
          if (qamfConfirmed) {
            patchReservation(centerId, qamfReservationId, {
              Title: `${guest.name} (${players.length}p)`,
            }).catch(() => {});
          }
        }

        if (!qamfConfirmed) {
          log(`[unified-reserve] Hold confirm failed — creating fresh`);
          const reservation = await createReservation(centerId, {
            BookedAt: bookedAt,
            Title: `${guest.name} (${players.length}p)`,
            Customer: {
              Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
            },
            WebOffer: { Id: webOfferId, Options: qamfOptions, Services: [service] },
            TotalPlayers: players.length,
          });
          qamfReservationId = reservation.Id;
          qamfLanes = reservation.Lanes ?? [];
          log(`[unified-reserve] Fresh reservation: ${qamfReservationId}`);
          qamfConfirmed = await attachAndConfirm(qamfReservationId).catch(() => false);
        }
      } else {
        log(`[unified-reserve] No hold — creating fresh`);
        const reservation = await createReservation(centerId, {
          BookedAt: bookedAt,
          Title: `${guest.name} (${players.length}p)`,
          Customer: {
            Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
          },
          WebOffer: { Id: webOfferId, Options: qamfOptions, Services: [service] },
          TotalPlayers: players.length,
        });
        qamfReservationId = reservation.Id;
        qamfLanes = reservation.Lanes ?? [];
        qamfConfirmed = await attachAndConfirm(qamfReservationId).catch(() => false);
      }

      // Fetch lanes if not captured from createReservation
      if (qamfLanes.length === 0) {
        try {
          const laneRes = await getReservation(centerId, qamfReservationId);
          qamfLanes = laneRes.Lanes ?? [];
        } catch {
          /* non-fatal */
        }
      }

      // Push player names to QAMF (kiosk rosters carry real bumper choices)
      if (qamfLanes.length > 0) {
        const lane = qamfLanes[0];
        const laneId = lane.Id ?? String(lane.LaneNumber);
        setLanePlayers(
          centerId,
          qamfReservationId,
          laneId,
          players.map((p) => ({
            Name: p.name || "Bowler",
            ...(p.shoeSize ? { ShoeSize: p.shoeSize } : {}),
            ActivateBumpers: p.bumpers ?? false,
          })),
        ).catch(() => {});
      }

      log(`[unified-reserve] QAMF done: id=${qamfReservationId} confirmed=${qamfConfirmed}`);
      qamfReservationIds.push(qamfReservationId);

      // Neon reservation for bowling
      const centerCode = session.center ?? "fort-myers";
      const productKind: ReservationProductKind = item.kind === "kbf" ? "kbf" : "open";

      // This item's share of the USA250-style savings (same per-line math as
      // buildLines) — recorded on the row for the admin board. Combo carts
      // suppress the bowling item's own lines, so their savings ride on the
      // race anchor row instead.
      const comboSuppressed = activeComboSpecial(session) != null;
      const itemVisitDate = item.date ?? item.bookedAt?.slice(0, 10) ?? undefined;
      const itemPromoSavingsCents = (comboSuppressed ? [] : item.lineItems).reduce((s, li) => {
        const full = li.priceCents ?? 0;
        if (full <= 0) return s;
        const f = promoFactor(
          { domain: "bowling", visitDate: itemVisitDate },
          session.appliedPromo,
        );
        return s + (full - Math.round(full * f)) * li.quantity;
      }, 0);
      bowlingPromoSavingsCents += itemPromoSavingsCents;

      // World Cup VIP Bowling: re-derive the fixture SERVER-SIDE from the
      // validated bookedAt (guard 2c) — never a client-supplied label. Live
      // team names fill the TBD slots (fail-soft, Redis-cached) so staff and
      // metadata show real matchups once the bracket resolves. Feeds the Neon
      // booking metadata + the Conqueror title/banner below.
      const wcFixtureStatic =
        item.kind === "bowling" && isWorldCupBowlingItem(item) && item.bookedAt
          ? fixtureForBookedAt(item.bookedAt)
          : null;
      const wcFixture = wcFixtureStatic ? await enrichFixture(wcFixtureStatic) : null;

      let bowlingNeonId: number | null = null;
      try {
        const reservation = await insertBowlingReservation(
          {
            centerCode,
            productKind,
            qamfReservationId,
            squareDepositOrderId: depositResult.depositOrderId ?? undefined,
            squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
            // Combo split: the bowling row settles its OWN HeadPinz order via
            // lane-open (the shared gift card funds it). Single carts: the one
            // order. Totals reflect the bowling order's share (100% deposit).
            squareDayofOrderId: bowlingDayofOrderId,
            squareGiftCardId: depositResult.giftCardId ?? undefined,
            squareGiftCardGan: depositResult.giftCardGan ?? undefined,
            depositCents: orderGroups ? bowlingOrderTotalCents : depositCents,
            totalCents: bowlingOrderTotalCents,
            status: qamfConfirmed ? "confirmed" : "confirm_pending",
            bookedAt: item.bookedAt ?? new Date().toISOString(),
            playerCount,
            guestName: `${contact.firstName} ${contact.lastName}`.trim(),
            guestEmail: contact.email ?? "",
            guestPhone: contact.phone ?? "",
            notes: `v2 unified ${item.kind} booking`,
            bookingSource: session.context?.kiosk ? "kiosk" : "web",
            squareCustomerId: input.squareCustomerId ?? undefined,
            squareLoyaltyRewardId: loyaltyRewardId ?? undefined,
            rewardDiscountCents: loyaltyRewardId ? rewardDiscountCents : undefined,
            // Coupon applied to this item's lines (admin board display).
            promoCode:
              itemPromoSavingsCents > 0 ? (session.appliedPromo?.code ?? undefined) : undefined,
            promoSavingsCents: itemPromoSavingsCents,
            // Combo (Ultimate VIP): stamp the combo id so the reservations
            // portal can flag + group this VIP bowling leg with its race leg
            // (correlated via the shared square_deposit_order_id; each leg
            // settles its own day-of order).
            comboSpecialId: session.comboSpecialId ?? undefined,
            // Booked-pricing stamp (persist-first): HOW the primary line was
            // quantified (per-lane vs per-person × durationMultiplier) so the
            // reservation-edit repricer never has to reverse-engineer it.
            // World Cup VIP Bowling additionally persists WHICH match at
            // capture so ops/admin can tie the lane window to its fixture.
            bookingMetadata: {
              bowling: bowlingBookedPricingStamp(item),
              ...(wcFixture
                ? {
                    worldCup: {
                      matchId: wcFixture.id,
                      round: wcFixture.round,
                      label: fixtureLabel(wcFixture),
                      kickoffEt: item.bookedAt,
                    },
                  }
                : {}),
            },
          },
          item.lineItems.map((li) => ({
            squareProductId: li.squareProductId,
            label: li.label ?? "Bowling",
            quantity: li.quantity,
            unitPriceCents: li.priceCents ?? 0,
          })),
        );
        neonIds.push(reservation.id);
        bowlingNeonId = reservation.id;

        // Persist the roster with the reservation when we actually HAVE one
        // (kiosk collects names/shoes/bumpers up front — persist-at-capture);
        // placeholder-only rosters skip this and fill in post-booking as today.
        if (rosterPlayers && rosterPlayers.length > 0) {
          try {
            await insertReservationPlayers(
              reservation.id,
              players.map((p, i) => ({
                slot: i + 1,
                name: p.name,
                shoeSize: p.shoeSize ?? null,
                bumpers: p.bumpers ?? null,
              })),
            );
          } catch (err) {
            log(`[unified-reserve] insertReservationPlayers failed (non-fatal): ${String(err)}`);
          }
        }

        // Generate short code for confirmation URL (same as v1 bowling reserve)
        try {
          const confirmBase =
            item.kind === "kbf"
              ? "/hp/book/kids-bowl-free/confirmation"
              : "/hp/book/bowling/confirmation";
          const code = await shortenUrl(`${confirmBase}?code=_TMP_`);
          await shortenUrl(`${confirmBase}?code=${code}`, code);
          updateBowlingReservationShortCode(reservation.id, code).catch(() => {});
          shortCodes.push(code);
        } catch {
          // Fall back to reservation.shortCode if shortenUrl fails
          if (reservation.shortCode) shortCodes.push(reservation.shortCode);
        }
      } catch (err) {
        console.error("[unified-reserve] Neon insert (bowling) failed (non-fatal):", err);
      }

      // Combo special (Ultimate VIP): this bowling leg is the combo's VIP lane.
      // Lead the QAMF note with a VIP banner so HeadPinz staff see it's the
      // package, and treat shoes as INCLUDED (owner: VIP includes shoes — the
      // generic slug check below misses VIP hourly experiences).
      const combo = session.comboSpecialId ? getComboSpecial(session.comboSpecialId) : null;

      // Final QAMF title + notes patch (v1 parity — includes shoe status,
      // line items, deposit, short URL, and attraction add-ons). Combo bowling
      // legs get a "VIP Exp." prefix so HeadPinz staff spot the VIP package at a
      // glance in the QAMF reservation list (owner request 2026-06-27).
      const finalTitle = combo
        ? `VIP Exp. ${guest.name} (${players.length}p)`
        : wcFixture
          ? worldCupQamfTitle(guest.name, players.length)
          : `${guest.name} (${players.length}p)`;
      const shortCode = shortCodes[shortCodes.length - 1];

      const finalParts: string[] = [];

      if (combo) {
        finalParts.push(`*** ${combo.name.toUpperCase()} — VIP LANE (paid online) ***`);
      }
      // World Cup: lead the notes with the match so front desk sees what this
      // lane window is for (the "VIP Exp." banner precedent).
      if (wcFixture) {
        finalParts.push(worldCupQamfBanner(wcFixture));
      }

      // Shoe status — staff see it at a glance
      const hasShoeAddOn = item.lineItems.some((li) =>
        (li.label ?? "").toLowerCase().includes("shoe"),
      );
      const shoesIncluded =
        !!combo ||
        item.experienceSlug?.includes("fun-4-all") ||
        item.experienceSlug?.includes("pizza-bowl");
      let shoeLine: string;
      if (combo) {
        shoeLine = "Shoes included (VIP)";
      } else if (hasShoeAddOn) {
        const shoeQty = item.lineItems
          .filter((li) => (li.label ?? "").toLowerCase().includes("shoe"))
          .reduce((s, li) => s + li.quantity, 0);
        shoeLine = `${shoeQty} pair${shoeQty !== 1 ? "s" : ""} shoes paid`;
      } else if (shoesIncluded) {
        shoeLine = "Shoes included";
      } else {
        shoeLine = "SHOES NOT INCLUDED";
      }
      if (shortCode) shoeLine += ` | headpinz.com/s/${shortCode}`;
      finalParts.push(shoeLine);

      // Line items summary
      if (item.lineItems.length > 0) {
        const itemParts = item.lineItems.map((li) => {
          const total = (li.priceCents ?? 0) * li.quantity;
          const totalStr = `$${(total / 100).toFixed(2)}`;
          return li.quantity > 1
            ? `${li.quantity}x ${li.label ?? "Item"} ${totalStr}`
            : `${li.label ?? "Item"} ${totalStr}`;
        });
        finalParts.push(itemParts.join(" + "));
      }

      // Tax-inclusive deposit
      if (depositCents > 0) {
        finalParts.push(`Deposit $${(depositCents / 100).toFixed(2)} paid (incl. tax)`);
      }

      const finalNotes = finalParts.join("\n");
      // Mirror the composed memo into OUR reservation notes FIRST (persist-
      // first rule) so the admin Notes tab shows what Conqueror got —
      // replaces the "v2 unified …" placeholder stamped at insert.
      if (bowlingNeonId != null) {
        updateBowlingReservationNotes(bowlingNeonId, finalNotes).catch(() =>
          log(`[unified-reserve] notes mirror failed (non-fatal)`),
        );
      }
      try {
        await patchReservation(centerId, qamfReservationId, {
          Title: finalTitle,
          Notes: finalNotes,
        });
        log(`[unified-reserve] Final patch OK: title="${finalTitle}"`);
      } catch (err) {
        log(`[unified-reserve] Final patch FAILED: ${err instanceof Error ? err.message : err}`);
      }

      // Combo special: stamp the assigned QAMF lane onto the Redis booking
      // record (keyed by the combo's BMI bill) so the confirmation page can
      // fold it into the single reservation memo it writes (the lane is QAMF
      // data the page never otherwise sees). Best-effort, non-fatal.
      if (session.comboSpecialId && session.bmiBillId && qamfLanes.length > 0) {
        const lane = qamfLanes
          .map((l) => l.LaneNumber)
          .filter((n) => n != null)
          .join(", ");
        // Reorder fallback: the combo ran race → race → bowl (lane AFTER both
        // races) when the lane starts later than every race heat. Stamp it so
        // the confirmation page's reservation memo lists the visit plan in the
        // order it will actually run, not the registry's primary order.
        const comboRaceStartsMs = session.items
          .filter((i): i is RaceItem => i.kind === "race")
          .flatMap((ri) => ri.heats)
          .map((h) => h.heatId)
          .filter((s): s is string => !!s)
          .map((s) => wallClockMs(s));
        const comboBowlMs = item.bookedAt ? wallClockMs(item.bookedAt) : null;
        const comboReorder =
          comboBowlMs != null &&
          comboRaceStartsMs.length > 0 &&
          comboRaceStartsMs.every((m) => m < comboBowlMs);
        if (lane) {
          try {
            const key = `bookingrecord:${session.bmiBillId}`;
            const existing = await redis.get(key);
            if (existing) {
              const rec = typeof existing === "string" ? JSON.parse(existing) : existing;
              await redis.set(
                key,
                JSON.stringify({ ...rec, bowlingLane: lane, comboReorder }),
                "EX",
                60 * 60 * 24 * 90,
              );
            }
          } catch (err) {
            log(`[unified-reserve] booking-record lane stamp failed: ${err}`);
          }
        }
      }
    } catch (err) {
      // QAMF failed after the deposit was CAPTURED. Do NOT roll back — a captured
      // payment can't be voided and the funds back the gift card. The bowling row
      // (written above as confirm_pending when QAMF didn't confirm) is driven
      // forward by the bowling-confirm-retry cron.
      console.error("[unified-reserve] QAMF confirm failed (deposit retained):", err);
      throw err;
    }
  }

  // Persist QAMF logs to Redis for debugging (avoids Vercel log truncation)
  if (logEntries.length > 0) {
    redis.set(logKey, JSON.stringify(logEntries), "EX", 86400).catch(() => {});
  }

  // BMI confirmations (race/attraction)
  if (hasBmi && session.bmiBillId) {
    const clientKey = resolveBmiClientKey(session);
    const bmiBillId = session.bmiBillId;
    // STRICT $0 gate (matches checkout.ts): EVERY race item must legitimately use
    // the $0 model before we confirm the BMI bill as a $0 credit. A real-priced
    // item confirmed at $0 = money leak. Packages/combos now pass this (their
    // heats resolve $0 build pairs); a legacy/add-on item correctly fails it.
    const useZeroModel = raceItems.length > 0 && raceItems.every(raceUsesZeroBmiModel);
    const centerCode = session.center ?? "fort-myers";
    const bookingKind: ReservationProductKind = raceItems.length > 0 ? "race" : "attraction";

    // Build the BMI reservation lines + metadata up front so we can anchor the
    // row BEFORE confirming (the deposit is already CAPTURED at this point).
    const bmiLines = [
      ...raceItems.flatMap((r) =>
        r.heats
          .filter((h) => h.productId)
          .map((h) => {
            const product = getRaceProductById(h.productId!);
            return {
              label: product?.name ?? "Race",
              quantity: 1,
              unitPriceCents: Math.round((product?.price ?? 0) * 100),
            };
          }),
      ),
      ...attractionItems.map((a) => ({
        label: a.slug ?? "Attraction",
        quantity: a.qty,
        unitPriceCents: Math.round(a.price * 100),
      })),
    ];

    const bookingMetadata: Record<string, unknown> = {};
    if (raceItems.length > 0) {
      bookingMetadata.heats = raceHeatsMetadata(raceItems[0].heats, session.party);
      bookingMetadata.racerNames = session.party.map((m) => m.firstName);
    }
    // Persist attraction slot START times so the day-of settle cron can tell when
    // the activity has actually happened (the anchor row's booked_at is the
    // BOOKING time, not the slot time). `slot` is the ISO start of the chosen slot.
    if (attractionItems.length > 0) {
      bookingMetadata.attractions = attractionItems
        .filter((a) => a.slot)
        .map((a) => ({
          slug: a.slug,
          slot: a.slot,
          qty: a.qty,
          // Kiosk who's-playing roster (waiver-gated attractions): persist the
          // participant names with the reservation (persist-at-capture) so
          // staff can see who's signed on for the session.
          ...(a.participants && a.participants.length > 0
            ? {
                participants: a.participants
                  .map((id) => session.party.find((m) => m.id === id))
                  .filter((m): m is NonNullable<typeof m> => Boolean(m))
                  .map((m) => ({
                    name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
                    bmiPersonId: m.bmiPersonId ?? null,
                    waiverValid: m.waiverValid ?? false,
                  })),
              }
            : {}),
        }));
    }

    // ── Durable anchor (confirm_pending) BEFORE BMI confirm ───────────
    // A captured deposit must never be stranded without a record. If confirm
    // fails, this row stays confirm_pending/confirm_failed and the
    // race-confirm-reconcile cron drives it forward (money stays on the gift
    // card — never auto-refunded). Idempotent per (bill, kind).
    let bmiNeonId: number | null = null;
    try {
      const existing = await findReusableReservation(bmiBillId, bookingKind);
      if (existing) {
        bmiNeonId = existing.id;
        await updateBowlingReservationSquareIds(existing.id, {
          squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
          squareDayofOrderId,
          squareGiftCardId: depositResult.giftCardId ?? undefined,
          squareGiftCardGan: depositResult.giftCardGan ?? undefined,
        });
      } else {
        const anchor = await insertBowlingReservation(
          {
            centerCode,
            productKind: bookingKind,
            bmiBillId,
            squareDepositOrderId: depositResult.depositOrderId ?? undefined,
            squareDepositPaymentId: depositResult.depositPaymentId ?? undefined,
            // Combo split: the race anchor settles its OWN FastTrax order via
            // race-dayof-pay (shared gift card funds it). Totals reflect the
            // racing order's share (100% deposit). squareDayofOrderId is the
            // FastTrax order for a combo, the single order otherwise.
            squareDayofOrderId,
            squareGiftCardId: depositResult.giftCardId ?? undefined,
            squareGiftCardGan: depositResult.giftCardGan ?? undefined,
            depositCents: orderGroups ? raceOrderTotalCents : depositCents,
            totalCents: orderGroups ? raceOrderTotalCents : dayofTotalCents,
            status: "confirm_pending",
            bookedAt: new Date().toISOString(),
            playerCount:
              raceItems.reduce((s, r) => s + r.heats.length, 0) +
              attractionItems.reduce((s, a) => s + a.qty, 0),
            guestName: `${contact.firstName} ${contact.lastName}`.trim(),
            guestEmail: contact.email ?? "",
            guestPhone: contact.phone ?? "",
            notes: `v2 unified ${bookingKind} booking`,
            bookingSource: session.context?.kiosk ? "kiosk" : "web",
            squareCustomerId: input.squareCustomerId ?? undefined,
            squareLoyaltyRewardId: loyaltyRewardId ?? undefined,
            rewardDiscountCents: loyaltyRewardId ? rewardDiscountCents : undefined,
            // Coupon share not carried by the bowling rows (races, attractions,
            // combo lines) — cart-wide total minus the bowling rows' share.
            promoCode:
              promoSavingsCents - bowlingPromoSavingsCents > 0
                ? (session.appliedPromo?.code ?? undefined)
                : undefined,
            promoSavingsCents: Math.max(0, promoSavingsCents - bowlingPromoSavingsCents),
            bookingMetadata,
            // Combo (Ultimate VIP): stamp the combo id on the race/attraction
            // leg too, so it groups with the VIP bowling leg in the portal.
            comboSpecialId: session.comboSpecialId ?? undefined,
          },
          bmiLines,
        );
        bmiNeonId = anchor.id;
      }
      if (bmiNeonId != null) neonIds.push(bmiNeonId);
    } catch (err) {
      // The anchor IS the recovery record; if we can't write it after capturing
      // the deposit, fail BEFORE confirming so the client retries (idempotent).
      console.error("[unified-reserve] BMI anchor write failed:", err);
      throw new Error("Could not persist reservation. Please retry.");
    }

    try {
      const bmiResult = await confirmBmiPayment({
        clientKey,
        bmiBillId,
        amountCents: useZeroModel ? 0 : dayofTotalCents,
        asCredit: useZeroModel,
      });
      bmiReservationNumber = bmiResult.reservationNumber;
      bmiReservationCode = bmiResult.reservationCode;

      // BMI Office project id = orderId + 1 (last-10-digit math stays under
      // MAX_SAFE_INTEGER; the rest of the id is preserved as raw text). Computed
      // ONCE here so the Pandora state flip below AND the kiosk post-reserve rail
      // target the SAME project — never recompute it independently.
      const officeProjectIdNum = (Number(bmiBillId.slice(-10)) + 1).toString();
      const officeProjectId = bmiBillId.slice(0, -officeProjectIdNum.length) + officeProjectIdNum;

      // Idempotency cache for /api/booking/confirm — the v2 confirmation page calls
      // that endpoint on load; without this it cache-MISSES and re-runs BMI
      // payment/confirm, and the second confirm reverts the project state back to
      // pending. Pre-writing the same cache entry makes the page's call a no-op.
      // Key/shape/TTL must match app/api/booking/confirm/route.ts.
      if (bmiReservationNumber) {
        try {
          await redis.set(
            `bmi:confirmed:${bmiBillId}`,
            JSON.stringify({
              reservationNumber: bmiReservationNumber,
              reservationCode: bmiReservationCode ?? `r${bmiBillId}`,
              orderId: bmiBillId,
            }),
            "EX",
            86400 * 7,
          );
        } catch {
          // Redis down — non-fatal.
        }
      }

      // BMI_AUTOCANCEL_WORKAROUND (mirror of /api/booking/v2/reserve). BMI's
      // payment/confirm records the payment but does NOT set the project-level
      // confirm flag; an unconfirmed project auto-cancels ~168 min later. Set the
      // project state to -3 (Confirmation) via Pandora so cash/mixed race +
      // attraction bookings confirm immediately instead of relying on the
      // bmi-cancel-sweep cron. projectId = orderId + 1 (last-10-digit math stays
      // under MAX_SAFE_INTEGER; the rest of the id is preserved as raw text).
      //
      // RETRIED at book time (owner 2026-07-18: a reservation sat "Pending online"
      // until a cron flipped it hours later). A single transient Pandora failure
      // used to leave the project unconfirmed until race-confirm-reconcile /
      // bmi-cancel-sweep ran; a few quick retries land the confirm before the
      // guest even leaves the kiosk. Still non-fatal — the crons stay the backstop
      // if Pandora is genuinely down (a loud log flags that case for ops).
      {
        const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
        const pandoraLocationId =
          raceItems.length > 0
            ? "LAB52GY480CJF"
            : session.center === "naples"
              ? "PPTR5G2N0QXF7"
              : "TXBSQN0FEKQ11";
        let stateConfirmed = false;
        for (let attempt = 1; attempt <= 3 && !stateConfirmed; attempt++) {
          try {
            const stateRes = await fetch(
              "https://bma-pandora-api.azurewebsites.net/v2/bmi/reservation/state",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${pandoraKey}`,
                },
                body: JSON.stringify({
                  locationID: pandoraLocationId,
                  projectId: officeProjectId,
                  stateID: "-3",
                }),
                signal: AbortSignal.timeout(10_000),
              },
            );
            stateConfirmed = stateRes.ok;
            console.log(
              `[unified-reserve] Pandora project ${officeProjectId} state → -3 (Confirmation) attempt ${attempt}: ${stateRes.ok ? "OK" : stateRes.status}`,
            );
          } catch (pandoraErr) {
            console.error(
              `[unified-reserve] Pandora state update attempt ${attempt} failed (non-fatal):`,
              pandoraErr,
            );
          }
          if (!stateConfirmed && attempt < 3) await new Promise((r) => setTimeout(r, 600));
        }
        if (!stateConfirmed) {
          console.error(
            `[unified-reserve] Pandora confirm (state -3) NOT set for project ${officeProjectId} after 3 attempts — reservation may sit "Pending online" until the reconcile cron. bill=${bmiBillId}`,
          );
        }
      }

      // Heat setup patch — set each booked heat block's name/style for its race
      // level (kills the manual "Placeholder" setup step). ALL race items' heats
      // (bookingMetadata only packs raceItems[0]). Never throws.
      if (raceItems.length > 0) {
        await patchHeatSetups(
          raceItems.flatMap((r) => r.heats),
          { source: "unified-reserve", billId: bmiBillId },
        );
      }

      // Deduct redeemed race credits (post-confirm). Idempotent per heat; a failed
      // deduct enqueues to the retry sweep. Never throws.
      if (creditRedemptions.length > 0) {
        await deductCreditRedemptions(creditRedemptions, { billId: bmiBillId });
      }

      // KIOSK race packs: money verified + booking confirmed → grant each pack's
      // credits (NX-idempotent, sweep-recovered), THEN cover today's heats by
      // deducting against the just-granted balance via the same redeem rail.
      // Order matters: grant before deduct. Neither throws — the guest's booking
      // already succeeded; failures recover forward.
      if (kioskPacks.length > 0) {
        const outcomes = await grantKioskRacePacks({ purchaseKey: baseKey, packs: kioskPacks });
        if (packCoverage.redemptions.length > 0) {
          await deductCreditRedemptions(packCoverage.redemptions, { billId: bmiBillId });
        }
        racePacksResult = kioskPacks.map((p) => {
          const usedToday = packCoverage.usedByMember.get(p.memberId) ?? 0;
          return {
            memberName: p.memberName,
            label: p.label,
            raceCount: p.pack.raceCount,
            usedToday,
            banked: p.pack.raceCount - usedToday,
            granted: outcomes.find((o) => o.memberId === p.memberId)?.granted ?? false,
          };
        });
      }

      // Promote the anchor → confirmed. Non-fatal: race-confirm-reconcile
      // promotes it if this fails (re-confirm is a cached no-op via bmi:confirmed).
      if (bmiNeonId != null) {
        try {
          await updateBowlingReservationConfirmed(bmiNeonId, {
            bmiReservationNumber: bmiReservationNumber ?? undefined,
          });
        } catch (err) {
          console.error("[unified-reserve] BMI confirmed-status update failed (non-fatal):", err);
        }
      }

      // ── Kiosk post-reserve rail (server-side; WEB never enters) ──────
      // A self-service kiosk terminal has no client-side confirmation step to
      // fire the guest notification / Pandora session assignment the web
      // confirmation page runs. Do it here, gated STRICTLY on the kiosk context
      // flag so the web path is byte-identical. Lazy-imported so the module (and
      // its bmi-office-actions chain) never loads on the web path. Never throws
      // out of reserve — the booking is already confirmed + charged.
      if (session.context?.kiosk && bmiReservationNumber && raceItems.length > 0) {
        // Run the rail AFTER the response is sent (Next after()) so the guest
        // isn't held at the reader while the notification + memo + office-state +
        // the 8s-delayed Pandora session assignment fire. Vercel keeps the
        // function alive for the after() callback, so it still completes
        // reliably. Snapshot the args now (bmiReservationCode is reassigned
        // above). Never throws into reserve.
        // Snapshot the (narrowed) values — bmiReservationNumber is a `let` that
        // the closure would otherwise widen back to string | null.
        const resNumber: string = bmiReservationNumber;
        const resCode = bmiReservationCode;
        const runKioskPost = async () => {
          try {
            const { runKioskPostReserve, buildKioskRacers } = await import("./kiosk-post-reserve");
            await runKioskPostReserve({
              racers: buildKioskRacers(session, raceItems),
              contact,
              bmiBillId,
              bmiReservationNumber: resNumber,
              bmiReservationCode: resCode,
              officeProjectId,
              centerCode,
              location: session.center === "naples" ? "naples" : "fort-myers",
              isNewRacer: session.party.some((m) => m.isNewRacer),
            });
          } catch (e) {
            console.error("[kiosk-post] failed (non-fatal):", e);
          }
        };
        try {
          after(runKioskPost);
        } catch {
          // after() outside a request scope (script/cron) — run inline; those
          // contexts stay alive so a fire-and-forget still completes.
          void runKioskPost();
        }
      }
    } catch (err) {
      // Captured deposit stays put (forward recovery, never auto-refund). Mark
      // the anchor confirm_failed; race-confirm-reconcile retries BMI confirm.
      console.error("[unified-reserve] BMI confirm failed (deposit retained):", err);
      if (bmiNeonId != null) {
        await updateBowlingReservationConfirmFailed(
          bmiNeonId,
          err instanceof Error ? err.message : "BMI confirm error",
        );
      }
      throw err;
    }
  }

  // ── Card-vault silent capture (plan §7 — NEVER fails the booking) ──
  // End of the fan-out: every leg's Neon row exists. Quietly keep the deposit
  // card on file so staff can charge approved edit differences later.
  // captureCardFromDeposit never throws by contract; belt-and-braces wrap.
  // NEVER on a kiosk terminal booking — the reader charge vaults no card
  // (owner rule: "Kiosk is NOT going to use saved card").
  if (depositResult.depositPaymentId && input.squareCustomerId && !input.externalPayment) {
    try {
      await captureCardFromDeposit({
        squareCustomerId: input.squareCustomerId,
        paymentId: depositResult.depositPaymentId,
        reservationId: neonIds[0] ?? null,
        depositOrderId: depositResult.depositOrderId,
        baseKey,
        sourceKind: input.sourceKind,
        permanentConsent: input.saveCardConsent === true,
      });
    } catch (err) {
      console.error("[unified-reserve] card-vault capture failed (non-fatal):", err);
    }
  }

  // Combo special: staff booking alert (owner 2026-06-11 — eric/curtis/alex/
  // jacob). Fired only after EVERYTHING above succeeded; never throws.
  if (session.comboSpecialId) {
    await notifyComboBooked({
      session,
      contact,
      bmiBillId: session.bmiBillId,
      bmiReservationNumber,
      squareDayofOrderId,
      totalCents: dayofTotalCents,
      depositOrderId: depositResult.depositOrderId,
    });
  }

  // World Cup: staff booking alert, Ultimate-VIP style (owner 7/6). Mixed
  // carts reserve through THIS rail; bowling-only carts fire the same alert
  // from /api/bowling/v2/reserve. Never throws.
  for (const item of session.items) {
    if (item.kind !== "bowling" || !isWorldCupBowlingItem(item) || !item.bookedAt) continue;
    const wcAlertFixture = fixtureForBookedAt(item.bookedAt);
    if (!wcAlertFixture) continue;
    await notifyWorldCupBooked({
      fixture: await enrichFixture(wcAlertFixture),
      center: session.center ?? "fort-myers",
      guestName: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown guest",
      guestEmail: contact.email,
      guestPhone: contact.phone,
      players: item.playerCount ?? 1,
      totalCents: dayofTotalCents,
      qamfReservationId: item.qamfReservationId ?? null,
      squareDayofOrderId,
    });
  }

  return {
    neonIds,
    shortCodes,
    qamfReservationIds,
    bmiReservationNumber,
    bmiReservationCode,
    squareDayofOrderId,
    giftCardGan: depositResult.giftCardGan,
    depositCents,
    totalCents: dayofTotalCents,
    ...(gameCardFulfillment ? { gameCards: gameCardFulfillment } : {}),
    ...(racePacksResult ? { racePacks: racePacksResult } : {}),
  };
}

export class RewardFailedError extends Error {
  code = "REWARD_FAILED";
  constructor() {
    super("Your reward couldn't be applied right now. Please try again.");
  }
}
