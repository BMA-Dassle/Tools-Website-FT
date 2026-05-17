/**
 * Booking state machine — a thin reducer over the multi-item BookingSession.
 *
 * No XState. Sessions hold a list of items, an active-item cursor (or null
 * for "on the cart view"), and a per-item step cursor. Transitions are
 * mostly linear-with-skips inside each item's sub-wizard; the registry in
 * steps.ts decides ordering and gating.
 *
 * The reducer NEVER destroys data on back-nav — only cursors move.
 * Switching center is the one exception: it clears `items` because a
 * Naples cart can't legally hold a Fort Myers booking and vice versa.
 *
 * Each step component dispatches `updateItem` to patch the active item's
 * identity fields. Cross-item things (contact, center, squareOrderId)
 * dispatch their own dedicated actions.
 */
import type { CenterCode, ContactInfo } from "../types";
import type { BookingSession, SessionItem } from "./types";

export type Action =
  /** Add a new item to the cart and make it active. */
  | { type: "addItem"; item: SessionItem }
  /** Shallow-merge a patch into a specific item. */
  | { type: "updateItem"; id: string; patch: Partial<SessionItem> }
  /** Remove an item from the cart (e.g. customer changed their mind). */
  | { type: "removeItem"; id: string }
  /** Make an item active (open its sub-wizard); null = go to cart view. */
  | { type: "setActiveItem"; id: string | null }
  /** Advance the active item's step cursor by one. canAdvance is the host's job. */
  | { type: "next" }
  /** Back up the active item's step cursor. State preserved. */
  | { type: "back" }
  /** Jump to a specific step within the active item. */
  | { type: "goto"; index: number }
  /** Update session-wide contact (shared across all items). */
  | { type: "setContact"; patch: Partial<ContactInfo> }
  /**
   * Lock the session's center. If switching to a different center than
   * a non-empty cart, the cart clears — items from one complex can't
   * legally book against another.
   */
  | { type: "setCenter"; center: CenterCode | null }
  /** Stash the Square Order id once it's created. */
  | { type: "setSquareOrderId"; id: string | null };

export function reducer(state: BookingSession, action: Action): BookingSession {
  switch (action.type) {
    case "addItem":
      return {
        ...state,
        items: [...state.items, action.item],
        activeItemId: action.item.id,
        cursors: { ...state.cursors, [action.item.id]: 0 },
      };
    case "updateItem":
      // Cast at runtime — the patch is constrained to the active item's
      // kind at the call site (StepDef<I>'s onChange signature guards it).
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.id ? ({ ...i, ...action.patch } as SessionItem) : i,
        ),
      };
    case "removeItem": {
      const nextItems = state.items.filter((i) => i.id !== action.id);
      const { [action.id]: _drop, ...nextCursors } = state.cursors;
      return {
        ...state,
        items: nextItems,
        cursors: nextCursors,
        activeItemId: state.activeItemId === action.id ? null : state.activeItemId,
      };
    }
    case "setActiveItem":
      return { ...state, activeItemId: action.id };
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
  }
}
