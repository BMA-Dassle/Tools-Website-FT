/**
 * Booking state machine — a thin reducer over the multi-item BookingSession.
 *
 * No XState. Sessions hold a list of items, a party roster, an active-item
 * cursor, and a per-item step cursor. Per-line assignments reference
 * PartyMember.id; the reducer enforces referential cleanup when a member is
 * removed (cascade-null assignedTo refs so the UI prompts re-assignment).
 *
 * The reducer NEVER destroys data on back-nav — only cursors move.
 * Center changes do clear `items` (cart constraint: one center per session).
 *
 * KBF identity is conditional on having a KbfItem in the cart. Adding a
 * KbfItem auto-initializes session.kbfIdentity to its lookup phase if
 * absent; removing the last KbfItem clears it.
 */
import type { AppliedPromo } from "~/features/discount-codes";
import type { CenterCode, ContactInfo } from "../types";
import {
  hasKbfItem,
  newKbfIdentity,
  type BookingSession,
  type KbfIdentityState,
  type LoyaltyState,
  type PartyMember,
  type RaceHeatAssignment,
  type SessionItem,
} from "./types";

export type Action =
  /* ── cart items ─────────────────────────────────────────────── */
  /** Add a new item to the cart and make it active. */
  | { type: "addItem"; item: SessionItem }
  /** Shallow-merge a patch into a specific item. */
  | { type: "updateItem"; id: string; patch: Partial<SessionItem> }
  /** Remove an item from the cart (e.g. customer changed their mind). */
  | { type: "removeItem"; id: string }
  /** Make an item active (open its sub-wizard); null = go to cart view. */
  | { type: "setActiveItem"; id: string | null }

  /* ── step cursor ────────────────────────────────────────────── */
  /** Advance the active item's step cursor by one. */
  | { type: "next" }
  /** Back up the active item's step cursor. State preserved. */
  | { type: "back" }
  /** Jump to a specific step within the active item. */
  | { type: "goto"; index: number }

  /* ── party roster ───────────────────────────────────────────── */
  /** Append a party member. */
  | { type: "addPartyMember"; member: PartyMember }
  /** Patch an existing party member (fields like firstName, bmiPersonId, etc.). */
  | { type: "updatePartyMember"; id: string; patch: Partial<PartyMember> }
  /**
   * Remove a party member by id. CASCADES: any item assignments referencing
   * this member are unassigned (race heats → null, attraction/bowling
   * assignedTo[] → filtered). UI re-prompts for assignment.
   */
  | { type: "removePartyMember"; id: string }

  /* ── race heat assignments ──────────────────────────────────── */
  /** Append a heat to a RaceItem's heats[]. */
  | { type: "addHeat"; itemId: string; heat: RaceHeatAssignment }
  /** Update one heat in a RaceItem's heats[] by index. */
  | { type: "updateHeat"; itemId: string; heatIndex: number; patch: Partial<RaceHeatAssignment> }
  /** Remove one heat from a RaceItem's heats[] by index. */
  | { type: "removeHeat"; itemId: string; heatIndex: number }

  /* ── session-wide identity / anchors ────────────────────────── */
  /** Update session-wide contact (the BILLING customer; shared across items). */
  | { type: "setContact"; patch: Partial<ContactInfo> }
  /**
   * Lock the session's center. Switching to a different center clears items
   * (cart constraint: one center per session). Party + contact preserved.
   */
  | { type: "setCenter"; center: CenterCode | null }
  /** Stash the Square Order id once it's created. */
  | { type: "setSquareOrderId"; id: string | null }
  /** Stash the combined BMI bill id once first BMI line books. */
  | { type: "setBmiBillId"; id: string | null }
  /** Merge fields into session.kbfIdentity. Auto-initializes if absent. */
  | { type: "setKbfIdentity"; patch: Partial<KbfIdentityState> }
  /**
   * Capture (or clear) the session-level promo. Intended to fire ONCE at
   * session start. The reducer doesn't enforce that constraint — call sites
   * (the `/book/v2` landing + activity page seeding) are responsible for
   * not mutating mid-flow.
   */
  | { type: "applyPromo"; promo: AppliedPromo | null }

  /* ── bowling holds ─────────────────────────────────────────────── */
  /** Store QAMF temporary reservation info on a bowling/kbf item. */
  | { type: "setBowlingHold"; itemId: string; qamfReservationId: string; qamfCenterId: number }
  /** Clear QAMF hold (expired or released). */
  | { type: "clearBowlingHold"; itemId: string }
  /** Store bowling quote pricing from the quote endpoint. */
  | {
      type: "setBowlingQuote";
      itemId: string;
      dayofOrderId: string;
      totalCents: number;
      depositCents: number;
      discountOffCents?: number;
    }

  /* ── loyalty (HeadPinz Rewards) ────────────────────────────────── */
  /** Set or update the session-level loyalty state. */
  | { type: "setLoyalty"; loyalty: LoyaltyState }
  /** Clear loyalty state (e.g. phone changed). */
  | { type: "clearLoyalty" }
  | { type: "restoreSession"; session: BookingSession };

