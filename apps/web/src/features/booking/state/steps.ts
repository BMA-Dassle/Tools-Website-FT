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
import { bowlingV3Active } from "../flags";

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
    /**
     * Ask the wizard to advance as if the guest pressed the footer Next —
     * routed through the host's FULL handleNext (canAdvance gate, kiosk
     * unracered sheet, advance-time booking/POV/memo), never a raw
     * dispatch("next"). Used by the package heat picker to auto-advance the
     * moment the final component's hold lands (owner 2026-07-19 — pick, pick,
     * done; no Confirm tap). Optional: hosts that don't support it omit it.
     */
    requestAdvance?: () => void;
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
import {
  RaceExperienceStep,
  RacePartyStep,
} from "~/components/features/booking/steps/race/RacePartyStep";
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
import BowlingDateStep from "~/components/features/booking/steps/bowling/BowlingDateStep";
import BowlingExperienceStep from "~/components/features/booking/steps/bowling/BowlingExperienceStep";
import BowlingTimeStep from "~/components/features/booking/steps/bowling/BowlingTimeStep";
import BowlingShoesStep from "~/components/features/booking/steps/bowling/BowlingShoesStep";
import BowlingFoodStep from "~/components/features/booking/steps/bowling/BowlingFoodStep";
import WorldCupMatchStep from "~/components/features/booking/steps/bowling/WorldCupMatchStep";
import KbfIdentityStep from "~/components/features/booking/steps/bowling/KbfIdentityStep";
import KbfBowlersStep from "~/components/features/booking/steps/bowling/KbfBowlersStep";
import {
  ComboIntroStep,
  ComboItineraryStep,
  ComboStartTimeStep,
} from "~/components/features/booking/steps/combo/ComboSteps";

/**
 * Hide a step on combo-special sessions. The combo runs its OWN guided flow
 * (ComboStartTimeStep + ComboItineraryStep — the customer picks one start
 * time, the system schedules the rest), so the per-kind product/heat picker
 * steps and the whole bowling wizard are suppressed; the bowling item is
 * configured programmatically. Also kills the package upsell mid-combo (no
 * product step = no Rookie Pack / Ultimate Qualifier cards).
 */
function hiddenInCombo(step: StepDef): StepDef {
  return {
    ...step,
    isVisible: (item, session) => !session.comboSpecialId && step.isVisible(item, session),
  };
}

/**
 * Hide a step for World Cup match-mode bowling items (?experience=world-cup).
 * The World Cup entry replaces the date/hour + tier + offer steps with
 * WorldCupMatchStep — a fixture picker pinned to match kickoffs (VIP only,
 * fixed 2.5-hr window). Contact/Players/Shoes run unchanged; Food already
 * self-hides (pizza-bowl slug gate).
 */
function hiddenForWorldCup(step: StepDef): StepDef {
  return {
    ...step,
    isVisible: (item, session) =>
      !(item.kind === "bowling" && (item as { isWorldCup?: boolean }).isWorldCup) &&
      step.isVisible(item, session),
  };
}

/**
 * Hide a step for FastTrax duckpin bowling items (isDuckpin). Duckpin has a
 * single non-VIP offer (skip the Tier step) and no shoes (skip the Shoes step),
 * without affecting HeadPinz. HeadPinz items (isDuckpin falsy) are unchanged.
 */
export function hiddenForDuckpin(step: StepDef): StepDef {
  return {
    ...step,
    isVisible: (item, session) =>
      !(item.kind === "bowling" && (item as { isDuckpin?: boolean }).isDuckpin) &&
      step.isVisible(item, session),
  };
}

/**
 * Single-time-pick bowling flow (v3) coexistence wrappers (2026-07-19).
 * The classic Slots→Tier→Offer steps and the v3 Date→Experience→Time steps
 * BOTH live in the registry; exactly one set is visible per session, keyed
 * off the dark flag / `?bowlingV3=1` preview param. Because context is
 * seeded at session creation, a session never switches flows mid-flight —
 * cursors stay consistent within the visible-filtered list. Exported for
 * the kiosk registry, whose step replacements must gate identically.
 */
