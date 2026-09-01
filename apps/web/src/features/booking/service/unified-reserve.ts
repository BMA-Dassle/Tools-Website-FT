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
import { recordSignageEvent } from "~/features/signage/events.server";
import { buildGanPrefix } from "@/lib/gan";
import {
  createDepositAndCharge,
  createDepositOrder,
  finalizeDepositFromExternalPayment,
  type ExternalTerminalPayment,
} from "./deposit";
import { kioskGzCartEnabled, kioskPovCodesEnabled } from "~/features/kiosk/flags";
import { getOrderPaymentInfo } from "~/features/kiosk/service/square-terminal";
import { kioskAmbientCheckoutEnabled } from "~/features/kiosk/flags";
import { resolveCartPurchase } from "~/features/game-cards/cart-purchase";
import { assertSwipedBlanks } from "~/features/game-cards/service/swiped-blank-guard";
import { startTxn, markCharged, markLoadState } from "~/features/game-cards/data/transactions-log";
import {
  kioskRacePacksEnabled,
  resolveSessionPacks,
  computePackCoverage,
  type ResolvedKioskPack,
  type PackCoverage,
} from "./race-pack-kiosk";
import { grantKioskRacePacks } from "./race-pack-grant.server";
import { upsertPackPurchases, markPackCharged } from "../data/race-pack-purchases-db";
import { addonPurchaseIntents } from "./addon-charge";
import { upsertAddonPurchases } from "../data/addon-purchases-db";
import { grantAddonCredits } from "./addon-grant.server";
import { SQUARE_RACE_PACK_CATALOG_ID } from "../data/packs";
import {
  getRaceSimProduct,
  getRaceSimTrack,
  raceSimPriceFor,
  raceSimItemConfigured,
  RaceSimNotConfiguredError,
  RaceSimMixedCartError,
  RACE_SIM_SQUARE_CATALOG_ID,
} from "~/features/race-sims/products";
import { centerCodeFor } from "~/config/intercard-centers";
import { formatPersonName } from "~/lib/helpers/name-format";
import { after } from "next/server";
import { captureCardFromDeposit, type PaymentSourceKind } from "~/features/card-vault";
import { confirmBmiPayment, getBmiBillStatus } from "./bmi-confirm";
import { reserveBaseKey } from "./reserve-idempotency";
import { describeDroppedLeg, partitionBookableLegs } from "./bookable";
import { nowRounded5EtIso } from "./bowl-now";
import {
  freeLaneCandidates,
  immediateLaneGuardEnabled,
  isImmediateStart,
} from "./immediate-lane-guard";
import { createWithLanePlan, describePinOutcome } from "~/features/lane-plan/pin";
import {
  startReserveAttempt,
  recordReserveCapture,
  finishReserveAttempt,
  type ReserveCartSnapshot,
} from "@/lib/reserve-attempt-log";
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
import { calculateTax } from "./race-pricing";
import { patchHeatSetups } from "./session-setup";
import { raceUsesZeroBmiModel, computeRaceItemPovQty } from "./race";
import { buildRaceChargeLines, raceHeatsMetadata, racerNamesFromHeats } from "./checkout";
import { bowlingBookedPricingStamp } from "./bowling-booked-pricing";
import { promoFactor } from "./promo-pricing";
import {
  recordRedemption,
  getDiscountCodeByCode,
  resolveAppliedPromo,
} from "~/features/discount-codes";
import {
  planVoucherCoverage,
  sessionVouchers,
  voucherIsApplied,
  voucherTarget,
  VoucherNotVerifiedError,
} from "./voucher-redeem";
import { getAppliedVouchersForBill, markVoucherCharged } from "../data/voucher-redemptions-db";
import {
  claimNativeCartVouchers,
  markNativeCartVouchersCharged,
  releaseNativeCartVouchers,
  type NativeCartVoucherRef,
} from "~/features/game-cards/service/native-cart-vouchers";
import { activeComboSpecial, comboOrderGroups } from "~/features/combos/combo-pricing";
import { getComboSpecial, isVipComboBooking } from "~/features/combos/combo-specials";
import { wallClockMs } from "~/features/combos/combo-itinerary";
import { notifyComboBooked } from "~/features/combos/combo-notify";
import { mintComboVoucherIfNeeded } from "~/features/combos/combo-voucher";
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";
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
  isMidnightMadnessSlug,
  midnightMadnessWindowError,
  MidnightMadnessWindowError,
} from "./bowling-offer";
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
import {
  crossCategoryCollisionMessage,
  findCrossBookingConflict,
  findCrossCategorySameStart,
  heatClockLabel,
} from "./conflict";
import { shortenUrl } from "@/lib/short-url";
import { syncShoeKdsLineItems, type ShoeKdsPlayer } from "@/lib/bowling-shoe-kds";
import type {
  BookingSession,
  BowlingItem,
  KbfItem,
  RaceItem,
  RaceHeatAssignment,
  AttractionItem,
  RaceSimItem,
} from "../state/types";
import { raceWarningAckIds } from "../state/types";
import type { ContactInfo } from "../types";
import redis from "@/lib/redis";
import { writeReservationIndexes } from "@/lib/booking-record-index";
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";

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
   * charges a token. See
   * tasks/kiosk-terminal-charge.md.
   */
  externalPayment?: ExternalTerminalPayment;
  /** What the review screen SHOWED (kiosk gate) — diagnostics only, never
   *  pricing: logged against the server-computed deposit with a per-line
   *  breakdown so a drift abort is diagnosable from server logs. */
  expectedCents?: number;
}

/** Result of prepareUnifiedDeposit — the deposit order the reader must pay. */
export interface PrepareDepositResult {
  __prepare: true;
  seed: string;
  depositOrderId: string;
  depositCents: number;
  locationId: string;
  /**
   * Set when this session's deposit order was ALREADY captured on the reader but
   * reserve never ran (client dropped between tap and reserve, then re-entered).
   * The client must NOT arm the reader again — it resumes the booking with
   * `paymentId` via the idempotent reserve-all path. See tasks/kiosk-terminal-resume-plan.md.
   */
  alreadyPaid?: boolean;
  /** The captured reader paymentId, present only when alreadyPaid. */
  paymentId?: string;
  /** ALL captured payment ids when alreadyPaid — a split-captured order (gift
   *  card + tap) has several, and reserve-all's finalize verifies the SUM, so
   *  resuming with just one id would dead-end on TerminalAmountMismatch. */
  paymentIds?: string[];
  /** Per-session secret for the split-tender routes (present only when the
   *  split flag is on) — see TerminalAnchor.splitToken. */
  splitToken?: string;
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
  /** Present only on kiosk racing bookings that purchased POV video (Ultimate
   *  Qualifier / Rookie Pack / individual Viewpoints): the ViewPoint camera
   *  codes claimed for this bill. Empty/absent when the pool was short or the
   *  claim failed — the kiosk rail retries the (billId-idempotent) claim and
   *  every delivery surface gates on codes being present. */
  povCodes?: string[];
  /** Present only when the combo minted its redeem-later voucher (V2 grant):
   *  the confirmation surfaces show the code; absent = the reconcile cron owns
   *  recovery and the guest gets the code by make-good email. */
  comboVoucher?: { code: string; expiresAt: string | null };
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
      // FastTrax duckpin is a bowling item but its revenue books to the FastTrax
      // entity, not HeadPinz — exclude it from the HeadPinz test.
      (isBowlingLike(i) && !(i.kind === "bowling" && (i as BowlingItem).isDuckpin)) ||
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

/**
 * One server-priced display line (tasks/server-quote-pricing-plan.md, PR A).
 * Charged lines carry the money; COVERED units are their own $0 lines tagged
 * with why (owner 2026-07-31: "change the line to credit like the
 * Intermediate race does" — no negative aggregates anywhere). The review
 * screens will render these verbatim (PR B), so display ≡ charge by
 * construction.
 */
export interface PricedLine {
  name: string;
  quantity: number;
  unitCents: number;
  /** $0 here but priced by the Square catalog (the $2.99 booking fee) —
   *  render the KNOWN price, never "free". */
  catalogPricedCents?: number;
  /** Why a $0 line is $0. Absent = a genuinely charged (or $0-value) line. */
  coverage?: {
    kind: "race-credit" | "race-pack" | "voucher" | "combo-inclusion";
    /** Display tag, e.g. "Credit" · "Race Pack" · "Voucher …Z4SX". */
    label: string;
  };
  /** USA250 strikethrough support (pre-discount unit price). */
  originalUnitCents?: number;
}

// Exported for tests (repro of live pricing bugs); not part of the public API.
export function buildCombinedLineItems(session: BookingSession): {
  sqLineItems: SquareLineItem[];
  depositPct: number;
  promoSavingsCents: number;
  kioskPacks: ResolvedKioskPack[];
  packCoverage: PackCoverage;
  /** The quote/display mirror — accumulated ADJACENT to every Square-line
   *  push above it, so the two can only drift if a diff reviewer misses it. */
  pricedLines: PricedLine[];
  /** Charged subtotal (local-priced lines; catalog-priced fees included). */
  totalPriceCents: number;
} {
  const sqLineItems: SquareLineItem[] = [];
  const pricedLines: PricedLine[] = [];
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
          // VARIABLY-priced variations (duckpin EXW7E74I…) REQUIRE a price —
          // a bare catalog line 400'd the whole order (owner repro 2026-07-31,
          // duckpin+gel mixed cart; duckpin-only carts ride the bowling rail,
          // so unified never hit it before). Fixed-price variations accept an
          // equal override, and the deposit math above already uses THIS
          // price, so order total == displayed == deposit by construction.
          // $0-local-price lines (fees priced by the catalog) keep catalog
          // pricing — sending 0 would zero a real fee.
          ...(fullCents > 0 ? { basePriceMoney: { amount: priceCents, currency: "USD" } } : {}),
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
      pricedLines.push({
        name: li.label ?? "Bowling",
        quantity: li.quantity,
        unitCents: priceCents,
        ...(factor !== 1 ? { originalUnitCents: fullCents } : {}),
      });
    }