/** QAMF center id for a CenterCode. Bowling/KBF book against QAMF, so the item
 *  MUST carry the SELECTED center's id — never silently default to one center. */
function qamfCenterIdForCode(center: CenterCode | null): number | null {
  return center === "naples" ? 3148 : center === "fort-myers" ? 9172 : null;
}

export function reducer(state: BookingSession, action: Action): BookingSession {
  switch (action.type) {
    /* ──────── cart items ──────── */
    case "addItem": {
      // Stamp the QAMF center on bowling/KBF items from the session center so a
      // Naples booking books Naples (3148) — not a silent Fort Myers default.
      let item = action.item;
      if (item.kind === "bowling" || item.kind === "kbf") {
        const qamf = qamfCenterIdForCode(state.center);
        if (qamf != null) item = { ...item, qamfCenterId: qamf };
      }
      const next: BookingSession = {
        ...state,
        items: [...state.items, item],
        activeItemId: item.id,
        cursors: { ...state.cursors, [item.id]: 0 },
      };
      if (item.kind === "kbf" && !next.kbfIdentity) {
        next.kbfIdentity = newKbfIdentity();
      }
      return next;
    }

    case "updateItem":
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.id ? ({ ...i, ...action.patch } as SessionItem) : i,
        ),
      };

    case "removeItem": {
      const nextItems = state.items.filter((i) => i.id !== action.id);
      const { [action.id]: _drop, ...nextCursors } = state.cursors;
      const next: BookingSession = {
        ...state,
        items: nextItems,
        cursors: nextCursors,
        activeItemId: state.activeItemId === action.id ? null : state.activeItemId,
      };
      // If the last KBF item just left the cart, drop the session-level
      // KBF identity — KBF state should not persist when no KBF item exists.
      if (!hasKbfItem(next)) {
        delete next.kbfIdentity;
      }
      return next;
    }

    case "setActiveItem":
      return { ...state, activeItemId: action.id };

    /* ──────── step cursor ──────── */
    case "next": {
      if (!state.activeItemId) return state;
      const current = state.cursors[state.activeItemId] ?? 0;
      return { ...state, cursors: { ...state.cursors, [state.activeItemId]: current + 1 } };
    }
    case "back": {
      if (!state.activeItemId) return state;
      const current = state.cursors[state.activeItemId] ?? 0;
      return {
        ...state,
        cursors: { ...state.cursors, [state.activeItemId]: Math.max(0, current - 1) },
      };
    }
    case "goto": {
      if (!state.activeItemId) return state;
      return {
        ...state,
        cursors: { ...state.cursors, [state.activeItemId]: Math.max(0, action.index) },
      };
    }

    /* ──────── party roster ──────── */
    case "addPartyMember":
      return { ...state, party: [...state.party, action.member] };

    case "updatePartyMember":
      return {
        ...state,
        party: state.party.map((m) => (m.id === action.id ? { ...m, ...action.patch } : m)),
      };

    case "removePartyMember": {
      // CASCADE: scrub the dropped id from every item's assigned refs.
      const dropId = action.id;
      const nextItems: SessionItem[] = state.items.map((item) => {
        if (item.kind === "race") {
          return {
            ...item,
            heats: item.heats.map((h) =>
              h.assignedTo === dropId ? { ...h, assignedTo: null } : h,
            ),
          };
        }
        if (item.kind === "attraction" || item.kind === "bowling") {
          if (!item.assignedTo.includes(dropId)) return item;
          return { ...item, assignedTo: item.assignedTo.filter((a) => a !== dropId) };
        }
        return item;
      });
      return {
        ...state,
        party: state.party.filter((m) => m.id !== dropId),
        items: nextItems,
      };
    }

    /* ──────── race heat assignments ──────── */
    case "addHeat":
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.itemId && i.kind === "race"
            ? { ...i, heats: [...i.heats, action.heat] }
            : i,
        ),
      };

    case "updateHeat":
      return {
        ...state,
        items: state.items.map((i) => {
          if (i.id !== action.itemId || i.kind !== "race") return i;
          return {
            ...i,
            heats: i.heats.map((h, idx) =>
              idx === action.heatIndex ? { ...h, ...action.patch } : h,
            ),
          };
        }),
      };

    case "removeHeat":
      return {
        ...state,
        items: state.items.map((i) => {
          if (i.id !== action.itemId || i.kind !== "race") return i;
          return { ...i, heats: i.heats.filter((_, idx) => idx !== action.heatIndex) };
        }),
      };

    /* ──────── session-wide ──────── */
    case "setContact":
      return { ...state, contact: { ...state.contact, ...action.patch } };

    case "setCenter":
      if (action.center === state.center) return state;
      // Cart constraint: one center per session. Switching = clear items.
      return {
        ...state,
        center: action.center,
        items: state.items.length === 0 ? state.items : [],
        cursors: state.items.length === 0 ? state.cursors : {},
        activeItemId: state.items.length === 0 ? state.activeItemId : null,
      };

    case "setSquareOrderId":
      return { ...state, squareOrderId: action.id };

    case "setBmiBillId":
      return { ...state, bmiBillId: action.id };

    case "setKbfIdentity":
      return {
        ...state,
        kbfIdentity: { ...(state.kbfIdentity ?? newKbfIdentity()), ...action.patch },
      };

    case "applyPromo":
      return { ...state, appliedPromo: action.promo };

    /* ──────── bowling holds ──────── */
    case "setBowlingHold":
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.itemId && (i.kind === "bowling" || i.kind === "kbf")
            ? {
                ...i,
                qamfReservationId: action.qamfReservationId,
                qamfCenterId: action.qamfCenterId,
              }
            : i,
        ),
      };

    case "clearBowlingHold":
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.itemId && (i.kind === "bowling" || i.kind === "kbf")
            ? { ...i, qamfReservationId: null, qamfCenterId: null }
            : i,
        ),
      };

    case "setBowlingQuote":
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.itemId && (i.kind === "bowling" || i.kind === "kbf")
            ? {
                ...i,
                quoteDayofOrderId: action.dayofOrderId,
                quoteTotalCents: action.totalCents,
                quoteDepositCents: action.depositCents,
                quoteDiscountOffCents: action.discountOffCents ?? 0,
              }
            : i,
        ),
      };

    /* ──────── loyalty ──────── */
    case "setLoyalty":
      return { ...state, loyalty: action.loyalty };

    case "clearLoyalty": {
      const next = { ...state };
      delete next.loyalty;
      return next;
    }

    case "restoreSession":
      return action.session;
  }
}
