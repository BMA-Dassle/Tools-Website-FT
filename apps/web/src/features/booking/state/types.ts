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

/**
 * The session's scanned/applied BMI voucher (shared by kiosk + web — see
 * service/voucher-redeem.ts for the redemption model and coverage math).
 */
export interface AppliedVoucherState {
  /** The voucher number, uppercased. */
  code: string;
  /**
   * Who issued it. Absent = "bmi" (every pre-existing row), so the BMI path is
   * unchanged. "native" = our own HPW voucher, covered on OUR side at charge
   * (no BMI bill, no applyCode) and made single-use by voucher_claims.
   */
  issuer?: "bmi" | "native";
  /** Native only: which item on the code this applied line spends. */
  itemIndex?: number;
  /** Comp/line name (e.g. "Race Comp") — drives voucherTarget() coverage. */
  name?: string;
  /** Bill the comp line landed on — set once applied (not pending). */
  billId?: string;
  /** The comp line's OrderItemId on that bill (raw string — 17-digit). */
  voucherOrderItemId?: string;
  /** Scanned before any BMI bill existed — applied as soon as one is created. */
  pending?: boolean;
  /** Apply failed — surfaced to the guest at checkout, never silently dropped. */
  error?: string;
}

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
  /**
   * SHORT Pandora/public person id — Pandora's waiver-sign and race-schedule
   * endpoints REJECT the 17-digit Office id a returning-racer lookup yields
   * (live 2026-07-18: waiver sign 500s), so the kiosk resolves this via the
   * Pandora create (which usually resolves a known person to the same id but
   * is NOT a reliable upsert — 2026-07-25: it can mint a duplicate, so resolve
   * AT MOST ONCE) and prefers it for every Pandora call. New racers' bmiPersonId IS already
   * this short id.
   */
  pandoraPersonId?: string;
  /**
   * The racer's BMI login tag, when a returning-racer lookup produced one.
   * Carried purely so the kiosk can offer the wallet racing licence — it is
   * the ONLY identifier the pass barcode can hold. Absent for a new racer
   * (no tag exists yet) and for anyone added by name rather than by lookup.
   */
  loginCode?: string;
  /** Drives Starter-only filter + per-first-timer license fee. */
  isNewRacer: boolean;
  /**
   * The FastTrax license was ALREADY bought + registered for this racer (e.g. a
   * standalone race-pack purchase's "Race today — use one now" hand-off). Keeps
   * `isNewRacer: true` (Starter-only tier + the height/age safety confirm still
   * apply) while suppressing a SECOND license — both the $4.99 checkout line
   * (checkout.ts newRacerCount) and the withLicense BMI grant (race.ts
   * licenseHeatIndices). Never re-charge a license the guest already paid for.
   */
  licensePrepaid?: boolean;
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
  /** Verified with BMI: an UNEXPIRED licence membership is on file. Written by
   *  the qualification refresh / returning-racer sign-in; undefined = not read.
   *  THE money signal for the $4.99 licence and the +licence BMI build product
   *  (service/license.ts) — `isNewRacer` alone let a lapsed licence through. */
  licenseActive?: boolean;
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
  /**
   * Kiosk: for a MINOR participant (age < 18), the id of the adult who signed
   * their waiver — references either a `party` member OR a `session.guardians`
   * entry (signer-only adult, not purchasing). Only required when the minor
   * actually needed a waiver signed this session (owner rule 2026-07-18,
   * revised 2026-07-18: a returning minor with a valid waiver needs no
   * guardian). Resolved to the guardian's Pandora person id at onboard/sign
   * time. Ignored by the web flow.
   */
  guardianMemberId?: string;
  /** Kiosk: true when this member is a minor (age < 18) — needs a guardian to
   *  sign the waiver. Separate from `category` (racing tier bucket). */
  isMinor?: boolean;
  /** Kiosk: this person's mobile phone (owner rule 2026-07-18 — every new player
   *  gives one; stored on their Pandora person as mobile). The MAIN person's
   *  phone/email become session.contact so there's no separate contact step. */
  phone?: string;
  email?: string;
  /**
   * Kiosk: true when `phone` was proven by a successful SMS OTP this session
   * (returning-racer phone lookup on the kiosk, or the mobile-join phone
   * sign-in). Rides into session.contact when this member becomes main, where
   * it lets rewards redemption skip the checkout SMS verify (owner
   * 2026-07-21: "you don't need OTP if the main contact was already verified
   * in racers sign up"). NEVER set for typed/unverified phones (new-racer
   * forms, login-code or email lookups, manual contact edits).
   */
  phoneVerified?: boolean;
  /** Kiosk: this person's date of birth as an ISO "YYYY-MM-DD" string, captured
   *  from a returning-racer lookup so the setup form never re-asks a birthday we
   *  already have on file (owner 2026-07-19). Ignored by the web flow. */
  dobIso?: string;
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
   * KIOSK race packs (CREDIT packs — owner final design 2026-07-18): selection
   * POINTERS only ({RACE_PACKS slug, party memberId}); every price/kind/label
   * re-derives server-side (race-pack-kiosk.ts). One pack per member (replace
   * semantics). The pack line rides the DAY-OF Square order; the assignee's
   * today heats are credit-covered post-grant. Absent on web sessions —
   * additive, no schema bump.
   */
  creditPacks?: Array<{ slug: string; memberId: string }>;
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
   * Premium Package selection PER CATEGORY (ids from `lib/packages.ts`
   * registry, e.g. "rookie-pack-weekday", "ultimate-qualifier-weekday-junior").
   * null when that category picked individual races (or isn't in the party).
   * Two fields — NOT one — because package variants are category-specific
   * (adult/junior carry different BMI SKUs AND different prices): a single
   * field let a mixed party's junior selection overwrite the adult variant,
   * and checkout then priced EVERY racer at the junior per-racer price
   * (live undercharge, found 2026-07-19). Mirrors productIdAdult/Junior.
   * Persisted on the item so back-nav doesn't lose the selection AND so
   * saveBookingDetails can write it to /api/booking-record; v1's confirmation
   * page forwards it to /api/notifications/booking-confirmation which writes
   * it to `sales_log.package_id` for the sales dashboard's package breakdowns.
   */
  packageIdAdult: string | null;
  packageIdJunior: string | null;
  /**
   * Number of POV cameras to pre-pay ($4.99/each online vs $7 at check-in).
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
   * writing the memo twice. The POV money is charged on Square, not here.
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

/** The per-category package fields of a RaceItem (see packageIdAdult docs). */
export type RacePackageFields = Pick<RaceItem, "packageIdAdult" | "packageIdJunior">;

/** The category's selected package id — the ONLY sanctioned way to read the
 *  package fields, so a future category never silently falls through. */
export function packageIdForCategory(
  item: RacePackageFields,
  category: RaceCategory,
): string | null {
  return category === "junior" ? item.packageIdJunior : item.packageIdAdult;
}

/** Distinct non-null package ids on the item, adult-first (the adult variant
 *  is the "primary" recorded on the booking record / sales_log). */
export function racePackageIds(item: RacePackageFields): string[] {
  const ids = [item.packageIdAdult, item.packageIdJunior].filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/** True when EVERY category present in the party has a package selected on the
 *  item. Single seam for "the package covers the whole party" decisions — the
 *  POV upsell step hides on it, and buildRaceChargeLines suppresses the
 *  standalone POV quantity on it — so display and charge can't disagree. */
export function raceItemFullyPackaged(
  item: RacePackageFields,
  party: Array<{ category?: "adult" | "junior" }>,
): boolean {
  const cats = (["adult", "junior"] as const).filter((c) =>
    party.some((m) => (m.category ?? "adult") === c),
  );
  return cats.length > 0 && cats.every((c) => !!packageIdForCategory(item, c));
}

export interface AttractionItem extends BookingItemBase {
  kind: "attraction";
  /** "gel-blaster" | "laser-tag" | "duck-pin" | "shuffly". */
  slug: string | null;
  date: string | null;
  slot: string | null;
  qty: number;
  /**
   * KIOSK-ONLY (optional — web never writes it): session.party member ids
   * participating in THIS attraction. Waiver-gated attractions (everything
   * except duckpin, owner rule 2026-07-17) require every participant to be
   * registered with a signed waiver in-flow; qty is kept in sync with the
   * selection.
   */
  participants?: string[];
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
  /**
   * bowling_experience_duration_options.id of the picked duration (hourly
   * experiences only). Persisted so the v3 Time step can rebuild lineItems
   * after back-nav / re-hold without component-local state. Optional so
   * sessions persisted before this field hydrate undefined → null-ish.
   */
  durationOptionId?: number | null;
  /** Shoe rental selections: bowling_square_products.id → quantity. */
  shoeSelections: Record<number, number>;
  /**
   * Per-bowler roster collected UP FRONT (kiosk requirement 2026-07-17:
   * names, shoe sizes, and bumpers are mandatory in-flow on the kiosk;
   * the web keeps collecting them post-booking). Optional so persisted web
   * sessions hydrate unchanged; when present, the reserve paths use real
   * names for the QAMF lane setup and persist the roster with the
   * reservation (persist-at-capture).
   */
  players?: Array<{
    name: string;
    shoeSize: string | null;
    bumpers: boolean | null;
    /**
     * Kiosk signed-in carry-over: PartyMember.id when this row came from the
     * session party (guest signed in for racing/an attraction earlier in the
     * transaction) rather than being typed. Lets the bowling people step
     * toggle roster members in/out without name-matching. Reserve paths read
     * name/shoeSize/bumpers only — this never leaves the client session.
     */
    memberId?: string;
  }>;
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
  /**
   * World Cup VIP Bowling entry mode (?experience=world-cup): the match
   * picker step replaces the Slots/Tier/Offer steps and pins the lane window
   * to a fixture kickoff (tier forced to VIP). Optional so sessions persisted
   * before this field hydrate undefined → falsy.
   */
  isWorldCup?: boolean;
  /** WORLD_CUP_FIXTURES id of the picked match (persisted to booking metadata). */
  worldCupMatchId?: string | null;
  /**
   * FastTrax duckpin (QAMF center 11542). FastTrax and HeadPinz FM share the
   * "fort-myers" CenterCode, so this item-level marker — not session.center —
   * is what routes the item to 11542 (see reducer) and drives duckpin-specific
   * behavior: no shoe step, no shoe-size capture, FastTrax branding. Optional so
   * sessions persisted before this field hydrate undefined → falsy (HeadPinz).
   */
  isDuckpin?: boolean;
  /**
   * "Play Now" per-lane QR: the specific physical duckpin lane this booking is
   * pinned to (from EntryContext.pinnedLane). When set, the hold targets THIS
   * lane (QAMF createReservation Lanes:[{LaneNumber}]) instead of auto-assign,
   * the wizard hides date/time selection, and the lane opens immediately on
   * confirmation. Optional so sessions persisted before this field hydrate
   * undefined → falsy (normal auto-assign). See flags.ts playNowActive.
   */
  pinnedLaneNumber?: number;
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

/** KIOSK: Game Zone cards attached to the booking cart (see
 *  BookingSession.gameCardPurchase). One purchase per session; `cards` are
 *  selection pointers (packageId + the read account for reloads) — never
 *  prices. */
export interface GameCardCartPurchase {
  mode: "new_card" | "reload";
  cards: Array<{ packageId: string; accountNumber?: string }>;
}

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
   * BMI vouchers captured at the kiosk code-entry screen or the web checkout
   * promo input — a LIST, scan order preserved (owner 2026-07-27: a party
   * scans one comp per racer). Unlike `appliedPromo` (our Neon discount
   * codes), vouchers are BMI's: redemption = `order/applyCode` puts each
   * voucher's comp product on the bill as a $0 line and BMI nets them at
   * processing; OUR charge excludes the covered heats/units (see
   * service/voucher-redeem.ts planVoucherCoverage). Entries are `pending`
   * until a BMI bill exists to apply to.
   */
  appliedVouchers?: AppliedVoucherState[];
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
   * Kiosk only: the guest entered the race flow from an Experiences tile for a
   * specific package FAMILY (e.g. "ultimate-qualifier"), so the product step
   * should preselect that package and skip — no reselecting what they just
   * tapped. Kept as the family id (not a schedule variant); the flow resolves
   * the eligible variant for the party via eligiblePackages(). Web never sets it.
   */
  preferredPackageId?: string;
  /**
   * KIOSK only: Game Zone cards riding the booking cart (owner 2026-07-18 —
   * "if we have items in cart… it should just be in the cart"). Paid WITH the
   * booking deposit at the shared checkout: the cards become real catalog
   * lines on the DEPOSIT order (token + activation-fee catalog ids), never a
   * day-of order; fulfillment (dispense/load or bridge reload) runs on the
   * kiosk confirmation screen after payment. Server re-derives every price
   * from TOKEN_PACKAGES — these entries are selection pointers only. Web
   * never sets it.
   */
  gameCardPurchase?: GameCardCartPurchase;
  /**
   * Roster of party members doing activities. May be empty (e.g. the
   * customer hasn't reached the party step yet). The billing customer
   * is in here if they're participating (with `isBillingCustomer: true`).
   */
  party: PartyMember[];
  /**
   * KIOSK only: signer-only guardians — adults who signed a minor's waiver but
   * are NOT part of the purchase (owner 2026-07-18: the parent may just be
   * paying for the kids). Excluded from items/charges/BMI bill registration BY
   * CONSTRUCTION — they are not in `party`, so no purchase-path consumer ever
   * sees them. "Join the fun" moves the entry into `party` keeping its id, so
   * minors' guardianMemberId refs stay valid. Web never sets it.
   */
  guardians?: PartyMember[];
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
        packageIdAdult: null,
        packageIdJunior: null,
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
        durationOptionId: null,
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
        isWorldCup: false,
        worldCupMatchId: null,
        isDuckpin: false,
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
        durationOptionId: null,
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
  loginCode?: string;
  isNewRacer?: boolean;
  category?: "adult" | "junior";
  isBillingCustomer?: boolean;
  licenseActive?: boolean;
  memberships?: string[];
  waiverValid?: boolean;
  creditBalances?: Array<{ kind: string; balance: number }>;
  guardianMemberId?: string;
  isMinor?: boolean;
  phone?: string;
  email?: string;
  phoneVerified?: boolean;
  dobIso?: string;
}): PartyMember {
  return {
    id: newItemId(),
    firstName: args.firstName,
    lastName: args.lastName,
    bmiPersonId: args.bmiPersonId,
    loginCode: args.loginCode,
    isNewRacer: args.isNewRacer ?? true,
    category: args.category,
    isBillingCustomer: args.isBillingCustomer,
    licenseActive: args.licenseActive,
    memberships: args.memberships,
    waiverValid: args.waiverValid,
    creditBalances: args.creditBalances,
    guardianMemberId: args.guardianMemberId,
    isMinor: args.isMinor,
    phone: args.phone,
    email: args.email,
    phoneVerified: args.phoneVerified,
    dobIso: args.dobIso,
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