    // Raw items (pizza/soda $0 passthrough)
    for (const ri of item.rawItems) {
      sqLineItems.push({
        name: ri.name,
        quantity: String(ri.quantity),
        catalogObjectId: ri.catalogObjectId,
        ...(ri.note ? { note: ri.note } : {}),
      });
      pricedLines.push({
        name: ri.name,
        quantity: ri.quantity,
        unitCents: 0,
        coverage: { kind: "combo-inclusion", label: "Included" },
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
      pricedLines.push({ name: "Booking Fee", quantity: 1, unitCents: 0, catalogPricedCents: 299 });
    }
  }

  // Race items — $0 model. Build the SAME charge lines the credit path uses
  // (buildRaceChargeLines: package bundle / combo pack / single + license + POV),
  // so displayed == charged, then map each to a Square line. Credit-redeemed HEATS
  // are excluded (charged $0; one credit deducted each) — capped per racer at their
  // combined eligible balance, so a racer with fewer credits than heats still pays
  // cash for the uncovered heats instead of zeroing the whole order.
  const redeemedHeats = redeemedHeatSet(session);

  // Race packs (CREDIT packs, owner final design 2026-07-18; sold on web to
  // returning racers since 2026-08-10): the pack line rides THIS day-of order
  // (owner: "race packs sold via race flow go on the day-of order") at 100%
  // deposit, and the assignee's booked heats are pack-covered — excluded here
  // exactly like credit-redeemed heats ($0 on Square; one credit deducted
  // post-grant). Net = the owner's sentence: "one payment, one race today,
  // two added to the account." resolveSessionPacks throws on any bad pointer
  // INCLUDING a weekday pack against a weekend race date (fail-closed — never
  // charge on a broken pack).
  const kioskPacks: ResolvedKioskPack[] = kioskRacePacksEnabled()
    ? resolveSessionPacks(session)
    : [];
  const packCoverage: PackCoverage = computePackCoverage(session, kioskPacks, redeemedHeats);
  const creditAndPackHeats =
    packCoverage.heats.size > 0
      ? new Set([...redeemedHeats, ...packCoverage.heats])
      : redeemedHeats;
  // BMI vouchers — ONE coverage plan feeds the whole charge (and the same
  // helper feeds every display): race comps join excludedHeats like
  // credit/pack heats; attraction comps reduce Square quantities below.
  // unifiedReserveInner has already ledger-verified every applied voucher.
  // Combo carts: flat pricing — the plan is skipped (consistent no-op).
  const voucherPlan = activeComboSpecial(session)
    ? null
    : planVoucherCoverage(session, creditAndPackHeats);
  const excludedHeats =
    voucherPlan && voucherPlan.raceHeats.size > 0
      ? new Set([...creditAndPackHeats, ...voucherPlan.raceHeats])
      : creditAndPackHeats;

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
    pricedLines.push({
      name: bl.name,
      quantity: bl.quantity,
      unitCents,
      ...(bl.originalAmount != null && bl.quantity > 0
        ? { originalUnitCents: Math.round((bl.originalAmount * 100) / bl.quantity) }
        : {}),
    });
  }

  // COVERED race heats — each set becomes its own $0 line group, named by the
  // heat's product, tagged with why. This is the per-line "Credit" model the
  // owner asked for; the negative aggregates die in PR B. Voucher tags carry
  // the covering code's tail ("Voucher …Z4SX") — owner approved distinct
  // labels 2026-08-01 — so heats covered by different codes group separately.
  {
    const voucherCodeByHeat = new Map<RaceHeatAssignment, string>();
    for (const p of voucherPlan?.picks ?? []) {
      if (p.raceHeat) voucherCodeByHeat.set(p.raceHeat, p.code);
    }
    const covered: Array<{
      set: ReadonlySet<RaceHeatAssignment>;
      kind: "race-credit" | "race-pack" | "voucher";
      labelFor: (h: RaceHeatAssignment) => string;
    }> = [
      { set: redeemedHeats, kind: "race-credit", labelFor: () => "Credit" },
      { set: packCoverage.heats, kind: "race-pack", labelFor: () => "Race Pack" },
      {
        set: voucherPlan?.raceHeats ?? new Set(),
        kind: "voucher",
        labelFor: (h) => {
          const code = voucherCodeByHeat.get(h);
          return code ? `Voucher …${code.slice(-4)}` : "Voucher";
        },
      },
    ];
    for (const { set, kind, labelFor } of covered) {
      const groups = new Map<string, { name: string; label: string; qty: number }>();
      for (const item of session.items) {
        if (item.kind !== "race") continue;
        for (const h of item.heats) {
          if (!set.has(h)) continue;
          const pid =
            h.productId ?? (h.category === "junior" ? item.productIdJunior : item.productIdAdult);
          const name = (pid ? getRaceProductById(pid)?.name : null) ?? "Race";
          const label = labelFor(h);
          const key = `${name}::${label}`;
          const g = groups.get(key) ?? { name, label, qty: 0 };
          g.qty += 1;
          groups.set(key, g);
        }
      }
      for (const g of groups.values()) {
        pricedLines.push({
          name: g.name,
          quantity: g.qty,
          unitCents: 0,
          coverage: { kind, label: g.label },
        });
      }
    }
  }

  // Attraction items. A voucher whose comp targets an attraction (Laser/Gel/
  // Shuffly Comp) covers ONE unit of the matched item — quantity drops by one
  // on the Square line (the comp line on the BMI bill is the vendor-side
  // counterpart; BMI nets at processing). Combo carts skip coverage (flat
  // pricing) — same rule as the race rail. voucherAttractionCoverage computes
  // the identical discounted unit the display subtracts.
  // Per-attraction covering codes (attr item id → code → units) so the $0
  // covered lines carry "Voucher …Z4SX" tags, one line per covering code.
  const attrCoverCodes = new Map<string, Map<string, number>>();
  for (const p of voucherPlan?.picks ?? []) {
    if (!p.attractionItemId) continue;
    const m = attrCoverCodes.get(p.attractionItemId) ?? new Map<string, number>();
    m.set(p.code, (m.get(p.code) ?? 0) + 1);
    attrCoverCodes.set(p.attractionItemId, m);
  }
  // "gel-blaster" → "Gel Blaster" for guest-facing priced lines (the Square
  // wire line keeps the raw slug — unchanged).
  const prettySlug = (s: string | null): string | null =>
    s ? s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : null;

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
    const coveredUnits = voucherPlan?.attractionUnits.get(attr.id) ?? 0;
    const chargedQty = Math.max(0, attr.qty - coveredUnits);
    const lineTotal = unitCents * chargedQty;
    totalPriceCents += lineTotal;
    totalDepositCents += lineTotal; // 100% deposit for attractions
    promoSavingsCents += (fullUnitCents - unitCents) * chargedQty;
    // Fully voucher-covered: keep the line at $0 (original qty) instead of
    // dropping it — a cart covered entirely by vouchers used to build ZERO
    // Square lines and die on the "No line items to charge" guard (live
    // 2026-07-31, two gel covers). The $0 line keeps the day-of order real
    // (desk/KDS see what was booked), taxes $0, and charges nothing — same
    // convention as the combo's $0 inclusions and the credit-order lines.
    // Covered units — their own $0 line per covering CODE, voucher-tagged
    // (per-line Credit model, "Voucher …Z4SX").
    if (coveredUnits > 0) {
      const attrName = prettySlug(attr.slug) ?? "Attraction";
      const byCode = attrCoverCodes.get(attr.id);
      if (byCode?.size) {
        let remaining = Math.min(coveredUnits, attr.qty);
        for (const [code, units] of byCode) {
          const qty = Math.min(units, remaining);
          if (qty <= 0) continue;
          remaining -= qty;
          pricedLines.push({
            name: attrName,
            quantity: qty,
            unitCents: 0,
            coverage: { kind: "voucher", label: `Voucher …${code.slice(-4)}` },
          });
        }
      } else {
        pricedLines.push({
          name: attrName,
          quantity: Math.min(coveredUnits, attr.qty),
          unitCents: 0,
          coverage: { kind: "voucher", label: "Voucher" },
        });
      }
    }
    if (chargedQty === 0) {
      sqLineItems.push({
        name: attr.slug ?? "Attraction",
        quantity: String(attr.qty),
        ...(catalogId
          ? { catalogObjectId: catalogId, basePriceMoney: { amount: 0, currency: "USD" } }
          : { basePriceMoney: { amount: 0, currency: "USD" } }),
      });
      continue;
    }

    sqLineItems.push({
      name: attr.slug ?? "Attraction",
      quantity: String(chargedQty),
      ...(catalogId
        ? { catalogObjectId: catalogId, basePriceMoney: { amount: unitCents, currency: "USD" } }
        : { basePriceMoney: { amount: unitCents, currency: "USD" } }),
    });
    pricedLines.push({
      name: prettySlug(attr.slug) ?? "Attraction",
      quantity: chargedQty,
      unitCents,
      ...(factor !== 1 ? { originalUnitCents: fullUnitCents } : {}),
    });
  }

  // Race Sims: priced from the in-code catalog (race-sims/products.ts —
  // day-of-week pricing keyed on item.date), collected in FULL (the BMI line
  // is a $0 track key; Square owns the money). ONE shared Square catalog id
  // for every sim line (owner 2026-08-23) with the price as a per-line
  // override + the track riding the line name — the race-pack pattern.
  // Guard 2e (unifiedReserveInner) still refuses BEFORE any Square write
  // until the BMI keys are armed, so an un-armed line can only reach the quote.
  for (const item of session.items) {
    if (item.kind !== "racesim") continue;
    const product = getRaceSimProduct(item.productSlug);
    if (!product) continue; // unready draft — allItemsReady blocks it upstream
    const qty = Math.max(1, item.racerCount);
    const unitCents = Math.round(raceSimPriceFor(product, item.date) * 100);
    const track = getRaceSimTrack(item.trackKey);
    const name = `Race Sims — ${product.name}${track ? ` · ${track.name}` : ""}`;
    totalPriceCents += unitCents * qty;
    totalDepositCents += unitCents * qty;
    sqLineItems.push({
      name,
      quantity: String(qty),
      ...(RACE_SIM_SQUARE_CATALOG_ID
        ? {
            catalogObjectId: RACE_SIM_SQUARE_CATALOG_ID,
            basePriceMoney: { amount: unitCents, currency: "USD" },
          }
        : { basePriceMoney: { amount: unitCents, currency: "USD" } }),
    });
    pricedLines.push({ name, quantity: qty, unitCents });
  }

  // Pack lines LAST (after every booked-thing line) — one revenue line per
  // pack on the day-of order, web race-pack Square SKU, collected in FULL
  // (credits grant right after payment, so the deposit must cover them).
  for (const p of kioskPacks) {
    totalPriceCents += p.priceCents;
    totalDepositCents += p.priceCents;
    sqLineItems.push({
      name: `Race Pack — ${p.label} · ${p.memberName}`,
      // Multi-buy SKUs (BOGO ×N) ride as a real Square quantity so the books
      // show "2 × $20.99", never a mystery $41.98 unit. qty is 1 elsewhere.
      quantity: String(p.qty),
      catalogObjectId: SQUARE_RACE_PACK_CATALOG_ID,
      basePriceMoney: { amount: p.unitPriceCents, currency: "USD" },
    });
    pricedLines.push({
      name: `Race Pack — ${p.label} · ${p.memberName}`,
      quantity: p.qty,
      unitCents: p.unitPriceCents,
    });
  }

  const depositPct =
    totalPriceCents > 0 ? Math.round((totalDepositCents / totalPriceCents) * 100) : 100;

  return {
    sqLineItems,
    depositPct,
    promoSavingsCents,
    kioskPacks,
    packCoverage,
    pricedLines,
    totalPriceCents,
  };
}

