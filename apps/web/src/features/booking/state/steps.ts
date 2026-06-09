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
    /**
     * Signal the wizard that the step is mid-async (e.g. an eager BMI hold in
     * flight) so it disables the footer Next button — preventing the customer
     * from advancing (and the advance-time booker double-booking) while a hold
     * is still resolving. Optional: steps that never go busy ignore it.
     */
    setBusy?: (busy: boolean) => void;
  }>;
  /** Hide the step entirely when this returns false. */
  isVisible: (item: I, session: BookingSession) => boolean;
  /**
   * Gate the Next button. Return `true` to allow advance, or
   * `{ reason }` to display a hint.
   */
  canAdvance: (item: I, session: BookingSession) => true | { reason: string };
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
import { ContactStep } from "~/components/features/booking/steps/ContactStep";
import {
  AttractionProductStep,
  AttractionDateStep,
  AttractionSlotStep,
} from "~/components/features/booking/steps/attraction";
import BowlingPlayersStep from "~/components/features/booking/steps/bowling/BowlingPlayersStep";
import BowlingSlotsStep from "~/components/features/booking/steps/bowling/BowlingSlotsStep";
import BowlingTierStep from "~/components/features/booking/steps/bowling/BowlingTierStep";
import BowlingOfferStep from "~/components/features/booking/steps/bowling/BowlingOfferStep";
import BowlingShoesStep from "~/components/features/booking/steps/bowling/BowlingShoesStep";
import BowlingFoodStep from "~/components/features/booking/steps/bowling/BowlingFoodStep";
import KbfIdentityStep from "~/components/features/booking/steps/bowling/KbfIdentityStep";
import KbfBowlersStep from "~/components/features/booking/steps/bowling/KbfBowlersStep";

/**
 * Default per-kind step lists. Real race components live in
 * `components/features/booking/steps/race/`; non-race kinds use
 * placeholders until their PR ships (PR-B3 attractions, PR-B5 bowling,
 * PR-B6 kbf).
 */
export const STEP_REGISTRY: Record<SessionItem["kind"], StepDef[]> = {
  race: [
    RacePartyStep as StepDef,
    // Contact right after the party/login step: a returning racer's verified
    // lookup pre-fills it, and it's still BEFORE the first heat books (so the
    // customer attaches at bill creation). Required — see ContactStep.
    ContactStep,
    RaceDateStep as StepDef,
    RaceProductStepAdult as StepDef,
    RaceHeatPickerStepAdult as StepDef,
    RaceProductStepJunior as StepDef,
    RaceHeatPickerStepJunior as StepDef,
    RacePovStep as StepDef,
    // Add-ons removed — user returns to activity picker after completing
    // race steps and adds attractions as separate cart items.
  ],
  attraction: [
    // Contact first — attraction slots book early (create a BMI bill), so we
    // need the customer before that. Required.
    ContactStep,
    AttractionProductStep as StepDef,
    AttractionDateStep as StepDef,
    AttractionSlotStep as StepDef,
  ],
  bowling: [
    // Contact first so we always capture base customer info. (Bowling/KBF are
    // QAMF-vendored — no BMI bill — but the confirmation/notifications need it.)
    ContactStep,
    BowlingPlayersStep as StepDef,
    BowlingSlotsStep as StepDef,
    BowlingTierStep as StepDef,
    BowlingOfferStep as StepDef,
    BowlingShoesStep as StepDef,
    // Attractions step removed — user returns to activity picker and
    // adds attractions as separate cart items.
    BowlingFoodStep as StepDef,
  ],
  kbf: [
    KbfIdentityStep as StepDef,
    KbfBowlersStep as StepDef,
    BowlingSlotsStep as StepDef,
    BowlingTierStep as StepDef,
    BowlingOfferStep as StepDef,
    BowlingShoesStep as StepDef,
  ],
};
