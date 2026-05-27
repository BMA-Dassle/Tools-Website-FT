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
import {
  RaceProductStepAdult,
  RaceProductStepJunior,
} from "~/components/features/booking/steps/race/RaceProductStep";
import {
  RaceHeatPickerStepAdult,
  RaceHeatPickerStepJunior,
} from "~/components/features/booking/steps/race/RaceHeatPickerStep";
import { RacePovStep } from "~/components/features/booking/steps/race/RacePovStep";
import { RaceAddonsStep } from "~/components/features/booking/steps/race/RaceAddonsStep";
import {
  AttractionProductStep,
  AttractionDateStep,
  AttractionSlotStep,
} from "~/components/features/booking/steps/attraction";

/**
 * Default per-kind step lists. Real race components live in
 * `components/features/booking/steps/race/`; non-race kinds use
 * placeholders until their PR ships (PR-B3 attractions, PR-B5 bowling,
 * PR-B6 kbf).
 */
export const STEP_REGISTRY: Record<SessionItem["kind"], StepDef[]> = {
  race: [
    // v1 parity: v1's race wizard order is
    //   experience → party → date → product → heat → pov → addons → contact → summary
    // v2 collapses `experience` into the per-member roster inside RacePartyStep
    // (party members carry isNewRacer themselves) and moves contact + summary
    // out to session-level steps launched from CartView at checkout time.
    // Product + Heat split into Adult/Junior variants gated by isVisible so a
    // single-category party only sees its own pair — same UX outcome as v1's
    // internal bookingCategory cycling.
    RacePartyStep as StepDef,
    RaceDateStep as StepDef,
    RaceProductStepAdult as StepDef,
    RaceHeatPickerStepAdult as StepDef,
    RaceProductStepJunior as StepDef,
    RaceHeatPickerStepJunior as StepDef,
    RacePovStep as StepDef,
    RaceAddonsStep as StepDef,
    // License (auto-sold during BMI bookHeat) + Contact + Pay are NOT per-item
    // steps — they live at checkout (commit 10).
  ],
  attraction: [
    AttractionProductStep as StepDef,
    AttractionDateStep as StepDef,
    AttractionSlotStep as StepDef,
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
