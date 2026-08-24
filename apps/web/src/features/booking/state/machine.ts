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
import type { AppliedVoucherState } from "./types";
import { qamfCenterIdForCode, type CenterCode, type ContactInfo } from "../types";
import { packSkusForRaceDate } from "../service/race-pack-kiosk";
import { getPackage, packageFitsRaceDate } from "@/lib/packages";
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";
import {
  hasKbfItem,
  newKbfIdentity,
  type BookingSession,
  type GameCardCartPurchase,
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

  /* ── signer-only guardians (kiosk) ──────────────────────────── */
  /** Append a guardian (adult who signs a minor's waiver, not purchasing). */
  | { type: "addGuardian"; member: PartyMember }
  /** Patch an existing guardian entry. */
  | { type: "updateGuardian"; id: string; patch: Partial<PartyMember> }
  /** Remove a guardian entry. No cascades — guardians are never assigned to items. */
  | { type: "removeGuardian"; id: string }

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
  | { type: "applyVoucher"; voucher: AppliedVoucherState }
  /** No itemIndex = drop every leg of the code; with itemIndex = drop ONE
   *  native leg (kiosk per-leg ✕) and leave the code's other legs applied. */
  | { type: "removeVoucher"; code: string; itemIndex?: number }
  /**
   * Stamp (or clear) the session's combo-special id. Intended to fire ONCE
   * at session creation by the /book/combo/[id]/v2 entry seeding — same
   * contract as `applyPromo`.
   */
  | { type: "setComboSpecial"; id: string | null }
  | { type: "setPreferredPackage"; id: string | null }
  /**
   * KIOSK: attach (or clear) the Game Zone cards riding this cart — paid with
   * the booking deposit at the shared checkout (see types.GameCardCartPurchase).
   */
  | { type: "setGameCardPurchase"; purchase: GameCardCartPurchase | null }

  /* ── bowling holds ─────────────────────────────────────────────── */
  /**
   * Adopt the v3 single-time-pick bowling flow preview opt-in into an
   * EXISTING session. Context is normally seeded only at session creation, so
   * `?bowlingV3=1` on a browser with a persisted session would be silently
   * ignored (owner hit this on the first preview). Resets bowling/kbf item
   * cursors to 0 — the visible step list changes shape, so a stale cursor
   * would land mid-wizard on the wrong step.
   */
  | { type: "enableBowlingV3" }
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

export function reducer(state: BookingSession, action: Action): BookingSession {
  switch (action.type) {
    /* ──────── cart items ──────── */
    case "addItem": {
      // Stamp the QAMF center on bowling/KBF items from the session center so a
      // Naples booking books Naples (3148) — not a silent Fort Myers default.
      // FastTrax duckpin shares the "fort-myers" CenterCode with HeadPinz FM, so
      // it is resolved from the item's isDuckpin marker → 11542, never from center.
      let item = action.item;
      if (item.kind === "bowling" || item.kind === "kbf") {
        const qamf =
          item.kind === "bowling" && item.isDuckpin
            ? FASTTRAX_QAMF_CENTER_ID
            : qamfCenterIdForCode(state.center);
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
        items: state.items.map((i) => {
          if (i.id !== action.id) return i;
          const next = { ...i, ...action.patch } as SessionItem;
          // A race DATE change re-validates pack picks against the new day —
          // a weekday pack pointed at a Fri–Sun race would otherwise sail to
          // reserve and fail-closed there as an opaque 400 (web can reach
          // Back → change date; the kiosk never re-dates). Dropping only the
          // now-ineligible slugs keeps valid picks.
          if (
            next.kind === "race" &&
            "date" in action.patch &&
            next.date &&
            (next.creditPacks?.length ?? 0) > 0
          ) {
            const offered = new Set(packSkusForRaceDate(next.date).map((p) => p.slug));
            const kept = (next.creditPacks ?? []).filter((p) => offered.has(p.slug));
            next.creditPacks = kept.length > 0 ? kept : undefined;
          }
          // Same re-validation for a PACKAGE pick, against the bundle's own
          // recurring day rule (`raceDays` — BOGO runs on Wednesday RACES). A
          // bundle picked for a Wednesday and then moved to Thursday would
          // otherwise keep its deal price on a day the deal doesn't run, and
          // unlike the pack case nothing downstream refuses it: the charge path
          // resolves packages by id via `getPackage`, which is deliberately NOT
          // window-gated (expiring one there drops the heats from the Square
          // lines while BMI still books them at $0 — see lib/packages.ts).
          // Clearing the pointer sends the guest back through the picker, which
          // is the only fail-safe direction available here.
          //
          // Bundles with no `raceDays` (every standing one) always fit, so this
          // cannot disturb an Ultimate Qualifier or Rookie Pack pick.
          if (next.kind === "race" && "date" in action.patch && next.date) {
            for (const field of ["packageIdAdult", "packageIdJunior"] as const) {
              const pkg = getPackage(next[field]);
              if (pkg && !packageFitsRaceDate(pkg, next.date)) next[field] = null;
            }
          }
          return next;
        }),
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

    /* ──────── signer-only guardians (kiosk) ──────── */
    case "addGuardian":
      return { ...state, guardians: [...(state.guardians ?? []), action.member] };

    case "updateGuardian":
      return {
        ...state,
        guardians: (state.guardians ?? []).map((m) =>
          m.id === action.id ? { ...m, ...action.patch } : m,
        ),
      };

    case "removeGuardian":
      return {
        ...state,
        guardians: (state.guardians ?? []).filter((m) => m.id !== action.id),
      };

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

    case "setCenter": {
      if (action.center === state.center) return state;
      // Switching BETWEEN complexes with a non-empty cart clears it (one center
      // per session). But setting the center for the FIRST time (state.center is
      // null) is an INITIAL selection, not a switch — keep the cart and stamp the
      // QAMF center onto any bowling/KBF items so they book the chosen complex.
      const isSwitch = state.center != null && state.items.length > 0;
      if (isSwitch) {
        return { ...state, center: action.center, items: [], cursors: {}, activeItemId: null };
      }
      const qamf = qamfCenterIdForCode(action.center);
      return {
        ...state,
        center: action.center,
        items: state.items.map((i) => {
          if (i.kind !== "bowling" && i.kind !== "kbf") return i;
          // Never clobber a FastTrax duckpin item's 11542 with the center's id
          // (both live at the "fort-myers" complex).
          if (i.kind === "bowling" && i.isDuckpin)
            return { ...i, qamfCenterId: FASTTRAX_QAMF_CENTER_ID };
          return qamf == null ? i : { ...i, qamfCenterId: qamf };
        }),
      };
    }

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

    case "applyVoucher": {
      // Upsert by (code, itemIndex) — re-scans and pending→applied transitions
      // replace in place; new ones append (scan order preserved for coverage
      // picks). itemIndex matters because ONE native voucher can bundle several
      // items (game card + race), each an independent applied entry under the
      // same code; keying on code alone would collapse them into one. BMI
      // vouchers have no itemIndex, so their key is just the code — unchanged.
      const vkey = (v: AppliedVoucherState) => `${v.code}::${v.itemIndex ?? ""}`;
      const list = state.appliedVouchers ?? [];
      const target = vkey(action.voucher);
      const i = list.findIndex((v) => vkey(v) === target);
      const appliedVouchers =
        i >= 0 ? list.map((v, idx) => (idx === i ? action.voucher : v)) : [...list, action.voucher];
      return { ...state, appliedVouchers };
    }

    case "removeVoucher":
      return {
        ...state,
        appliedVouchers: (state.appliedVouchers ?? []).filter(
          (v) =>
            v.code !== action.code ||
            (action.itemIndex != null && v.itemIndex !== action.itemIndex),
        ),
      };

    case "setComboSpecial": {
      if (action.id == null) {
        const next = { ...state };
        delete next.comboSpecialId;
        return next;
      }
      return { ...state, comboSpecialId: action.id };
    }

    case "setPreferredPackage": {
      if (action.id == null) {
        const next = { ...state };
        delete next.preferredPackageId;
        return next;
      }
      return { ...state, preferredPackageId: action.id };
    }

    case "setGameCardPurchase": {
      if (action.purchase == null) {
        const next = { ...state };
        delete next.gameCardPurchase;
        return next;
      }
      return { ...state, gameCardPurchase: action.purchase };
    }

    /* ──────── bowling holds ──────── */
    case "enableBowlingV3": {
      if (state.context?.bowlingV3) return state;
      const cursors = { ...state.cursors };
      for (const it of state.items) {
        if (it.kind === "bowling" || it.kind === "kbf") cursors[it.id] = 0;
      }
      return { ...state, context: { ...state.context, bowlingV3: true }, cursors };
    }
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