/**
 * Server-authoritative QUOTE (tasks/server-quote-pricing-plan.md, PR A/B):
 * the review screens' pricing source. Pure — no Square calls, no claims, no
 * writes; same inputs, same code as the charge, so quote ≡ charge by
 * construction. Tax = FL 6.5% on the charged subtotal (catalog-priced fees
 * included at their known price). Bowling-ONLY carts keep their existing
 * tax-inclusive quote rail.
 */
export function quoteUnifiedSession(session: BookingSession): {
  lines: PricedLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
} {
  const { pricedLines, totalPriceCents } = buildCombinedLineItems(session);
  const catalogFeeCents = pricedLines.reduce(
    (sum, l) => sum + (l.catalogPricedCents ?? 0) * l.quantity,
    0,
  );
  // totalPriceCents already includes the booking fee (added to the deposit at
  // its known price), so no double count — catalogFeeCents is informational.
  void catalogFeeCents;
  const subtotalCents = totalPriceCents;
  const taxCents = Math.round(calculateTax(subtotalCents / 100) * 100);
  return { lines: pricedLines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
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
export interface TerminalAnchorTender {
  /** Position in the tender sequence — assigned from the anchor's monotonic
   *  tenderSeq, never re-used after a cancel (the auth idempotency keys salt
   *  on it, so a re-used slot would replay a burned key). */
  index: number;
  kind: "gift_card" | "terminal";
  paymentId?: string;
  amountCents: number;
  ganLast4?: string;
  /** Square payment.source_type — "GIFT_CARD" for GAN auths; a TERMINAL swipe
   *  of a physical gift card reports "CARD" + cardBrand SQUARE_GIFT_CARD, and
   *  the gift-card cap counts both shapes. */
  sourceType?: string;
  cardBrand?: string;
  last4?: string;
  status: "authorized" | "canceled" | "cancel-failed";
}
export interface TerminalAnchor {
  depositOrderId: string;
  depositCents: number;
  locationId: string;
  baseKey: string;
  paymentId?: string;
  stampedAt?: string;
  // ── Split-tender additions (kiosk v1: one gift card + one tap). Absent on
  //    legacy anchors — every reader is null-safe. ─────────────────────────
  /** True once a gift-card tender was applied to this checkout. */
  split?: true;
  /** Union of every payment id on this deposit order (GC auths + reader
   *  captures), in arrival order. Legacy single-tap flows never set it. */
  paymentIds?: string[];
  /** The applied tenders ledger mirror (authoritative copy in Neon —
   *  kiosk_split_tenders; this is the fast pointer). */
  tenders?: TerminalAnchorTender[];
  /** Retry counter for the auth idempotency keys — bumped whenever a tender
   *  is canceled (remove/abandon) so re-adds never replay a burned key. */
  attempt?: number;
  /** Per-arm counter for the split reader checkout — every arming of the
   *  reader gets a fresh `term-…-r${n}` key (a canceled/timed-out checkout
   *  burns its key; Square replays the dead one otherwise). */
  termArm?: number;
  /** The currently-armed split reader checkoutId — abandon/remove dismiss it
   *  so a tap can't land on a session the guest already walked away from. */
  pendingCheckoutId?: string;
  /** Random per-session secret minted at PREPARE when the split flag is on.
   *  Every split-tender route requires it: the seed (a sequential,
   *  client-visible bill id) is NOT a secret, and without this a guessed seed
   *  would control a stranger's in-flight payment (review 2026-07-29). */
  splitToken?: string;
  /** Set by the capture route after PayOrder reports the order COMPLETED. */
  capturedAt?: string;
  /**
   * The checkout's FULL charge — what the authorized tenders must sum to.
   * Explicit because the writers disagree about depositCents' meaning (the
   * booking rails store the deposit alone and carry Game Zone cents on
   * gameCards; the standalone Game Zone rail stores the whole total).
   * anchorTotalCents() prefers this and falls back to the legacy derivation.
   */
  totalCents?: number;
  /** Monotonic tender-index counter (see TerminalAnchorTender.index). */
  tenderSeq?: number;
  /** Which prepare rail wrote this anchor (diagnostics / sweep triage). */
  source?: "unified" | "bowling" | "gamezone" | "racepack";
  /**
   * The currently-armed reader checkout with the salts it was armed under —
   * universal successor to pendingCheckoutId (which only the split fork
   * wrote, leaving non-split armed checkouts invisible to unwind). The
   * attempt lets the poll discard a tap that landed on a pre-unwind arm.
   */
  pendingCheckout?: { id: string; attempt: number; termArm: number };
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

/**
 * THE anchor writer every prepare rail uses (unified / bowling / Game Zone /
 * race packs). Read-merge-write: a re-prepare of the same seed must never
 * clobber tender bookkeeping (tenders / paymentIds / attempt / termArm /
 * pendingCheckout / capturedAt) that the split routes already stored on this
 * key — the Game Zone rail's original raw SET did exactly that clobber.
 * Returns the written anchor, or null when Redis is down — callers that hand
 * out a splitToken must fail closed on null (a token without an anchor lights
 * the gift-card UI and then answers "no-session" to every use of it).
 */
export async function upsertTerminalAnchor(
  seed: string,
  fields: {
    depositOrderId: string;
    depositCents: number;
    locationId: string;
    baseKey: string;
    splitToken: string;
    /** The FULL charge the tenders must sum to (see TerminalAnchor.totalCents). */
    totalCents: number;
    source: NonNullable<TerminalAnchor["source"]>;
    gameCards?: TerminalAnchor["gameCards"];
  },
): Promise<TerminalAnchor | null> {
  try {
    const raw = await redis.get(terminalAnchorKey(seed));
    const prev: Partial<TerminalAnchor> =
      typeof raw === "string"
        ? (JSON.parse(raw) as Partial<TerminalAnchor>)
        : ((raw as Partial<TerminalAnchor> | null) ?? {});
    const next: TerminalAnchor = {
      ...prev,
      ...fields,
      // A re-prepare keeps the session's existing trust root — handing the
      // NEW token to the new caller while old tenders ride the OLD token
      // would split one money session across two secrets.
      splitToken: prev.splitToken ?? fields.splitToken,
      attempt: prev.attempt ?? 0,
      tenderSeq: prev.tenderSeq ?? prev.tenders?.length ?? 0,
    };
    await redis.set(terminalAnchorKey(seed), JSON.stringify(next), "EX", TERMINAL_ANCHOR_TTL_S);
    return next;
  } catch {
    return null;
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
    // paymentId stays last-won (legacy readers); paymentIds is the union every
    // split-tender consumer reads (dedup append — a re-poll of the same
    // COMPLETED checkout must not double-record).
    const paymentIds = Array.isArray(prev.paymentIds) ? [...prev.paymentIds] : [];
    if (!paymentIds.includes(paymentId)) paymentIds.push(paymentId);
    // Split sessions additionally record the tap as a POSITIVE tender entry —
    // capture derives its payment set from tenders, never by set-difference on
    // paymentIds (a canceled auth left in the union must not read as a tap).
    let tenders = prev.tenders;
    let pendingCheckoutId = prev.pendingCheckoutId;
    if (prev.split) {
      tenders = [...(prev.tenders ?? [])];
      if (!tenders.some((t) => t.paymentId === paymentId)) {
        tenders.push({
          index: tenders.length,
          kind: "terminal",
          paymentId,
          amountCents: 0, // unknown at stamp time — capture re-reads from Square
          status: "authorized",
        });
      }
      pendingCheckoutId = undefined; // the armed checkout produced its payment
    }
    await redis.set(
      terminalAnchorKey(seed),
      JSON.stringify({
        ...prev,
        paymentId,
        paymentIds,
        ...(prev.split ? { tenders, pendingCheckoutId } : {}),
        stampedAt: new Date().toISOString(),
      }),
      "EX",
      TERMINAL_ANCHOR_TTL_S,
    );
  } catch {
    /* non-fatal */
  }
}

/** One verified reader payment, as re-read from Square by the poll driver. */
export interface VerifiedTenderStamp {
  paymentId: string;
  /** effectiveCents — approved_money ?? amount_money, never a client claim. */
  amountCents: number;
  sourceType?: string;
  cardBrand?: string;
  last4?: string;
  /** The checkout this payment arrived on — clears pendingCheckout when it
   *  matches (an armed checkout that produced its payment is spent). */
  checkoutId?: string;
}

/**
 * Ambient rail's stamp (2026-08): record a VERIFIED terminal tender on the
 * anchor — unconditionally, unlike stampTerminalPaymentOnAnchor's split-only
 * tender push. Dedup by paymentId (a double-poll refreshes the verified
 * fields, never duplicates); assigns the monotonic tenderSeq slot; merges the
 * paymentIds union; clears pendingCheckout when this payment came from it.
 * Returns null when the anchor is gone (session dead / Redis down) — the
 * caller falls back to the legacy stamp-and-respond shape.
 */
export async function stampVerifiedTerminalTender(
  seed: string,
  t: VerifiedTenderStamp,
): Promise<TerminalAnchor | null> {
  return updateTerminalAnchor(seed, (a) => {
    const prior = a.tenders ?? [];
    const exists = prior.some((x) => x.paymentId === t.paymentId);
    const verified = {
      amountCents: t.amountCents,
      sourceType: t.sourceType,
      cardBrand: t.cardBrand,
      last4: t.last4,
    };
    const seq = a.tenderSeq ?? prior.length;
    const tenders = exists
      ? prior.map((x) => (x.paymentId === t.paymentId ? { ...x, ...verified } : x))
      : [
          ...prior,
          {
            index: seq,
            kind: "terminal" as const,
            paymentId: t.paymentId,
            status: "authorized" as const,
            ...verified,
          },
        ];
    const fromPending =
      t.checkoutId != null &&
      (a.pendingCheckout?.id === t.checkoutId || a.pendingCheckoutId === t.checkoutId);
    return {
      ...a,
      split: true as const, // legacy readers key off it; harmless and accurate
      tenders,
      tenderSeq: exists ? seq : seq + 1,
      paymentId: t.paymentId,
      paymentIds: [...new Set([...(a.paymentIds ?? []), t.paymentId])],
      stampedAt: new Date().toISOString(),
      ...(fromPending ? { pendingCheckout: undefined, pendingCheckoutId: undefined } : {}),
    };
  });
}

/**
 * Read-modify-write a terminal anchor for the split-tender routes (add/remove
 * a gift-card tender, bump the attempt salt, mark captured). Returns the
 * updated anchor, or null when no anchor exists / Redis is down — callers
 * treat null as "session not found" and fail closed BEFORE any money moves
 * (unlike the stamp above, which is a best-effort pointer AFTER capture).
 */
export async function updateTerminalAnchor(
  seed: string,
  mutate: (anchor: TerminalAnchor) => TerminalAnchor,
): Promise<TerminalAnchor | null> {
  try {
    const raw = await redis.get(terminalAnchorKey(seed));
    if (!raw) return null;
    const prev: TerminalAnchor =
      typeof raw === "string" ? (JSON.parse(raw) as TerminalAnchor) : (raw as TerminalAnchor);
    const next = mutate(prev);
    await redis.set(terminalAnchorKey(seed), JSON.stringify(next), "EX", TERMINAL_ANCHOR_TTL_S);
    return next;
  } catch {
    return null;
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

/**
 * Thrown when an adult heat and a junior heat in the SAME cart share one
 * (track, start) physical session (owner 2026-07-19 — adult and junior BMI
 * products sell into the same session, so BMI never blocks it). Raised BEFORE
 * any Square write, so nothing was charged.
 */
export class CrossCategoryHeatCollisionError extends Error {
  code = "CROSS_CATEGORY_HEAT_COLLISION";
  constructor(message: string) {
    super(message);
    this.name = "CrossCategoryHeatCollisionError";
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

  // Durable audit handle — the inner fan-out opens the row (it owns baseKey and
  // the charge amount); this wrapper closes it either way, so a throw anywhere
  // below leaves a queryable record instead of only a Vercel log line.
  const audit: ReserveAudit = { id: null, step: "pre-charge" };
  try {
    // The full path never sets prepareOnly, so the result is always a
    // UnifiedReserveResult (prepareUnifiedDeposit is the only prepareOnly caller).
    const result = (await unifiedReserveInner(
      input,
      seedSource,
      false,
      audit,
    )) as UnifiedReserveResult;
    await finishReserveAttempt(audit.id, {
      state: "completed",
      neonIds: result.neonIds,
      qamfReservationIds: result.qamfReservationIds,
      bmiReservationNumber: result.bmiReservationNumber,
    });
    return result;
  } catch (err) {
    // Pre-capture failure with native voucher claims held → hand the codes
    // back (txn-guarded), or an abandoned retry leaves them reading "used".
    if (audit.releaseNativeClaims) {
      await audit
        .releaseNativeClaims()
        .catch((relErr) =>
          console.error(
            "[voucher] release after failed reserve did not complete (sweep will):",
            relErr instanceof Error ? relErr.message : relErr,
          ),
        );
    }
    await finishReserveAttempt(audit.id, {
      state: "failed",
      failedStep: audit.step,
      // FULL text — a truncated vendor body is exactly what cost us the phone
      // rule on 2026-07-28.
      error: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err),
    });
    throw err;
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
  // Same give-back contract as unifiedReserve: a prepare that throws after the
  // native claim releases it. A prepare that SUCCEEDS keeps its claims armed on
  // purpose — the reader is about to charge, and the reserve-all resume
  // re-recognises them via the same baseKey (abandoned-at-reader claims are the
  // stale-claim sweep's job).
  const audit: ReserveAudit = { id: null, step: "pre-charge" };
  try {
    const result = (await unifiedReserveInner(
      input,
      seedSource,
      true,
      audit,
    )) as PrepareDepositResult;
    return result;
  } catch (err) {
    if (audit.releaseNativeClaims) {
      await audit
        .releaseNativeClaims()
        .catch((relErr) =>
          console.error(
            "[voucher] release after failed prepare did not complete (sweep will):",
            relErr instanceof Error ? relErr.message : relErr,
          ),
        );
    }
    throw err;
  } finally {
    if (lockKey && lockHeld) {
      await redis.del(lockKey).catch(() => {});
    }
  }
}

/**
 * Mutable handle so the public wrapper can close out the durable audit row that
 * the inner fan-out opened (the row id and the step it reached are only knowable
 * in here, the terminal state only out there).
 */
interface ReserveAudit {
  id: number | null;
  /** Last milestone entered — becomes reserve_attempts.failed_step on a throw. */
  step: string;
  /**
   * Armed while native cart-voucher claims are HELD but money is NOT captured;
   * the wrappers fire it on a throw so a failed checkout hands the guest's
   * codes back. Cleared the moment capture succeeds — from there the claims are
   * spent and forward recovery owns the booking, never a release.
   */
  releaseNativeClaims?: (() => Promise<void>) | null;
}

async function unifiedReserveInner(
  input: UnifiedReserveInput,
  seedSource: string | null,
  prepareOnly = false,
  audit: ReserveAudit = { id: null, step: "pre-charge" },
): Promise<UnifiedReserveResult | PrepareDepositResult> {
  // ── 0a. Server-authoritative promo ─────────────────────────────────
  // `session.appliedPromo` is a CLIENT snapshot — its amounts/scopes/windows
  // are display hints, never charge inputs (the bowling reserve route has
  // enforced this since USA250; this path predated the rule). Re-resolve the
  // code from Neon so every price derivation below runs on the store of
  // record; a code that no longer resolves prices as no-promo. Fail-closed:
  // a promo never survives on the client snapshot alone. Kiosk sessions make
  // this non-negotiable — the device is an unattended public surface.
  if (input.session.appliedPromo) {
    const claimed = input.session.appliedPromo;
    const fresh = await resolveAppliedPromo(claimed.code).catch(() => null);
    if (!fresh) {
      // The code stopped resolving between session start and charge (expired at
      // midnight, hit max_uses, admin deactivated). We price WITHOUT it — the
      // established behavior of the bowling reserve route — which means the
      // guest can be charged more than the screen last showed. Rare, but it IS
      // a displayed-vs-charged divergence, so make it loud and greppable
      // instead of a quiet warn: ops can find + remediate the exact bill.
      console.error(
        `[unified-reserve] PROMO DROPPED AT CHARGE: ${claimed.code} no longer resolves ` +
          `(bill ${input.session.bmiBillId ?? "n/a"}, order ${input.session.squareOrderId ?? "n/a"}) ` +
          `— charging without the discount the guest may have seen`,
      );
    }
    input = { ...input, session: { ...input.session, appliedPromo: fresh } };
  }
  // ── 0b. Server-authoritative VOUCHER verification ────────────────────
  // A voucher only reduces the charge when OUR ledger (written server-side by
  // /api/booking/v2/voucher at apply time) backs the session's claim for THIS
  // bill. Pending / errored vouchers never priced anything → drop silently.
  // A claimed-applied voucher the ledger can't verify HARD-FAILS the reserve
  // (displayed==charged: never silently charge more than the guest saw).
  if ((input.session.appliedVouchers?.length ?? 0) > 0) {
    const billId = input.session.bmiBillId;
    // Pending/errored/other-bill vouchers priced nothing — drop them from the
    // charge session. Every APPLIED one must be backed by a ledger row WE
    // wrote for THIS bill, else the reserve hard-fails.
    const kept = sessionVouchers(input.session).filter(
      (v) =>
        voucherIsApplied(v) &&
        // Native vouchers carry no BMI bill — they're verified by the
        // charge-time claim below, not the BMI ledger. BMI vouchers still must
        // match the bill WE wrote a ledger row for.
        (v.issuer === "native" || (!!billId && v.billId === billId)),
    );
    const bmiKept = kept.filter((v) => v.issuer !== "native");
    if (bmiKept.length > 0) {
      const rows = await getAppliedVouchersForBill(billId!).catch(() => []);
      for (const v of bmiKept) {
        const row = rows.find(
          (r) => r.code === v.code && r.voucherOrderItemId === v.voucherOrderItemId,
        );
        if (!row) throw new VoucherNotVerifiedError(v.code);
      }
    }
    input = { ...input, session: { ...input.session, appliedVouchers: kept } };
  }
  // DIAGNOSTIC (owner smoke 2026-07-31, kept cheap + PII-free): what voucher
  // legs did this request actually carry, and what does the plan allocate?
  // The pricing builder is proven correct in unit repro with the expected
  // session shape — this log pins down what the wire delivers instead.
  {
    const posted = input.session.appliedVouchers ?? [];
    const applied = sessionVouchers(input.session).filter(voucherIsApplied);
    const plan = activeComboSpecial(input.session)
      ? null
      : planVoucherCoverage(input.session, redeemedHeatSet(input.session));
    const alloc = (plan?.picks ?? []).filter((p) => p.raceHeat || p.attractionItemId).length;
    if (posted.length > 0 || applied.length > 0) {
      console.log(
        `[unified-reserve] vouchers: posted=${posted.length} applied=${applied.length} allocated=${alloc} ` +
          posted
            .map(
              (v) =>
                `{i:${(v as { itemIndex?: number }).itemIndex ?? "-"},iss:${(v as { issuer?: string }).issuer ?? "-"},p:${(v as { pending?: boolean }).pending ? 1 : 0},e:${(v as { error?: string }).error ? 1 : 0},n:"${String((v as { name?: string }).name ?? "").slice(0, 30)}"}`,
            )
            .join(" "),
      );
    }
  }
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

  // ── Native voucher claim — charge-time, single use ───────────────────
  // Race/attraction items on OUR (HPW) vouchers reduce THIS charge:
  // planVoucherCoverage has already excluded the heat / dropped the attraction
  // qty from pricing above. Claim them atomically HERE — after pricing, before
  // any money moves — so:
  //   • a code already spent by another checkout HARD-FAILS before the charge
  //     (never a silent full charge — displayed==charged),
  //   • retries of THIS reserve reuse their own claim (idempotent on baseKey),
  //   • an abandoned checkout leaves the claim recoverable, never a double spend.
  // Game-zone items never reach here — voucherTarget()==="gamecard" prices
  // nothing and they're fulfilled on the dispense rail instead.
  //
  // Claim ONLY the legs the coverage plan ALLOCATES against this cart. A leg
  // that matches nothing (the VIP voucher's Shuffly hour on a gel-blaster
  // cart) must stay unclaimed and available — claiming every applied leg
  // SPENT that Shuffly hour on a no-shuffly booking, then conflict-failed
  // every later cart carrying the code (owner repro 2026-07-31). picks[] is
  // positional over the applied-voucher list, so allocation maps by index.
  // Attraction allocation is base-independent; race legs use the credits-
  // first base, mirroring pricing.
  const appliedForClaims = sessionVouchers(session).filter(voucherIsApplied);
  const claimPlan = activeComboSpecial(session)
    ? null
    : planVoucherCoverage(session, redeemedHeatSet(session));
  const allocatedIdx = new Set(
    (claimPlan?.picks ?? [])
      .map((p, i) => (p.raceHeat || p.attractionItemId ? i : -1))
      .filter((i) => i >= 0),
  );
  const nativeVoucherRefs: NativeCartVoucherRef[] = appliedForClaims
    .map((v, i) => ({ v, i }))
    .filter(
      ({ v, i }) => allocatedIdx.has(i) && v.issuer === "native" && typeof v.itemIndex === "number",
    )
    .map(({ v }) => ({ code: v.code, itemIndex: v.itemIndex as number, name: v.name }));
  // Fall-over substitutes: a stale session can name a leg another checkout
  // has since SPENT while an identical leg of the same code sits unallocated
  // (leg 1 vs leg 3 "Laser Tag or Gel Blaster" — owner repro 2026-08-01: the
  // 00:25 booking W56657 spent leg 1, the 00:29 cart still named it and
  // hard-failed with a twin available). Same code + same coverage NAME means
  // the priced coverage is identical, so the claim may spend the twin instead.
  const claimSubstitutes = new Map<string, NativeCartVoucherRef[]>();
  for (const ref of nativeVoucherRefs) {
    const subs = appliedForClaims
      .map((v, i) => ({ v, i }))
      .filter(
        ({ v, i }) =>
          !allocatedIdx.has(i) &&
          v.issuer === "native" &&
          typeof v.itemIndex === "number" &&
          v.code === ref.code &&
          v.itemIndex !== ref.itemIndex &&
          (v.name ?? "") === (ref.name ?? ""),
      )
      .map(({ v }) => ({ code: v.code, itemIndex: v.itemIndex as number, name: v.name }));
    if (subs.length > 0) claimSubstitutes.set(`${ref.code}:${ref.itemIndex}`, subs);
  }
  let nativeClaimed: NativeCartVoucherRef[] = [];
  if (nativeVoucherRefs.length > 0) {
    const claimRes = await claimNativeCartVouchers({
      vouchers: nativeVoucherRefs,
      baseKey,
      locationCode: 0, // audit-only for cart vouchers (no Intercard leg)
      substitutes: claimSubstitutes,
    });
    if (!claimRes.ok) throw new VoucherNotVerifiedError(claimRes.conflictCode);
    nativeClaimed = claimRes.claimed;
    // Arm the give-back: any throw between here and capture releases these
    // claims (guarded on this reserve's own txn ids), so a declined card or a
    // failed guard never leaves the guest's voucher reading "used". The
    // wrappers fire it; capture disarms it.
    audit.releaseNativeClaims = () =>
      releaseNativeCartVouchers({ vouchers: nativeClaimed, baseKey });
  }

  // ── Bookability guard: drop legs QAMF could never accept ───────────
  // A bowling/KBF leg needs a lane hold OR a picked slot (bookedAt + webOfferId).
  // A leg with neither is a draft the guest abandoned — priced at $0 (pricing
  // hangs off the offer, so nothing was charged for it) and invisible in the cart
  // total, yet the pre-guard code still called createReservation with
  // `webOfferId: 0` and a `new Date()` BookedAt. QAMF 400'd and took a PAID race
  // booking down with it (2026-07-28, $234.21 captured, FastTrax kiosk). Dropping
  // is the money-safe direction: never fail a captured booking over a leg that
  // has no time, no offer, no hold, and no money against it. Every drop is logged
  // and lands in reserve_attempts.dropped_legs.
  const { bowlable: bowlingItems, droppedLegLines } = (() => {
    const { bookable, dropped } = partitionBookableLegs(session.items.filter(isBowlingLike));
    const lines = dropped.map(({ item, reason }) => describeDroppedLeg(item, reason));
    for (const line of lines) {
      console.error(`[unified-reserve] DROPPED unbookable leg — ${line}`);
    }
    return { bowlable: bookable, droppedLegLines: lines };
  })();
  const raceItems = session.items.filter((i): i is RaceItem => i.kind === "race");
  const attractionItems = session.items.filter((i): i is AttractionItem => i.kind === "attraction");
  const racesimItems = session.items.filter((i): i is RaceSimItem => i.kind === "racesim");
  const hasBmi = raceItems.length > 0 || attractionItems.length > 0 || racesimItems.length > 0;

  // ── Durable audit row (our own log, not Vercel's) ─────────────────
  // Opened BEFORE any money moves so a failure anywhere below is queryable by
  // bill id afterwards. Never throws — see lib/reserve-attempt-log.ts.
  const cartSnapshot: ReserveCartSnapshot = {
    items: session.items.map((i) => ({
      kind: i.kind,
      id: i.id,
      date: i.date,
      ...(isBowlingLike(i)
        ? {
            bookedAt: i.bookedAt,
            webOfferId: i.webOfferId,
            qamfReservationId: i.qamfReservationId,
            qamfCenterId: i.qamfCenterId,
            isDuckpin: i.kind === "bowling" ? i.isDuckpin : undefined,
          }
        : {}),
      ...(i.kind === "race" ? { heatCount: i.heats.length } : {}),
      ...(i.kind === "attraction" ? { slug: i.slug } : {}),
      ...(i.kind === "racesim" ? { slug: i.productSlug, trackKey: i.trackKey, slot: i.slot } : {}),
    })),
    comboSpecialId: session.comboSpecialId ?? null,
  };

  // ── 0. Guard: never charge against an auto-cancelled BMI bill ──────
  // BMI auto-cancels a Pending-Online hold after the center's timeout, stripping
  // the bill's products. If that happened during the customer's dwell, charging
  // here would take money for a reservation that no longer exists (BMI then
  // returns BillNotFound at payment/confirm — AFTER the card is captured, the
  // "charged but empty" failure). Re-check the bill is live BEFORE any Square
  // write. Fail-open on a transient overview error: a BMI hiccup must never block
  // a legitimate paying customer, and the auto-cancel case returns a clean empty
  // overview (caught), not an error.
  // BMI's own outstanding MONEY deposit on the bill (totalToDeposit), captured
  // from the same overview the liveness guard fetches. The confirm step pays
  // exactly this on a MIXED bill (zero-model races + real-priced attraction) —
  // see the confirm block. null = overview unavailable (confirm falls back to
  // the locally computed attraction total).
  let bmiMoneyDueCents: number | null = null;
  if (hasBmi && session.bmiBillId) {
    let live = true;
    try {
      const billStatus = await getBmiBillStatus(resolveBmiClientKey(session), session.bmiBillId);
      live = billStatus.live;
      bmiMoneyDueCents = billStatus.moneyDueCents;
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

  // ── 0c. Guard: cross-category same-slot (adults vs juniors) ─────────
  // An adult heat and a junior heat in this cart must not share one (track,
  // start) physical session (owner 2026-07-19). Pure cart data — NOT
  // fail-open (there is no external query to fail): the grids grey these
  // slots and the hold path asserts, but this is the last gate before money
  // moves. raceHeatsMetadata already carries heatId/track/category.
  if (raceItems.length > 0) {
    const collision = findCrossCategorySameStart(
      raceItems.flatMap((r) =>
        raceHeatsMetadata(r.heats, session.party).map((h) => ({
          heatId: (h.heatId as string | null) ?? null,
          track: (h.track as string | null) ?? null,
          category: (h.category as "adult" | "junior" | null) ?? null,
        })),
      ),
    );
    if (collision) {
      console.error(
        `[unifiedReserve] CROSS_CATEGORY_HEAT_COLLISION — ${collision.track ?? "?"} ${collision.start}`,
      );
      throw new CrossCategoryHeatCollisionError(
        crossCategoryCollisionMessage(collision.start, collision.track),
      );
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

  // ── 2a-addons. Persist retail add-on grant obligations BEFORE any money
  // moves (persist-first, race-pack parity — throws if the DB is down). The
  // intents come from the SAME resolution walk as the charge lines, so the
  // ledger and the Square order can't disagree. Idempotent on baseKey.
  const addonIntents = addonPurchaseIntents(session);
  if (addonIntents.length > 0) {
    await upsertAddonPurchases({
      purchaseKey: baseKey,
      surface: session.context?.kiosk ? "booking-kiosk" : "booking-web",
      intents: addonIntents,
    });
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

  // ── 2d. Validate Midnight Madness window (fail-closed) ────────────
  // MM shares the all-day Fri-Sun Time offer, so the offer id can't scope its
  // late-night window and the client slot gates are display-only (2026-08-01
  // incident: MM booked hours before its window). Throws → 409 in reserve-all
  // BEFORE any Square or QAMF write — nothing is charged.
  for (const item of bowlingItems) {
    if (isMidnightMadnessSlug(item.experienceSlug)) {
      // null bookedAt is unparseable → rejects (fail-closed; guards money).
      const mmWindowError = midnightMadnessWindowError(item.bookedAt ?? "");
      if (mmWindowError) throw new MidnightMadnessWindowError(mmWindowError);
    }
  }

  // ── 2e. Race Sims: fail-closed until fully armed ───────────────────
  // A sim item may charge only when its product is bookable AND the shared
  // Square id AND its track's $0 BMI key + page are ALL set
  // (raceSimItemConfigured — race-sims/products.ts is the single seam; a
  // Square id alone would charge with no reservation). Throws → 409 in the
  // reserve routes BEFORE any Square write, on BOTH rails (unifiedReserve
  // card charge AND prepareUnifiedDeposit terminal prepare).
  //
  // MIXED-ENTITY refusal: the day-of order books at ONE Square location, and
  // a cart mixing FastTrax sims with HeadPinz items (bowling/KBF/gel/laser/
  // shuffly) would land the sim revenue in the HeadPinz account. Refuse
  // (409 RACESIM_MIXED_CART, staff-readable) until the combo-split-orders
  // treatment covers sims. Races + duckpin are FastTrax — those mix fine.
  if (racesimItems.length > 0) {
    for (const item of racesimItems) {
      if (!raceSimItemConfigured(item)) {
        throw new RaceSimNotConfiguredError(item.productSlug);
      }
    }
    const hasHeadpinzItem = session.items.some(
      (i) =>
        (isBowlingLike(i) && !(i.kind === "bowling" && (i as BowlingItem).isDuckpin)) ||
        (i.kind === "attraction" &&
          !FASTTRAX_ATTRACTION_SLUGS.has((i as AttractionItem).slug ?? "")),
    );
    if (hasHeadpinzItem) {
      throw new RaceSimMixedCartError();
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
  /** KIOSK: POV codes claimed for this bill (Ultimate Qualifier / Rookie Pack /
   *  individual Viewpoints) — shown on the confirmation screen and threaded
   *  into the post-reserve rail for the guest email + reservation memo. */
  let povCodesResult: string[] | undefined;

  const useTerminal = !!input.externalPayment;

  // Open the durable audit row BEFORE the charge (prepare runs its own pass and
  // doesn't need one — its failures cost nothing). Soft-fails to a null id.
  if (!prepareOnly) {
    audit.id = await startReserveAttempt({
      baseKey,
      billId: session.bmiBillId ?? null,
      surface: session.context?.kiosk ? "kiosk" : "web",
      center: session.center ?? null,
      locationId,
      paymentSource: useTerminal
        ? "terminal"
        : input.externalPayment
          ? "external"
          : depositCents === 0
            ? "credit"
            : (input.sourceKind ?? "card"),
      chargeCents: depositCents,
      cart: cartSnapshot,
      droppedLegs: droppedLegLines.length > 0 ? droppedLegLines : undefined,
    });
  }

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
  // Checkout-upsell cards are capped at ONE per person on the transaction
  // (owner 2026-07-21) — fail closed like every other pricing guard here.
  if (gzPurchase) {
    const upsellCards = gzPurchase.cards.filter((c) => c.pkg.upsell).length;
    if (upsellCards > Math.max(1, session.party.length)) {
      throw new Error("Discounted Game Zone cards are limited to one per player.");
    }
  }
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
  // Swipe kiosk (no dispenser, 2026-08-28): new-card rows arrive with the
  // account the guest swiped in the Game Zone cart. Confirm each is still a
  // BLANK server-side on the PREPARE pass — before any row is persisted and
  // before the reader is armed (the browser's blank check is a claim, not
  // proof). Never on finalize: money is already captured there, and a
  // refusal would strand it. Dispenser carts carry no accounts and skip this.
  if (prepareOnly && gzPurchase?.mode === "new_card" && gzLocationCode != null) {
    const swiped = gzPurchase.cards.map((c) => c.accountNumber).filter((a) => a.length > 0);
    if (swiped.length > 0) await assertSwipedBlanks(swiped, gzLocationCode);
  }

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
      // ── Resume guard ─────────────────────────────────────────────────
      // If a PRIOR prepare already created this session's deposit order and the
      // reader has since CAPTURED it (COMPLETED) — but reserve never ran because
      // the client dropped between the tap and reserve, then re-entered checkout
      // — do NOT create a new order or re-arm the reader. Recover the captured
      // paymentId from Square (source of truth even when the poll never stamped
      // the anchor) and hand it back so the client resumes the booking via the
      // idempotent reserve-all path, instead of hitting the "order must be OPEN"
      // dead-end. Best-effort: any lookup error falls through to a normal prepare.
      const priorAnchor = await readTerminalAnchor(seedSource ?? baseKey).catch(() => null);
      if (priorAnchor?.depositOrderId) {
        const info = await getOrderPaymentInfo(priorAnchor.depositOrderId).catch(() => null);
        // A split-captured order carries SEVERAL payments (gift card + tap) —
        // resume must hand back the FULL set or the reserve-all finalize sum
        // check can never pass (review 2026-07-29). Square's tender list is
        // authoritative; the anchor's union is the fallback when the read
        // failed. The primary id prefers the LAST payment (the tap).
        const resumePaymentIds =
          info?.paymentIds && info.paymentIds.length > 0
            ? info.paymentIds
            : (priorAnchor.paymentIds ?? (priorAnchor.paymentId ? [priorAnchor.paymentId] : []));
        const resumePaymentId =
          resumePaymentIds[resumePaymentIds.length - 1] ?? priorAnchor.paymentId ?? null;
        if (info?.state === "COMPLETED" && resumePaymentId) {
          console.log(
            `[kiosk-terminal] PREPARE resume — order ${priorAnchor.depositOrderId} already COMPLETED, payments=${resumePaymentIds.join(",")} seed=${seedSource ?? baseKey} (skipping reader)`,
          );
          return {
            __prepare: true,
            alreadyPaid: true,
            seed: seedSource ?? baseKey,
            depositOrderId: priorAnchor.depositOrderId,
            // The reader charged booking deposit + card lines; mirror the normal
            // prepare's total so the client's display/amount stays consistent.
            depositCents: priorAnchor.depositCents + (priorAnchor.gameCards?.totalCents ?? 0),
            paymentId: resumePaymentId,
            ...(resumePaymentIds.length > 1 ? { paymentIds: resumePaymentIds } : {}),
            locationId: priorAnchor.locationId,
          };
        }
      }
      {
        const expected = input.expectedCents;
        const drift = typeof expected === "number" ? depositCents - expected : null;
        console.log(
          `[kiosk-terminal] PREPARE dayofTotalCents=${dayofTotalCents} depositPct=${depositPct} → depositCents=${depositCents} gzCents=${gzCents} loc=${locationId} seed=${seedSource ?? baseKey}` +
            (drift != null ? ` shown=${expected} drift=${drift}` : ""),
        );
        // Per-line breakdown whenever the shown total disagrees beyond tax
        // rounding — the exact data every drift incident has been missing
        // (owner 2026-07-31: "need full logging of all this").
        if (drift != null && Math.abs(drift) > 100) {
          console.warn(
            `[kiosk-terminal] PREPARE DRIFT ${drift}¢ — lines: ` +
              sqLineItems
                .map(
                  (l) =>
                    `[${l.name}|q${l.quantity}|${l.basePriceMoney ? l.basePriceMoney.amount + "¢" : "catalog"}]`,
                )
                .join(" ") +
              ` packs=${kioskPacks.length} packCoveredHeats=${packCoverage.heats.size}`,
          );
        }
      }
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
      // Split-tender session secret: the seed (bill id) is sequential and
      // client-visible, so it can NOT authorize the split routes by itself.
      // Minted here (prepare is the session's trust root), stored on the
      // anchor, returned ONLY to this prepare's caller. Token handed out only
      // when the anchor durably landed — a token without an anchor lights the
      // gift-card UI and then answers "no-session" to every use of it.
      const written = await upsertTerminalAnchor(seedSource ?? baseKey, {
        depositOrderId,
        depositCents,
        locationId,
        baseKey,
        splitToken: randomUUID(),
        // The reader charges the ORDER TOTAL: booking deposit + card lines.
        totalCents: depositCents + gzCents,
        source: "unified",
        ...(anchorGameCards ? { gameCards: anchorGameCards } : {}),
      });
      const splitToken = written?.splitToken;
      return {
        __prepare: true,
        seed: seedSource ?? baseKey,
        depositOrderId,
        // The reader charges the ORDER TOTAL: booking deposit + card lines.
        depositCents: depositCents + gzCents,
        locationId,
        ...(splitToken ? { splitToken, ambient: kioskAmbientCheckoutEnabled() } : {}),
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
          // Split checkout (kiosk v1): verify + activate with EVERY captured
          // payment on the order (gift card + tap), not just the primary.
          externalPaymentIds: ep.paymentIds,
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

  // Money (if any) is captured — stamp the ids on the audit row IMMEDIATELY, so
  // a crash on any line below still leaves the payment queryable by bill id.
  audit.step = "post-capture";
  // Point of no return for native voucher claims: the charge they reduced has
  // captured, so they are spent — a throw below must NOT hand them back.
  audit.releaseNativeClaims = null;
  await recordReserveCapture(audit.id, {
    depositOrderId: depositResult.depositOrderId,
    depositPaymentId: depositResult.depositPaymentId,
  });

  // Race packs: the deposit (which includes the full pack price) is captured —
  // stamp the ledger rows charged with the order/payment ids (audit + recovery).
  if (kioskPacks.length > 0) {
    await markPackCharged(baseKey, {
      squareOrderId: squareDayofOrderId,
      squarePaymentId: depositResult.depositPaymentId,
    }).catch((err) => console.error("[race-pack] markPackCharged failed (non-fatal):", err));
  }

  // Voucher ledger → charged (audit; BMI consumes codes at its own
  // processing — this is OUR trail, soft-fail like every post-capture stamp).
  if (session.bmiBillId) {
    for (const v of sessionVouchers(session).filter(voucherIsApplied)) {
      if (v.issuer === "native") continue; // native stamped below (no BMI ledger)
      await markVoucherCharged(session.bmiBillId, v.code).catch((err) =>
        console.error("[voucher] markVoucherCharged failed (non-fatal):", err),
      );
    }
  }
  // Native cart vouchers → terminal 'spent' + redemption event (soft-fail; the
  // stale-claim sweep uses both as capture evidence).
  if (nativeClaimed.length > 0) {
    await markNativeCartVouchersCharged({ vouchers: nativeClaimed, baseKey }).catch((err) =>
      console.error("[voucher] markNativeCartVouchersCharged failed (non-fatal):", err),
    );

    // Stamp the redeemed code(s) onto the booking record so the confirmation can
    // show the voucher and what is LEFT on it.
    //
    // Until now only the combo MINT stamped a code (`vipVoucherCode`, below), so a
    // guest who booked by spending a prepaid deal pack got a confirmation that
    // never mentioned the voucher they had just partly used — no reminder that two
    // game cards are still on it. The confirmation's voucher tile already renders
    // live per-item Available/Used state; it just had nothing to key on.
    //
    // Distinct codes in scan order. Best-effort merge, same pattern and the same
    // 90-day TTL as the combo stamp — a Redis hiccup must never fail a captured
    // booking.
    const redeemedCodes = Array.from(new Set(nativeClaimed.map((v) => v.code)));
    if (session.bmiBillId && redeemedCodes.length > 0) {
      try {
        const key = `bookingrecord:${session.bmiBillId}`;
        const existing = await redis.get(key);
        if (existing) {
          const rec = typeof existing === "string" ? JSON.parse(existing) : existing;
          await redis.set(
            key,
            JSON.stringify({ ...rec, redeemedVoucherCodes: redeemedCodes }),
            "EX",
            60 * 60 * 24 * 90,
          );
        }
      } catch (err) {
        console.error("[voucher] redeemed-code stamp failed (non-fatal):", err);
      }
    }
  }

  // ── V2 combo voucher grant: mint ONE code per booking ─────────────
  // Idempotent on the BILL (vouchers.bill_id unique), so reserve retries and
  // the recovery sweep converge on one code. Soft-fail — a mint hiccup must
  // never fail a captured booking; the combo-voucher-reconcile cron recovers
  // and emails the guest the code as a make-good.
  let comboVoucherResult: { code: string; items: VoucherItem[]; expiresAt: string | null } | null =
    null;
  {
    const activeForVoucher = activeComboSpecial(session);
    if (
      activeForVoucher?.combo.voucherGrant &&
      session.bmiBillId &&
      activeForVoucher.raceItem.date
    ) {
      try {
        comboVoucherResult = await mintComboVoucherIfNeeded({
          combo: activeForVoucher.combo,
          billId: session.bmiBillId,
          racerCount: activeForVoucher.racerIds.length,
          visitDateYmd: activeForVoucher.raceItem.date,
          contact: {
            email: contact.email ?? undefined,
            name: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || undefined,
          },
        });
        // Stamp the code onto the Redis booking record (merge, same pattern as
        // the lane stamp) so the confirmation page + email route can read it
        // without a new API surface. Best-effort.
        if (comboVoucherResult) {
          try {
            const key = `bookingrecord:${session.bmiBillId}`;
            const existing = await redis.get(key);
            if (existing) {
              const rec = typeof existing === "string" ? JSON.parse(existing) : existing;
              await redis.set(
                key,
                JSON.stringify({ ...rec, vipVoucherCode: comboVoucherResult.code }),
                "EX",
                60 * 60 * 24 * 90,
              );
            }
          } catch (err) {
            console.error("[combo-voucher] booking-record stamp failed (non-fatal):", err);
          }
        }
      } catch (err) {
        console.error("[combo-voucher] mint failed (cron will recover):", err);
      }
    }
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
    `[unified-reserve] bowlingItems=${bowlingItems.length} raceItems=${raceItems.length} ` +
      `attractionItems=${attractionItems.length} droppedLegs=${droppedLegLines.length}`,
  );
  if (bowlingItems.length > 0) audit.step = "qamf-confirm";

  // Per-row coupon attribution for the admin board: bowling rows record their
  // own lines' savings; the race/attraction anchor row records the remainder
  // of the cart-wide total (races, attractions, combo lines).
  let bowlingPromoSavingsCents = 0;

  // Kiosk rosters carry shoe sizes UP FRONT; accumulate them across bowling
  // items (a combo shares ONE bowling day-of order) so we sync the $0 shoe-KDS
  // line items ONCE after the loop, never clobbering earlier items.
  const shoeKdsPlayers: ShoeKdsPlayer[] = [];

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
            // Typed kiosk names are case-normalized once more here — the last
            // stop before QAMF lane monitors + Neon see the roster.
            name: formatPersonName(p.name) || `Bowler ${i + 1}`,
            shoeSize: p.shoeSize || null, // "" = own shoes
            bumpers: p.bumpers ?? null,
          }))
        : Array.from({ length: playerCount }, (_, i) => ({
            name: `Bowler ${i + 1}`,
            shoeSize: null as string | null,
            bumpers: null as boolean | null,
          }));

    // Only real (kiosk) rosters carry shoe sizes; placeholder rosters are all
    // null and contribute nothing (the helper filters sizeless players).
    if (rosterPlayers && rosterPlayers.length > 0) {
      shoeKdsPlayers.push(...players.map((p) => ({ name: p.name, shoeSize: p.shoeSize })));
    }

    const guest = {
      name: `${contact.firstName} ${contact.lastName}`.trim(),
      phone: contact.phone ?? "",
      email: contact.email ?? "",
    };
    // QAMF rejects BookedAt with a non-zero millisecond (and reads the instant as
    // CENTER-LOCAL wall clock, so a UTC `toISOString()` also lands hours off).
    // nowRounded5EtIso floors to a :05 multiple with the true ET offset — the
    // shape the Bowl Now path has always sent. The bookability guard above means
    // this fallback now only serves hold-first legs (whose hold carries the real
    // time), never an unconfigured draft.
    const bookedAt = item.bookedAt || nowRounded5EtIso();
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

    /**
     * The fresh-create fallback, used when there is no hold or the hold's confirm failed.
     *
     * BOTH fallback paths go through here so the availability guard cannot be added to one
     * and forgotten on the other — they were byte-identical creates sitting in different
     * branches, which is exactly how one of them ends up a year behind the other.
     *
     * For a booking starting now, candidates come only from lanes nobody is physically on;
     * QAMF fills from the lowest lane number up off the schedule alone and would otherwise
     * hand over a lane the previous group is still using. With no opinion — guard off, no
     * free lanes, floor read failed — this is the create it replaced, unchanged.
     */
    async function createFreshReservation() {
      const candidates =
        immediateLaneGuardEnabled() && isImmediateStart(Date.parse(bookedAt), Date.now())
          ? await freeLaneCandidates({ centerId, players: players.length })
          : [];
      const outcome = await createWithLanePlan({
        candidates,
        create: (lanes) =>
          createReservation(centerId, {
            BookedAt: bookedAt,
            Title: `${guest.name} (${players.length}p)`,
            Customer: {
              Guest: { Name: guest.name, PhoneNumber: guest.phone, Email: guest.email },
            },
            WebOffer: { Id: webOfferId, Options: qamfOptions, Services: [service] },
            TotalPlayers: players.length,
            ...(lanes ? { Lanes: lanes.map((LaneNumber) => ({ LaneNumber })) } : {}),
          }),
      });
      if (candidates.length) {
        log(`[unified-reserve] ${outcome.reservation.Id} ${describePinOutcome(outcome)}`);
      }
      return outcome.reservation;
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
          const reservation = await createFreshReservation();
          qamfReservationId = reservation.Id;
          qamfLanes = reservation.Lanes ?? [];
          log(`[unified-reserve] Fresh reservation: ${qamfReservationId}`);
          qamfConfirmed = await attachAndConfirm(qamfReservationId).catch(() => false);
        }
      } else {
        log(`[unified-reserve] No hold — creating fresh`);
        const reservation = await createFreshReservation();
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

      // Shoe status — staff see it at a glance. FastTrax duckpin has no shoes:
      // omit the status line and brand the short link to fasttraxent.com.
      if (centerId === FASTTRAX_QAMF_CENTER_ID) {
        if (shortCode) finalParts.push(`fasttraxent.com/s/${shortCode}`);
      } else {
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
      }

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

  // ── Sync shoe-size KDS items onto the bowling day-of order ─────────
  // Kiosk collects shoe sizes UP FRONT, so — unlike the web flow (which syncs
  // them post-booking via the confirmation-page players PATCH) — they must be
  // pushed onto the day-of Square order here, or the shoe-desk/KDS view of that
  // order is blank for kiosk bookings. Web placeholder rosters reach here with
  // no sizes, so this is a no-op for them. Best-effort — the deposit is already
  // captured and shoe-KDS items never gate the booking.
  if (shoeKdsPlayers.length > 0 && bowlingDayofOrderId) {
    await syncShoeKdsLineItems({
      orderId: bowlingDayofOrderId,
      players: shoeKdsPlayers,
      idempotencyKey: `shoe-kds-${baseKey}-${Date.now()}`,
      logLabel: "unified-reserve",
    });
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
    // MIXED bill (zero-model races + BMI-priced attraction lines on ONE bill):
    // the races deposit in credits, but the attraction lines owe real MONEY on
    // the BMI side — BMI flipped the Nexus gel/laser products to require a money
    // deposit (~2026-07-22), and a bill left with `totalToDeposit > 0` gets its
    // line SCHEDULES released by BMI shortly after (the guest silently drops off
    // the arena dayplanner; staff re-add by hand — W57040/W56953, 2026-08-01).
    // Pay BMI's own outstanding amount (captured by the liveness guard). When
    // the overview didn't yield it, fall back to the attraction lines' full
    // price + FL tax — the exact figure BMI bills for them. Overpaying BMI's
    // ledger is impossible on the primary path (we pay its own number) and the
    // guest's real money lives on Square either way.
    const attractionBmiCents = attractionItems.reduce(
      (s, a) => (a.productId ? s + Math.round(a.price * 100) * a.qty : s),
      0,
    );
    const mixedMoneyDueCents =
      useZeroModel && attractionBmiCents > 0
        ? (bmiMoneyDueCents ??
          attractionBmiCents + Math.round(calculateTax(attractionBmiCents / 100) * 100))
        : 0;
    const centerCode = session.center ?? "fort-myers";
    // Race-sim-only bookings anchor as "attraction" (attraction-shaped on the
    // BMI side: one slot line on a resource); bookingMetadata.racesims below
    // carries the sim detail. A first-class "racesim" ReservationProductKind
    // is guest-launch scope (it ripples into check-in/cancellation/edit).
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
      ...racesimItems.map((r) => {
        const product = getRaceSimProduct(r.productSlug);
        const track = getRaceSimTrack(r.trackKey);
        return {
          label: `Race Sims — ${product?.name ?? "Race"}${track ? ` · ${track.name}` : ""}`,
          quantity: Math.max(1, r.racerCount),
          unitPriceCents: product ? Math.round(raceSimPriceFor(product, r.date) * 100) : 0,
        };
      }),
    ];

    const bookingMetadata: Record<string, unknown> = {};
    if (raceItems.length > 0) {
      bookingMetadata.heats = raceHeatsMetadata(raceItems[0].heats, session.party);
      bookingMetadata.racerNames = racerNamesFromHeats(raceItems[0].heats, session.party);
    }
    // Retail add-ons (headsock etc.) — persist-at-capture alongside the
    // ledger rows, so the reservation record itself shows what was sold even
    // if the addon_purchases table is ever unavailable to a reader.
    if (addonIntents.length > 0) {
      bookingMetadata.addons = addonIntents.map((it) => ({
        slug: it.addonSlug,
        memberId: it.memberId,
        racer: it.memberName,
        bmiPersonId: it.personId,
        priceCents: it.priceCents,
        depositKindId: it.depositKindId,
      }));
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
    // Race sims — same persist-at-capture treatment as attractions: slot
    // start (for day-of tooling), track, racer count, and the who's-riding
    // roster, all on the reservation record itself.
    if (racesimItems.length > 0) {
      bookingMetadata.racesims = racesimItems
        .filter((r) => r.slot)
        .map((r) => ({
          slug: r.productSlug,
          trackKey: r.trackKey,
          track: getRaceSimTrack(r.trackKey)?.name ?? null,
          slot: r.slot,
          racerCount: Math.max(1, r.racerCount),
          ...(r.participants && r.participants.length > 0
            ? {
                participants: r.participants
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

    audit.step = "bmi-confirm";
    try {
      // Race-only $0-model → $0 credit (unchanged). Attraction-only → the full
      // Square order total as money (unchanged). MIXED → the attraction lines'
      // money due, as money — never $0 credit (see mixedMoneyDueCents above).
      if (mixedMoneyDueCents > 0) {
        console.log(
          `[unified-reserve] mixed bill ${bmiBillId}: confirming attraction money due ${mixedMoneyDueCents}¢` +
            ` (bmi totalToDeposit=${bmiMoneyDueCents ?? "unknown"})`,
        );
      }
      const bmiResult = await confirmBmiPayment({
        clientKey,
        bmiBillId,
        amountCents: useZeroModel ? mixedMoneyDueCents : dayofTotalCents,
        asCredit: useZeroModel && mixedMoneyDueCents === 0,
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

      // Reverse indexes (W# + reservationCode → billId) so a scanned code or
      // typed W-number resolves at kiosk check-in — written server-side here
      // (kiosk bookings never load the web confirmation page that historically
      // wrote the `res:` index). Best-effort; idempotent.
      await writeReservationIndexes(
        bmiBillId,
        bmiReservationNumber,
        bmiReservationCode ?? `r${bmiBillId}`,
      );

      // ── KIOSK: claim POV codes INLINE, before the response ────────────
      // The web claims on its confirmation page; the kiosk never renders one,
      // so claim here (kiosk-gated) so the codes ride the reserve result to
      // the confirmation screen AND the post-reserve rail (email + memo).
      // Claim is idempotent per billId (a retry returns the SAME set) and
      // fail-soft: a short/empty pool or a claim error never blocks the
      // booking — the rail re-tries, and every delivery surface gates on
      // codes being present. billId stays a raw string (17-digit — never
      // Number()).
      // Qty computed UNCONDITIONALLY on kiosk race bookings — the kill switch
      // gates only the claim below, so purchases during a kill window still
      // write the "POV CODES OWED" memo line and stay backfillable per bill.
      // Derivation is guarded: pure arithmetic over session data should never
      // throw, but a slip here must not mark a SUCCESSFUL BMI confirm as
      // confirm_failed (this sits inside the confirm try/catch).
      let kioskPovQty = 0;
      if (session.context?.kiosk && raceItems.length > 0) {
        try {
          kioskPovQty = raceItems.reduce(
            (n, it) => n + computeRaceItemPovQty(it, session.party),
            0,
          );
        } catch (err) {
          console.error("[unified-reserve] POV qty derivation failed (non-fatal):", err);
        }
      }
      {
        const povQty = kioskPovQty;
        if (povQty > 0 && kioskPovCodesEnabled()) {
          try {
            const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
            const claimRes = await fetch(
              `${base}/api/pov-codes?action=claim&qty=${povQty}&billId=${bmiBillId}&email=${encodeURIComponent(contact.email ?? "")}`,
              { signal: AbortSignal.timeout(5_000) },
            );
            if (claimRes.ok) {
              const claim = (await claimRes.json()) as { codes?: string[] };
              povCodesResult = Array.isArray(claim.codes) ? claim.codes : [];
            } else {
              console.error(`[unified-reserve] POV claim ${claimRes.status} bill=${bmiBillId}`);
            }
          } catch (err) {
            console.error("[unified-reserve] POV claim failed (non-fatal):", err);
          }
          if ((povCodesResult?.length ?? 0) < povQty) {
            console.error(
              `[unified-reserve] POV SHORT bill=${bmiBillId} wanted=${povQty} issued=${povCodesResult?.length ?? 0}`,
            );
          }
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
            label: p.qty > 1 ? `${p.label} ×${p.qty}` : p.label,
            // creditCount = raceCount × qty, so "used today / banked" stays
            // honest on a multi-buy deal ("2 races today · 2 banked").
            raceCount: p.creditCount,
            usedToday,
            banked: p.creditCount - usedToday,
            granted: outcomes.find((o) => o.memberId === p.memberId)?.granted ?? false,
          };
        });
      }

      // Retail add-ons: money verified + booking confirmed → grant each
      // selected racer's Pandora credit (headsock etc.). NX-idempotent,
      // sweep-recovered; racers with no BMI person yet park as
      // awaiting-person and resolve at check-in. Never throws.
      if (addonIntents.length > 0) {
        await grantAddonCredits({ purchaseKey: baseKey, intents: addonIntents });
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

      // ── Lobby TVs ───────────────────────────────────────────────────
      // Someone just finished a booking on a kiosk. Tell the screens above the
      // bank so they can react while the guest is still standing there.
      //
      // Placed BEFORE the racing/attraction split below so it covers every
      // kiosk booking regardless of item mix, and gated on the kiosk context
      // alone — a web booking has nobody standing under a screen. Not awaited,
      // and recordSignageEvent swallows anything it can throw: the booking is
      // already confirmed and charged, and a wall animation must never be able
      // to disturb that.
      if (session.context?.kiosk) {
        void recordSignageEvent({
          id: `kiosk-booking-${bmiBillId ?? bmiReservationNumber ?? "na"}-${Date.now()}`,
          kind: "booking-completed",
          center: session.center ?? "fort-myers",
          activityKeys: raceItems.length > 0 ? ["racing"] : undefined,
          atMs: Date.now(),
        });
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
              povQty: kioskPovQty,
              povCodes: povCodesResult ?? [],
              // Redirects the rail's dead-last state write to "Confirmation - VIP"
              // for a VIP pack sold at the kiosk (owner 2026-08-02).
              comboSpecialId: session.comboSpecialId ?? null,
              // Warnings the guest ticked through (race-warnings.ts) — the
              // kiosk's equivalent of the web confirmation page's memo line.
              acknowledgedWarningIds: [...new Set(raceItems.flatMap(raceWarningAckIds))],
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

      // ── KIOSK: "Confirmation Kiosk" state for ATTRACTION-ONLY bookings ──
      // The racing rail above (runKioskPostReserve §4) is the ONLY place that
      // stamps the per-location kiosk confirmation state, but it is gated on
      // race items — so an attraction-only ("arena") kiosk booking at HP FM /
      // Naples never left plain "-3 Confirmation" for the kiosk state staff work
      // from (owner-reported). The rail's guest notification is hard-coded
      // FastTrax racing copy and CANNOT fire for an attraction, so flip JUST the
      // state here — never the notification / Pandora session assignment.
      // Per-location ids (FM 55397028 / Naples 8489113); setProjectState is
      // idempotent. Deferred via after() and never throwing, exactly like the rail.
      if (session.context?.kiosk && bmiReservationNumber && raceItems.length === 0) {
        const resNumberAttr: string = bmiReservationNumber;
        const flipKioskState = async () => {
          try {
            const { setProjectState, KIOSK_CONFIRMATION_STATE_IDS } =
              await import("@/lib/bmi-office-actions");
            await setProjectState({
              centerCode,
              projectId: officeProjectId,
              stateId:
                KIOSK_CONFIRMATION_STATE_IDS[centerCode] ??
                KIOSK_CONFIRMATION_STATE_IDS["fort-myers"],
              label: "Kiosk confirmation (attraction)",
              // Self-heal against the inline `-3` Pandora write landing late and
              // reverting this custom state (the kiosk propagation race, live
              // 2026-07-22). Attraction has no rail/session-assignment delay
              // ahead of it, so the reassert window IS the propagation guard.
              ensureAttempts: 4,
              ensureGapMs: 4000,
            });
            console.log(
              `[kiosk-post] attraction confirmation state set for project ${officeProjectId} (${resNumberAttr})`,
            );
          } catch (e) {
            console.error("[kiosk-post] attraction state flip failed (non-fatal):", e);
          }
        };
        try {
          after(flipKioskState);
        } catch {
          void flipKioskState();
        }
      }

      // ── VIP combo → BMI "Confirmation - VIP" state (owner 2026-08-02) ──
      // Every Ultimate VIP Experience reads "Confirmation - VIP" in BMI. The
      // KIOSK rail is excluded here on purpose: runKioskPostReserve §4 already
      // owns the dead-last state write for kiosk racing bookings and picks the
      // VIP id itself, so stamping here too would just race it. This branch is
      // the WEB/express path. Deferred + never throwing, exactly like the blocks
      // above; the stamp carries its own self-heal against the inline `-3`
      // Pandora write landing late (see vip-state.server.ts).
      if (!session.context?.kiosk && isVipComboBooking(session.comboSpecialId)) {
        const stampVip = async () => {
          const { stampVipStateIfCombo } = await import("~/features/combos/vip-state.server");
          await stampVipStateIfCombo({
            comboSpecialId: session.comboSpecialId,
            centerCode,
            officeProjectId,
            tag: "unified-reserve",
            label: "Confirmation - VIP (booking)",
            // No rail delay ahead of this one, so the reassert window IS the
            // propagation guard — match the attraction block's wider window.
            ensureAttempts: 4,
          });
        };
        try {
          after(stampVip);
        } catch {
          void stampVip();
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
      voucher: comboVoucherResult,
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
    ...(povCodesResult && povCodesResult.length > 0 ? { povCodes: povCodesResult } : {}),
    ...(comboVoucherResult
      ? {
          comboVoucher: {
            code: comboVoucherResult.code,
            expiresAt: comboVoucherResult.expiresAt,
          },
        }
      : {}),
  };
}

export class RewardFailedError extends Error {
  code = "REWARD_FAILED";
  constructor() {
    super("Your reward couldn't be applied right now. Please try again.");
  }
}
