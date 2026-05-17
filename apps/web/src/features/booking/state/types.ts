/**
 * Booking SESSION — multi-activity cart anchored by one Square Order.
 *
 * A session is what the customer is working on right now: it may contain
 * one race heat, plus a bowling lane, plus a gel-blaster slot — all rolled
 * up into a single Square Order and a single payment. Universal-multi-park
 * model. Started by entering ANY activity URL; grown by "add another
 * activity" cross-sell tiles in the cart view.
 *
 * Architectural rules baked in here (and recorded in project memory):
 *   - One Square Order per session. squareOrderId is created lazily.
 *   - One CENTER per session. Cart can mix activities from FT and HP
 *     building sides as long as both live in the same physical complex.
 *     Changing center clears the cart.
 *   - Brand (entryBrand) is captured ONCE at session creation and never
 *     mutates. Drives theming + shuffly's FT-side / HP-side resolution.
 *   - Cart holds SessionItem[]. In PR-B2 every item is a BookingItem.
 *     Future credit-pack purchases (race-pack, memberships, gift cards)
 *     join the union as a separate `kind` when PR-B4 lands.
 */
import type { Activity, Brand, CenterCode, ContactInfo } from "../types";
import type { EntryContext } from "./entry-context";

/** Fields shared by every booking item — vendor reservation needed. */
interface BookingItemBase {
  /** Local id for cart manipulation. Stable across the session. */
  id: string;
  /** Set after we POST to Square / vendor for this specific item. */
  bookedLineId: string | null;
}

export interface RaceItem extends BookingItemBase {
  kind: "race";
  /** BMI personId (raw string — see @ft/db.stringifyWithRawIds). */
  personId: string | null;
  partySize: number | null;
  date: string | null; // YYYY-MM-DD
  productId: string | null;
  /** Picked heat (from BMI availability). */
  heatId: string | null;
}

export interface AttractionItem extends BookingItemBase {
  kind: "attraction";
  /** "gel-blaster" | "laser-tag" | "duck-pin" | "shuffly". */
  slug: string | null;
  date: string | null;
  slot: string | null;
  qty: number;
}

export interface BowlingItem extends BookingItemBase {
  kind: "bowling";
  /** open = walk-in style; hourly = per-lane reservation. */
  variant: "open" | "hourly";
  date: string | null;
  hour: number | null;
  laneCount: number;
}

export interface KbfItem extends BookingItemBase {
  kind: "kbf";
  /** Composite "Verify" step — lookup → 6-digit → roster. */
  identity: {
    phase: "lookup" | "verify" | "verified";
    emailOrPhone: string;
    /** Pass id from `kbf_passes` once verified. */
    passId: number | null;
  };
  /** Roster of bowlers (member ids from kbf_pass_members). */
  bowlers: number[];
  slot: string | null;
  /** Number of paying adults (for shoes / lane add-ons). */
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

export interface BookingSession {
  /** Lazy — created when the first item is committed to Square. */
  squareOrderId: string | null;
  /** Captured at session start from the entry URL's host or first activity. */
  entryBrand: Brand;
  /** Physical complex. Locked once the first item picks one; clears cart on change. */
  center: CenterCode | null;
  /** Session-wide contact (collected near payment, shared across items). */
  contact: Partial<ContactInfo>;
  /** Prefilled data carried in via URL params, cookies, auth. */
  context: EntryContext;
  /** Items in the cart, in insertion order. */
  items: SessionItem[];
  /**
   * Id of the item currently being edited in a sub-wizard.
   * `null` = customer is on the session-level cart view.
   */
  activeItemId: string | null;
  /** Per-item step cursor: { [itemId]: stepIndex }. */
  cursors: Record<string, number>;
}

/** Build a fresh session given the entry brand and any prefilled context. */
export function emptySession(args: { entryBrand: Brand; context?: EntryContext }): BookingSession {
  return {
    squareOrderId: null,
    entryBrand: args.entryBrand,
    center: null,
    contact: args.context?.prefilledContact ?? {},
    context: args.context ?? {},
    items: [],
    activeItemId: null,
    cursors: {},
  };
}

/** Build a fresh item for an activity. Caller assigns it into the session. */
export function newItem(activity: Activity): SessionItem {
  const id = newItemId();
  const base = { id, bookedLineId: null } as const;
  switch (activity) {
    case "race":
      return {
        ...base,
        kind: "race",
        personId: null,
        partySize: null,
        date: null,
        productId: null,
        heatId: null,
      };
    case "attraction":
      return { ...base, kind: "attraction", slug: null, date: null, slot: null, qty: 1 };
    case "bowling":
      return { ...base, kind: "bowling", variant: "open", date: null, hour: null, laneCount: 1 };
    case "kbf":
      return {
        ...base,
        kind: "kbf",
        identity: { phase: "lookup", emailOrPhone: "", passId: null },
        bowlers: [],
        slot: null,
        paidAdults: 0,
      };
  }
}

/** Look up an item by id. Throws if missing — caller must know the item exists. */
export function getItem(session: BookingSession, id: string): SessionItem {
  const item = session.items.find((i) => i.id === id);
  if (!item) throw new Error(`No session item with id ${id}`);
  return item;
}

/** Resolve the currently active item (or null if customer is on the cart view). */
export function getActiveItem(session: BookingSession): SessionItem | null {
  if (!session.activeItemId) return null;
  return session.items.find((i) => i.id === session.activeItemId) ?? null;
}

function newItemId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `item_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  );
}
