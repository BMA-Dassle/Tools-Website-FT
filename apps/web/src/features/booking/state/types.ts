/**
 * Booking SESSION — multi-activity cart anchored by one Square Order.
 *
 * A session is what the customer is working on right now: it may contain
 * one race heat, plus a bowling lane, plus a gel-blaster slot — all rolled
 * up into a single Square Order and a single payment. Universal-multi-park
 * model.
 *
 * Architectural rules baked in here (and recorded in project memory):
 *   - ONE Square Order per session. squareOrderId is lazy-created.
 *   - ONE CENTER per session. Cart can mix FT + HP building sides at the
 *     same physical complex. Changing center clears items[].
 *   - Brand (entryBrand) captured ONCE at session creation, never mutates.
 *     Drives theming + shuffly's FT/HP-side resolution.
 *   - Cart holds SessionItem[]. In PR-B2 every item is a BookingItem.
 *     PR-B4 adds a CreditPackItem variant for race-pack purchases.
 *
 * Customer identity model (see memory: booking_v2_architecture.md):
 *   - session.contact      — the BILLING customer (ONE; receives receipt).
 *   - session.party        — ROSTER of people doing activities. Billing
 *                            customer must explicitly add themselves if
 *                            participating (parent paying for kids may
 *                            legitimately not be in the party).
 *   - per-line assignedTo  — each booked line carries PartyMember.id refs.
 *                            BMI bill lines use the assigned member's
 *                            bmiPersonId; Conq + KBF use their own roster
 *                            concepts.
 *
 * BMI billing model:
 *   - ONE combined session.bmiBillId, NOT one per party member. Created
 *     lazily on the first BMI line booking. All BMI lines (race heats,
 *     attractions including per-slot ones) chain on this single bill.
 *   - Each BMI line carries its own bmiLineId + the personId of the
 *     assigned party member.
 *   - Bowling is Conq-vendored — not on the BMI bill. Tracks assignments
 *     for the Conq player roster.
 *
 * KBF identity is CONDITIONAL: session.kbfIdentity is present ONLY when
 * a KbfItem exists in items[]. The identity step verifies once per
 * session; subsequent KbfItems reuse the verified pass. Cleared when
 * the last KbfItem leaves the cart.
 */
import type { AppliedPromo } from "~/features/discount-codes";
import type { BmiProposal } from "../data/bmi";
import type { Activity, Brand, CenterCode, ContactInfo } from "../types";
import type { EntryContext } from "./entry-context";
import type { RaceTier, RaceCategory } from "../service/race-products";

/* ───────────────────────── PartyMember ─────────────────────────── */

/**
 * A person on this booking session's party roster. Each booked line
 * (race heat, attraction seat, bowling player slot) references a
 * PartyMember by `id`.
 */
export interface PartyMember {
  /** Local stable id — used as the assignedTo reference on lines. */
  id: string;
  firstName: string;
  lastName?: string;
  /**
   * BMI personId (raw digit string — see @ft/db.stringifyWithRawIds).
   * Looked up for returning racers; lazy-created on first BMI booking
   * for new racers.
   */
  bmiPersonId?: string;
  /** Drives Starter-only filter + per-first-timer license fee. */
  isNewRacer: boolean;
  /** Adult / junior — drives race product eligibility. */
  category?: "adult" | "junior";
  /** True when this member is also session.contact (the paying customer). */
  isBillingCustomer?: boolean;
  /**
   * BMI membership name strings (e.g. ["Intermediate License", "Pro License"]).
   * Populated by `ReturningRacerLookup.handlePersonVerified` when a returning
   * racer is identified. Drives tier filtering in `filterProducts` — without
   * this, even verified Pro racers see Starter-only products.
   */
  memberships?: string[];
  /** Pandora waiver validity — true when the racer has a current, unexpired waiver.
   *  Drives Express Lane eligibility (skip Guest Services at check-in). */
  waiverValid?: boolean;
  /** Race credit balances from BMI (e.g. [{kind: "Starter Race", balance: 3}]). */
  creditBalances?: Array<{ kind: string; balance: number }>;
  /**
   * v2 $0 model: when true, this racer pays for their heats with race CREDITS
   * instead of cash. Their heats are covered by drawing down their OWN eligible
   * balances in priority order (Membership → Weekday → Anytime → Comp; see
   * race-credits.ts) — Square charges $0 per covered heat and one credit is
   * deducted per covered heat; any heats beyond their combined balance are paid in
   * cash. Toggled at checkout. Only valid for returning racers / linked family
   * (bmiPersonId && !isNewRacer). false/undefined = pay cash.
   */
  redeemCredits?: boolean;
}

