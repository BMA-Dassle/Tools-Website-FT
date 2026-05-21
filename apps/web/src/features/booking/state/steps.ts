/**
 * Per-item-kind step registry.
 *
 * Each item kind (race, attraction, bowling, kbf) defines an ordered list
 * of StepDef. <BookingFlow> reads this, filters by `isVisible(item)`, and
 * gates Next on `canAdvance(item)`.
 *
 * The session's per-item step cursor (session.cursors[itemId]) drives
 * which step is current; the registry just supplies the list.
 *
 * PR-B2 ships placeholder shells for every kind. Real race components
 * land in commit 8 of PR-B2; attraction / bowling / kbf get their
 * implementations in PR-B3 / B5 / B6 respectively.
 */
import type { ComponentType, Dispatch } from "react";
import type { Action } from "./machine";
import type { BookingItem, BookingSession, SessionItem } from "./types";

/**
 * Props a step component receives:
 *   - item    — the currently active BookingItem (typed to the step's kind).
 *   - session — the whole session (for reading party roster, kbfIdentity, etc.).
 *   - onChange — shallow-merges a patch into the active item (the common case).
 *   - dispatch — the reducer dispatcher. Use this when the step needs to write
 *                SESSION-LEVEL state (party roster, kbfIdentity, contact, etc.)
 *                instead of mutating the active item. Steps should prefer
 *                onChange for per-item patches.
 */
export interface StepDef<I extends BookingItem = BookingItem> {
  /** Stable id for breadcrumb + URL hash sync. */
  id: string;
  /** User-facing title. */
  title: string;
  Component: ComponentType<{
    item: I;
    session: BookingSession;
    onChange: (patch: Partial<I>) => void;
    dispatch: Dispatch<Action>;
  }>;
  /** Hide the step entirely when this returns false. */
  isVisible: (item: I, session: BookingSession) => boolean;
  /**
   * Gate the Next button. Return `true` to allow advance, or
   * `{ reason }` to display a hint.
   */
  canAdvance: (item: I, session: BookingSession) => true | { reason: string };
}

/** Placeholder step used while real per-kind components land. */
function makePlaceholder<I extends BookingItem>(id: string, title: string): StepDef<I> {
  return {
    id,
    title,
    Component: () => null,
    isVisible: () => true,
    canAdvance: () => true,
  };
}

// Real race step components — PR-B2 commit 9a ships Date + Party; commit 9b
// fills in Product / HeatPicker / License / Review.
import { RaceDateStep } from "~/components/features/booking/steps/race/RaceDateStep";
import { RacePartyStep } from "~/components/features/booking/steps/race/RacePartyStep";
import { RaceProductStep } from "~/components/features/booking/steps/race/RaceProductStep";

/**
 * Default per-kind step lists. Real race components live in
 * `components/features/booking/steps/race/`; non-race kinds use
 * placeholders until their PR ships (PR-B3 attractions, PR-B5 bowling,
 * PR-B6 kbf).
 */
export const STEP_REGISTRY: Record<SessionItem["kind"], StepDef[]> = {
  race: [
    RaceDateStep as StepDef,
    RacePartyStep as StepDef,
    RaceProductStep as StepDef,
    makePlaceholder("race-heat", "Heat"),
    makePlaceholder("race-license", "License"),
    makePlaceholder("race-review", "Review"),
  ],
  attraction: [
    makePlaceholder("date", "Date"),
    makePlaceholder("slot", "Slot"),
    makePlaceholder("party", "Party"),
    makePlaceholder("review", "Review"),
  ],
  bowling: [
    makePlaceholder("date", "Date"),
    makePlaceholder("slot", "Time"),
    makePlaceholder("lanes", "Lanes"),
    makePlaceholder("addons", "Shoes & Add-ons"),
    makePlaceholder("review", "Review"),
  ],
  kbf: [
    // Composite "Verify" step: lookup → 6-digit → roster. Breadcrumb shows
    // one tick. Sub-state lives in item.identity.phase.
    makePlaceholder("identity", "Verify"),
    makePlaceholder("slot", "Time"),
    makePlaceholder("bowlers", "Bowlers"),
    makePlaceholder("addons", "Shoes & Add-ons"),
    makePlaceholder("review", "Review"),
  ],
};