export function v3Only(step: StepDef): StepDef {
  return {
    ...step,
    isVisible: (item, session) => bowlingV3Active(session) && step.isVisible(item, session),
  };
}
export function classicOnly(step: StepDef): StepDef {
  return {
    ...step,
    isVisible: (item, session) => !bowlingV3Active(session) && step.isVisible(item, session),
  };
}

/**
 * Default per-kind step lists. Real race components live in
 * `components/features/booking/steps/race/`; non-race kinds use
 * placeholders until their PR ships (PR-B3 attractions, PR-B5 bowling,
 * PR-B6 kbf).
 */
export const STEP_REGISTRY: Record<SessionItem["kind"], StepDef[]> = {
  race: [
    // Combo specials open with an OVERVIEW step (owner ask) — what the
    // Ultimate VIP Experience is, the 1-2-3 itinerary, what's included.
    // Combo-gated, so the normal race flow is untouched.
    ComboIntroStep as StepDef,
    // New vs returning racer — its own step so the wizard Back/Next navigate it.
    RaceExperienceStep as StepDef,
    RacePartyStep as StepDef,
    // Contact right after the party/login step: a returning racer's verified
    // lookup pre-fills it, and it's still BEFORE the first heat books (so the
    // customer attaches at bill creation). Required — see ContactStep.
    ContactStep,
    RaceDateStep as StepDef,
    // Combo specials replace the product/heat pickers with the guided
    // itinerary (start time → schedule); both sets are isVisible-gated on
    // session.comboSpecialId so exactly one set renders.
    hiddenInCombo(RaceProductStepAdult as StepDef),
    hiddenInCombo(RaceHeatPickerStepAdult as StepDef),
    hiddenInCombo(RaceProductStepJunior as StepDef),
    hiddenInCombo(RaceHeatPickerStepJunior as StepDef),
    ComboStartTimeStep as StepDef,
    ComboItineraryStep as StepDef,
    // Combo price INCLUDES license + POV (registry flags) — the upsell step
    // is hidden and the combo flow auto-sets povQuantity.
    hiddenInCombo(RacePovStep as StepDef),
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
    // The whole list is combo-hidden: a combo's bowling item is configured
    // programmatically by the combo steps (the cart hides its Edit too).
    hiddenInCombo(ContactStep),
    hiddenInCombo(BowlingPlayersStep as StepDef),
    // World Cup mode: the match picker replaces Slots/Tier/Offer (it holds
    // the lane at the fixture kickoff itself); its own isVisible gates on
    // item.isWorldCup so plain bowling items never see it.
    hiddenInCombo(WorldCupMatchStep as StepDef),
    // Classic flow (flag OFF): date+hour → tier → package+time-confirm.
    hiddenInCombo(hiddenForWorldCup(classicOnly(BowlingSlotsStep as StepDef))),
    // Duckpin has a single non-VIP offer — skip the Tier (Regular/VIP) step.
    hiddenInCombo(hiddenForWorldCup(hiddenForDuckpin(classicOnly(BowlingTierStep as StepDef)))),
    hiddenInCombo(hiddenForWorldCup(classicOnly(BowlingOfferStep as StepDef))),
    // v3 single-time-pick flow (flag ON): date → experience → time+hold.
    hiddenInCombo(hiddenForWorldCup(v3Only(BowlingDateStep as StepDef))),
    hiddenInCombo(hiddenForWorldCup(v3Only(BowlingExperienceStep as StepDef))),
    hiddenInCombo(hiddenForWorldCup(v3Only(BowlingTimeStep as StepDef))),
    // FastTrax duckpin has no shoes — skip the shoe-rental step (kiosk clones
    // this list, so this hides it on both web and kiosk).
    hiddenInCombo(hiddenForDuckpin(BowlingShoesStep as StepDef)),
    // Attractions step removed — user returns to activity picker and
    // adds attractions as separate cart items.
    hiddenInCombo(BowlingFoodStep as StepDef),
  ],
  kbf: [
    KbfIdentityStep as StepDef,
    KbfBowlersStep as StepDef,
    classicOnly(BowlingSlotsStep as StepDef),
    classicOnly(BowlingTierStep as StepDef),
    classicOnly(BowlingOfferStep as StepDef),
    v3Only(BowlingDateStep as StepDef),
    v3Only(BowlingExperienceStep as StepDef),
    v3Only(BowlingTimeStep as StepDef),
    BowlingShoesStep as StepDef,
  ],
};