/* ───────────────────────── BookingItems ────────────────────────── */

/** Fields shared by every booking item. */
interface BookingItemBase {
  /** Local id for cart manipulation. Stable across the session. */
  id: string;
}

/** A single race-heat assignment on the combined BMI bill. */
export interface RaceHeatAssignment {
  /**
   * BMI productId for this specific heat. Same as the parent RaceItem's
   * productId for single-tier picks; differs in mixed-track 3-packs
   * where each heat picks a track (via race-products `trackProducts`
   * map → Red product vs Blue product).
   */
  productId: string | null;
  /** "Red" | "Blue" | "Mega" | null. */
  track: "Red" | "Blue" | "Mega" | null;
  /**
   * $0 build-key parts — written at pick time for package + combo heats (whose
   * `productId` is a package-only SKU or a combo per-track component NOT in
   * RACE_PRODUCTS). They let booking + charge resolve the `(category:tier:track)`
   * $0 build pair directly. Single-race heats may leave these unset and resolve
   * via `productId` through `getRaceProductById`.
   */
  tier?: RaceTier;
  category?: RaceCategory;
  /** Picked heat block (from BMI availability). */
  heatId: string | null;
  /** BMI bill line id, set after bookHeat succeeds. */
  bmiLineId: string | null;
  /** PartyMember.id — who's racing this heat. Required at confirm time. */
  assignedTo: string | null;
}

export interface RaceItem extends BookingItemBase {
  kind: "race";
  /**
   * "new" vs "existing" racer — chosen on the first race step (the experience
   * picker). Drives the Party step's UI: a returning-account lookup ("existing")
   * vs the new-racer quantity counters ("new"). null until chosen.
   */
  entryMode?: "new" | "existing" | null;
  /**
   * YYYY-MM-DD — the race day. All heats[] fall on this date. The wizard's
   * Date step writes this; subsequent steps (Product, HeatPicker) filter
   * BMI availability by it.
   */
  date: string | null;
  /**
   * Picked product for the ADULT category — when the party has adults.
   * Single-tier picks (Starter Red, Pro Mega, etc.) book every adult heat
   * against this productId. Mixed-track 3-packs (Intermediate Weekday
   * 3-Pack: Red + Blue) point at the PARENT pack id; each heat's
   * heats[i].productId resolves via the registry's trackProducts map at
   * book time.
   *
   * v1 parity: race v1 cycles adult product → adult heats → junior product
   * → junior heats. v2 mirrors that with two separate product fields +
   * isVisible-gated step variants.
   */
  productIdAdult: string | null;
  /** Picked product for the JUNIOR category — when the party has juniors. */
  productIdJunior: string | null;
  /**
   * For multi-track packs (where the parent product carries a `trackProducts`
   * map), the customer's chosen track lives here. Single-track products
   * leave this null. v1 parity: ProductPicker's TrackPickerModal forces a
   * track choice for multi-track 3-packs; v2 stores the choice here so the
   * HeatPicker resolves `trackProducts[productTrack*]` for BMI booking.
   */
  productTrackAdult: string | null;
  productTrackJunior: string | null;
  /**
   * Flat list of (heat block, racer) tuples. Each entry corresponds to ONE
   * BMI bill line: heatId is the block start ISO, productId determines
   * which category bill the line lands on, assignedTo is the racer who
   * carries that line. Multiple racers on the same heat share heatId but
   * have distinct entries (one per racer). 3-pack day-of products require
   * raceCount heats per category. Heat-conflict validation runs per
   * category + per racer.
   */
  heats: RaceHeatAssignment[];
  /**
   * Premium Package selection (id from `lib/packages.ts` registry, e.g.
   * "rookie-pack-weekday", "ultimate-qualifier-mega"). null when the
   * customer picked individual races instead of a package. Persisted on
   * the item so back-nav doesn't lose the selection AND so saveBookingDetails
   * can write it to /api/booking-record; v1's confirmation page forwards
   * it to /api/notifications/booking-confirmation which writes it to
   * `sales_log.package_id` for the sales dashboard's package breakdowns.
   */
  packageId: string | null;
  /**
   * Number of POV cameras to pre-pay ($5/each online vs $7 at check-in).
   * BMI sells POV as a flat qty SKU (productId 43746981), no per-racer
   * attribution. For new racers in the Rookie Pack flow, this equals the
   * count of new racers. For existing-racer flow, the qty stepper sets
   * this directly. 0 = no POV.
   */
  povQuantity: number;
  /**
   * Idempotency guard for the $0 POV BMI line (product 50361293) + the package
   * disclaimer memo, both written once in `bookHeatsOnAdvance` after the heats
   * book. Prevents a back-then-forward wizard re-advance from selling POV /
   * writing the memo twice. The $5/racer POV money is charged on Square, not here.
   */
  povSold?: boolean;
  /**
   * Race-day add-ons (Shuffly, Duckpin, Gel Blaster, Laser Tag). Each
   * entry carries the BMI productId, customer-picked quantity, and the
   * chosen time slot (ISO start). v1 AddOnsPage parity: per-person
   * add-ons store qty = racer count; per-group add-ons (Shuffly,
   * Duckpin) toggle qty 0/1. Checkout (commit 10) sells one BMI line
   * per entry against the combined session bill.
   */
  addons: Array<{
    id: string;
    qty: number;
    selectedTime: string | null;
    /** Set after BMI `booking/sell` returns; lets the checkout retry path
     *  detect already-billed add-ons + skip duplicates. */
    bmiLineId: string | null;
  }>;
  /**
   * Rookie Pack opt-in for new racers (only meaningful when at least one
   * racer in `session.party` has `isNewRacer: true`). `true` = bundle
   * (license + POV + free Nemo's appetizer code on confirmation); `false`
   * = License only (offered but opted out); `null` = not yet asked /
   * not applicable. Drives the appetizer card on the confirmation page.
   */
  rookiePack: boolean | null;
}

