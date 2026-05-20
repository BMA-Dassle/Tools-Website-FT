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
import type { Activity, Brand, CenterCode, ContactInfo } from "../types";
import type { EntryContext } from "./entry-context";

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
   * YYYY-MM-DD — the race day. All heats[] fall on this date. The wizard's
   * Date step writes this; subsequent steps (Product, HeatPicker) filter
   * BMI availability by it.
   */
  date: string | null;
  /**
   * Customer-picked product. For single-tier picks (Starter Red, Pro Mega,
   * etc.) every heat books against this productId. For mixed-track 3-packs
   * (Intermediate Weekday 3-Pack: Red + Blue), this points at the PARENT
   * pack id; each heat's heats[i].productId resolves via the registry's
   * trackProducts map at book time.
   */
  productId: string | null;
  /**
   * Flat list of (heat block, racer) tuples. N racers × M heats per racer
   * = N*M entries on the combined BMI bill. 3-pack day-of products require
   * 3 heats per assignedTo party member. Heat-conflict validation runs
   * per-assignedTo within the array.
   */
  heats: RaceHeatAssignment[];
}

export interface AttractionItem extends BookingItemBase {
  kind: "attraction";
  /** "gel-blaster" | "laser-tag" | "duck-pin" | "shuffly". */
  slug: string | null;
  date: string | null;
  slot: string | null;
  qty: number;
  /**
   * Party members on this attraction line. Universal: even per-slot
   * attractions (duck-pin, shuffly) track who's playing for the BMI
   * bill roster. For per-person attractions (gel-blaster, laser-tag),
   * assignedTo.length typically matches qty.
   */
  assignedTo: string[];
}

export interface BowlingItem extends BookingItemBase {
  kind: "bowling";
  /** open = walk-in style; hourly = per-lane reservation. */
  variant: "open" | "hourly";
  date: string | null;
  hour: number | null;
  laneCount: number;
  /** Party members playing — feeds the Conq reservation roster (not BMI bill). */
  assignedTo: string[];
}

export interface KbfItem extends BookingItemBase {
  kind: "kbf";
  /** KBF pass member ids (from kbf_pass_members). A DIFFERENT roster
   *  from session.party — KBF passes have their own membership tables. */
  bowlers: number[];
  slot: string | null;
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
 * KBF identity state — populated ONLY when at least one KbfItem exists
 * in session.items[]. Cleared by the reducer when the last KbfItem is
 * removed from the cart. The identity step verifies once per session;
 * additional KbfItems reuse the verified pass.
 */
export interface KbfIdentityState {
  phase: "lookup" | "verify" | "verified";
  emailOrPhone: string;
  passId: number | null;
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
      return { id, kind: "race", date: null, productId: null, heats: [] };
    case "attraction":
      return {
        id,
        kind: "attraction",
        slug: null,
        date: null,
        slot: null,
        qty: 1,
        assignedTo: [],
      };
    case "bowling":
      return {
        id,
        kind: "bowling",
        variant: "open",
        date: null,
        hour: null,
        laneCount: 1,
        assignedTo: [],
      };
    case "kbf":
      return {
        id,
        kind: "kbf",
        bowlers: [],
        slot: null,
        paidAdults: 0,
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
}): PartyMember {
  return {
    id: newItemId(),
    firstName: args.firstName,
    lastName: args.lastName,
    bmiPersonId: args.bmiPersonId,
    isNewRacer: args.isNewRacer ?? true,
    category: args.category,
    isBillingCustomer: args.isBillingCustomer,
  };
}

/** Build a fresh KBF identity state in its initial lookup phase. */
export function newKbfIdentity(): KbfIdentityState {
  return { phase: "lookup", emailOrPhone: "", passId: null };
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
