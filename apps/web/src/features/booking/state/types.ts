/**
 * Booking draft — discriminated union by activity.
 *
 * The Draft holds IDENTITY SELECTIONS ONLY: what activity, where, when, who.
 * Pricing, line items, modifiers, and cart state live in the Square Order
 * (see tasks/restructure-plan.md § "Cart IS the Square Order"). Anything that
 * comes from a vendor response is read via React Query, not stored here.
 *
 * Each activity branch gets its own fields. Add a new field by editing the
 * union directly — it's the source of truth that drives the reducer + step
 * registry.
 *
 * PR-B1 ships the shells; PR-B2..B6 fill in per-activity logic.
 */
import type { Activity, CenterCode, ContactInfo } from "../types";

/** Common fields every activity carries. */
interface DraftBase {
  /** Square Order id, lazy-created at session start. */
  squareOrderId: string | null;
  /** Center the booking is for. Picked early, used for vendor routing. */
  center: CenterCode | null;
  /** Contact info, collected near payment. */
  contact: Partial<ContactInfo>;
}

export interface RaceDraft extends DraftBase {
  activity: "race";
  /** BMI personId (string — see @ft/db.stringifyWithRawIds for why). */
  personId: string | null;
  partySize: number | null;
  date: string | null; // YYYY-MM-DD
  productId: string | null;
  /** Picked heat (from BMI availability). */
  heatId: string | null;
}

export interface RacePackDraft extends DraftBase {
  activity: "race-pack";
  personId: string | null;
  partySize: number | null;
  date: string | null;
  packId: string | null;
  /** Each component of the pack picks its own heat. */
  componentHeats: { componentId: string; heatId: string | null }[];
}

export interface AttractionDraft extends DraftBase {
  activity: "attraction";
  /** e.g. "gel-blaster", "laser-tag", "duck-pin", "shuffly". */
  slug: string | null;
  date: string | null;
  slot: string | null;
  qty: number;
}

export interface BowlingDraft extends DraftBase {
  activity: "bowling";
  /** open = walk-in style; hourly = per-lane reservation. */
  kind: "open" | "hourly";
  date: string | null;
  hour: number | null;
  laneCount: number;
}

export interface KbfDraft extends DraftBase {
  activity: "kbf";
  /** KBF identity sub-state — drives the composite "Verify" step. */
  identity: {
    phase: "lookup" | "verify" | "verified";
    emailOrPhone: string;
    /** Pass id from `kbf_passes` once verified. */
    passId: number | null;
  };
  /** Roster of bowlers for this session (member ids from kbf_pass_members). */
  bowlers: number[];
  slot: string | null;
  /** Number of paying adults (for shoes / lane add-ons). */
  paidAdults: number;
}

export type Draft = RaceDraft | RacePackDraft | AttractionDraft | BowlingDraft | KbfDraft;

/** Build an empty draft for a given activity. Used when the wizard opens. */
export function emptyDraft(activity: Activity): Draft {
  const base = { squareOrderId: null, center: null, contact: {} } as const;
  switch (activity) {
    case "race":
      return {
        ...base,
        activity,
        personId: null,
        partySize: null,
        date: null,
        productId: null,
        heatId: null,
      };
    case "race-pack":
      return {
        ...base,
        activity,
        personId: null,
        partySize: null,
        date: null,
        packId: null,
        componentHeats: [],
      };
    case "attraction":
      return { ...base, activity, slug: null, date: null, slot: null, qty: 1 };
    case "bowling":
      return { ...base, activity, kind: "open", date: null, hour: null, laneCount: 1 };
    case "kbf":
      return {
        ...base,
        activity,
        identity: { phase: "lookup", emailOrPhone: "", passId: null },
        bowlers: [],
        slot: null,
        paidAdults: 0,
      };
  }
}