export interface AttractionItem extends BookingItemBase {
  kind: "attraction";
  /** "gel-blaster" | "laser-tag" | "duck-pin" | "shuffly". */
  slug: string | null;
  date: string | null;
  slot: string | null;
  qty: number;
  /** BMI productId for the selected product variant. */
  productId: string | null;
  /** BMI pageId (from ATTRACTIONS config). */
  pageId: string | null;
  /** Unit price from the product registry (for cart display). */
  price: number;
  /** BMI bill line id — set after bookHeat succeeds. */
  bmiLineId: string | null;
  /** The selected time slot's BMI proposal — needed for booking. JSON-safe. */
  slotProposal: BmiProposal | null;
  /**
   * Party members on this attraction line. Universal: even per-slot
   * attractions (duck-pin, shuffly) track who's playing for the BMI
   * bill roster. For per-person attractions (gel-blaster, laser-tag),
   * assignedTo.length typically matches qty.
   */
  assignedTo: string[];
}

/** Attraction add-on booked via BMI during a bowling session. */
export interface BowlingAttractionAddon {
  slug: string;
  name: string;
  quantity: number;
  bmiOrderId: string | null;
  bmiBillLineId: string | null;
  squareCatalogObjectId: string | null;
  pricePerPerson: number;
  totalPrice: number;
  timeSlot: string;
  timeLabel: string;
}

/** Fields shared between BowlingItem and KbfItem (bowling-common). */
interface BowlingCommon {
  date: string | null;
  hour: number | null;
  minute: number | null;
  /** Full ISO from QAMF availability (e.g. "2026-06-01T14:00:00-04:00"). */
  bookedAt: string | null;
  /** DB experience row id. */
  experienceId: number | null;
  /** Experience slug (e.g. "fun-4-all", "vip-mon-thur", "pizza-bowl"). */
  experienceSlug: string | null;
  /** QAMF web offer ID for the selected experience at this center. */
  webOfferId: number | null;
  /** QAMF option ID (game/time/unlimited variant). */
  optionId: number | null;
  optionType: "Game" | "Time" | "Unlimited" | null;
  tier: "regular" | "vip" | null;
  laneCount: number;
  /** Duration in minutes for hourly rentals (null for non-hourly). */
  durationMinutes: number | null;
  /** Square line-item multiplier for the primary bowling product. */
  durationMultiplier: number;
  /** Shoe rental selections: bowling_square_products.id → quantity. */
  shoeSelections: Record<number, number>;
  /** Laser tag / gel blaster add-ons booked via BMI. */
  attractionAddons: BowlingAttractionAddon[];
  /** Pizza bowl per-lane modifier selections. Each entry = one lane. */
  pizzaModifierSelections: Array<Record<string, string[]>>;
  /** Modifier group ids classified as the soda/drink group (set when the
   *  pizza-bowl modifiers load). Used to require a drink pick per lane. */
  pizzaSodaGroupIds?: string[];
  /** QAMF temporary reservation ID (set after hold creation on offer step). */
  qamfReservationId: string | null;
  /** QAMF center ID (numeric, e.g. 9172 or 3148). */
  qamfCenterId: number | null;
  /** Resolved line items sent to the reserve route. Enriched with metadata for checkout display + quote building. */
  lineItems: Array<{
    squareProductId: number;
    quantity: number;
    label?: string;
    priceCents?: number;
    depositPct?: number;
    squareCatalogObjectId?: string;
  }>;
  /** $0 pass-through items (pizza/soda) for Square order visibility. */
  rawItems: Array<{ catalogObjectId: string; name: string; quantity: number; note?: string }>;
  /** Shoe product metadata for checkout display + quote building. Populated by ShoesStep. */
  shoeProducts?: Array<{
    id: number;
    label: string;
    priceCents: number;
    depositPct: number;
    squareCatalogObjectId: string;
  }>;
  /** Pre-created Square day-of order from the quote step. */
  quoteDayofOrderId: string | null;
  quoteTotalCents: number;
  quoteDepositCents: number;
  quoteDiscountOffCents: number;
  /** True when a $2.99 booking fee is included. */
  hasBookingFee: boolean;
}

export interface BowlingItem extends BookingItemBase, BowlingCommon {
  kind: "bowling";
  variant: "open" | "hourly";
  playerCount: number;
  /** Party members playing — feeds the Conq reservation roster (not BMI bill). */
  assignedTo: string[];
  /** Discount code applied mid-flow (bowling slots step). */
  discountCode: string | null;
}

export interface KbfItem extends BookingItemBase, BowlingCommon {
  kind: "kbf";
  /** KBF pass member ids (from kbf_pass_members). A DIFFERENT roster
   *  from session.party — KBF passes have their own membership tables. */
  bowlers: number[];
  /** Verified KBF pass id. */
  passId: number | null;
  /** Number of paying adults (drives shoes / adult-lane add-ons). */
  paidAdults: number;
}

/** Items that resolve to a vendor reservation at confirm time. */
export type BookingItem = RaceItem | AttractionItem | BowlingItem | KbfItem;

/**
 * SessionItem is the cart's item union. In PR-B2 it's exactly
 * BookingItem; PR-B4 adds a `CreditPackItem` variant for race-packs and
 * future credit-purchase products that live in the cart without booking
 * anything against a vendor.
 */
export type SessionItem = BookingItem;

/* ───────────────────── KBF identity (session-conditional) ────────── */

/**
 * One bookable member of a verified KBF family pass. Sourced from
 * kbf_pass_members via /api/kbf/verify. `id` is the real DB row id —
 * globally unique across passes — and is what KbfItem.bowlers stores.
 */
export interface KbfPassMember {
  id: number;
  passId: number;
  relation: "kid" | "family";
  slot: number;
  firstName: string;
  lastName: string;
}

/**
 * KBF identity state — populated ONLY when at least one KbfItem exists
 * in session.items[]. Cleared by the reducer when the last KbfItem is
 * removed from the cart. The identity step verifies once per session;
 * additional KbfItems reuse the verified pass.
 */
export interface KbfIdentityState {
  phase: "lookup" | "verify" | "verified";
  emailOrPhone: string;
  passId: number | null;
  /**
   * Full bowler roster across EVERY verified pass. A parent registered
   * at both centers (or with multiple accounts on one phone/email)
   * yields more than one pass, so this is flattened across all of them.
   * Captured at verify time and reused by the Bowlers step — there is
   * no separate members endpoint to re-fetch from.
   */
  members: KbfPassMember[];
}

/* ───────────────────── Loyalty (HeadPinz Rewards) ──────────────── */

/** Selected reward tier for deposit discount at checkout. */
export interface SelectedRewardTier {
  id: string;
  name: string;
  points: number;
  discountCents: number;
}

/**
 * Square Loyalty state. Populated during checkout when the customer's
 * phone resolves to a HeadPinz Rewards account (or they enroll).
 *
 * Earning: `customerId` is attached to the Square day-of order so
 * points auto-accrue (10 Pinz per $1). No verification needed.
 *
 * Redeeming: requires SMS verification to prove ownership. After
 * verify, reward tiers become selectable to reduce the deposit.
 */
export interface LoyaltyState {
  accountId: string;
  customerId: string;
  balance: number;
  verified: boolean;
  isNewSignup: boolean;
  selectedRewardTier: SelectedRewardTier | null;
}

/* ───────────────────────── BookingSession ──────────────────────── */

export interface BookingSession {
  /** Lazy — created when the first item is committed to Square. */
  squareOrderId: string | null;
  /**
   * Combined BMI bill anchor for the whole session. Lazy-created on
   * the first BMI line (race heat or attraction). All subsequent BMI
   * lines chain on this bill via orderId.
   */
  bmiBillId: string | null;
  /** Captured at session start from entry URL host or first activity. */
  entryBrand: Brand;
  /** Physical complex. Locked when items[] is non-empty. Switching clears items. */
  center: CenterCode | null;
  /** BILLING customer (collected at the contact step; receives receipt). */
  contact: Partial<ContactInfo>;
  /** Prefilled data carried in via URL params, cookies, auth. */
  context: EntryContext;
  /**
   * Promo code captured at session start. Set ONCE via the `/book/v2`
   * landing or a `?code=X` URL seed on direct-slug entry; never mutates.
   * Drives the initial offerings filter, first-activity date / product
   * filter, and the checkout discount application.
   *
   * Cart cross-sell (`crossSellFor`) IGNORES this — see
   * memory: booking_v2_promo_integration.md.
   */
  appliedPromo: AppliedPromo | null;
  /**
   * Combo-special id (features/combos registry, e.g. "race-bowl") — stamped
   * ONCE at session creation by the /book/combo/[id]/v2 entry, like
   * `appliedPromo`. When set AND the strict gate passes (exactly the combo's
   * components in the cart — see features/combos/combo-pricing.ts), checkout
   * charges the flat combo price instead of item-sum. NOT `comboId`: bare
   * "combo" means the 3-pack race SKUs in this codebase.
   */
  comboSpecialId?: string;
  /**
   * Roster of party members doing activities. May be empty (e.g. the
   * customer hasn't reached the party step yet). The billing customer
   * is in here if they're participating (with `isBillingCustomer: true`).
   */
  party: PartyMember[];
  /**
   * KBF identity verification state — present ONLY when at least one
   * KbfItem exists in items[]. Reducer auto-clears when the last KBF
   * item leaves the cart.
   */
  kbfIdentity?: KbfIdentityState;
  /**
   * HeadPinz Loyalty (Square Loyalty) state — populated during checkout
   * when the customer enters a phone number at a HeadPinz center.
   * Drives both earning (squareCustomerId attached to day-of order for
   * point accrual) and redeeming (reward tier selection for deposit discount).
   */
  loyalty?: LoyaltyState;
  /** Items in the cart, insertion order. */
  items: SessionItem[];
  /**
   * Id of the item currently being edited in a sub-wizard.
   * `null` = customer is on the session-level cart view.
   */
  activeItemId: string | null;
  /** Per-item step cursor: { [itemId]: stepIndex }. */
  cursors: Record<string, number>;
}

/* ───────────────────────── factories ───────────────────────────── */

/** Build a fresh session given the entry brand and any prefilled context. */
export function emptySession(args: {
  entryBrand: Brand;
  context?: EntryContext;
  /** Promo captured at the landing page or via ?code= on direct slug entry. */
  appliedPromo?: AppliedPromo | null;
}): BookingSession {
  return {
    squareOrderId: null,
    bmiBillId: null,
    entryBrand: args.entryBrand,
    center: null,
    contact: args.context?.prefilledContact ?? {},
    context: args.context ?? {},
    appliedPromo: args.appliedPromo ?? null,
    party: [],
    items: [],
    activeItemId: null,
    cursors: {},
  };
}

/** Build a fresh item for an activity. Caller assigns it into the session. */
export function newItem(activity: Activity): SessionItem {
  const id = newItemId();
  switch (activity) {
    case "race":
      return {
        id,
        kind: "race",
        entryMode: null,
        date: null,
        productIdAdult: null,
        productIdJunior: null,
        productTrackAdult: null,
        productTrackJunior: null,
        heats: [],
        packageId: null,
        povQuantity: 0,
        rookiePack: null,
        addons: [],
      };
    case "attraction":
      return {
        id,
        kind: "attraction",
        slug: null,
        date: null,
        slot: null,
        qty: 1,
        productId: null,
        pageId: null,
        price: 0,
        bmiLineId: null,
        slotProposal: null,
        assignedTo: [],
      };
    case "bowling":
      return {
        id,
        kind: "bowling",
        variant: "open",
        playerCount: 2,
        date: null,
        hour: null,
        minute: null,
        bookedAt: null,
        experienceId: null,
        experienceSlug: null,
        webOfferId: null,
        optionId: null,
        optionType: null,
        tier: null,
        laneCount: 1,
        durationMinutes: null,
        durationMultiplier: 1,
        shoeSelections: {},
        attractionAddons: [],
        pizzaModifierSelections: [{}],
        qamfReservationId: null,
        qamfCenterId: null,
        lineItems: [],
        rawItems: [],
        quoteDayofOrderId: null,
        quoteTotalCents: 0,
        quoteDepositCents: 0,
        quoteDiscountOffCents: 0,
        hasBookingFee: false,
        assignedTo: [],
        discountCode: null,
      };
    case "kbf":
      return {
        id,
        kind: "kbf",
        bowlers: [],
        passId: null,
        paidAdults: 0,
        date: null,
        hour: null,
        minute: null,
        bookedAt: null,
        experienceId: null,
        experienceSlug: null,
        webOfferId: null,
        optionId: null,
        optionType: null,
        tier: null,
        laneCount: 1,
        durationMinutes: null,
        durationMultiplier: 1,
        shoeSelections: {},
        attractionAddons: [],
        pizzaModifierSelections: [{}],
        qamfReservationId: null,
        qamfCenterId: null,
        lineItems: [],
        rawItems: [],
        quoteDayofOrderId: null,
        quoteTotalCents: 0,
        quoteDepositCents: 0,
        quoteDiscountOffCents: 0,
        hasBookingFee: false,
      };
  }
}

/** Build a fresh empty PartyMember. */
export function newPartyMember(args: {
  firstName: string;
  lastName?: string;
  bmiPersonId?: string;
  isNewRacer?: boolean;
  category?: "adult" | "junior";
  isBillingCustomer?: boolean;
  memberships?: string[];
  waiverValid?: boolean;
  creditBalances?: Array<{ kind: string; balance: number }>;
}): PartyMember {
  return {
    id: newItemId(),
    firstName: args.firstName,
    lastName: args.lastName,
    bmiPersonId: args.bmiPersonId,
    isNewRacer: args.isNewRacer ?? true,
    category: args.category,
    isBillingCustomer: args.isBillingCustomer,
    memberships: args.memberships,
    waiverValid: args.waiverValid,
    creditBalances: args.creditBalances,
  };
}

/** Build a fresh KBF identity state in its initial lookup phase. */
export function newKbfIdentity(): KbfIdentityState {
  return { phase: "lookup", emailOrPhone: "", passId: null, members: [] };
}

/* ───────────────────────── lookups ─────────────────────────────── */

/** Look up an item by id. Throws if missing — caller must know it exists. */
export function getItem(session: BookingSession, id: string): SessionItem {
  const item = session.items.find((i) => i.id === id);
  if (!item) throw new Error(`No session item with id ${id}`);
  return item;
}

/** Resolve the currently active item (or null if customer is on cart view). */
export function getActiveItem(session: BookingSession): SessionItem | null {
  if (!session.activeItemId) return null;
  return session.items.find((i) => i.id === session.activeItemId) ?? null;
}

/** Look up a party member by id. Returns undefined when not found. */
export function getPartyMember(session: BookingSession, memberId: string): PartyMember | undefined {
  return session.party.find((m) => m.id === memberId);
}

/** Does the session currently contain at least one KbfItem? */
export function hasKbfItem(session: BookingSession): boolean {
  return session.items.some((i) => i.kind === "kbf");
}

function newItemId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  );
}
