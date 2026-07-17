/**
 * Kiosk step registry — starts as a clone of the web wizard's STEP_REGISTRY
 * (the flows ARE the web flows; the kiosk is a presentation shell). Later
 * kiosk stages override individual entries here (first-available time steps,
 * required bowling details, who's-playing/waivers) WITHOUT ever touching the
 * web registry — zero risk to the live booking flow.
 */
import { STEP_REGISTRY, type SessionItem, type StepDef } from "~/features/booking";
import { KioskSlotStep } from "../steps/KioskSlotStep";
import { KioskBowlingDetailsStep } from "../steps/KioskBowlingDetailsStep";
import { KioskBowlingTimeStep } from "../steps/KioskBowlingTimeStep";
import { KioskRacePeopleStep, KioskAttractionPeopleStep } from "../steps/KioskPeopleStep";

export const KIOSK_SCHEMA_VERSION = 7; // v7: unified people step (racing + attraction)
export const KIOSK_SESSION_STORAGE_KEY = "kiosk_booking_session";

/** Match the web registry's World Cup gating for bowling time steps. */
function hiddenForWorldCup(step: StepDef): StepDef {
  return {
    ...step,
    isVisible: (item, session) =>
      !(item.kind === "bowling" && (item as { isWorldCup?: boolean }).isWorldCup) &&
      step.isVisible(item, session),
  };
}

/** Replace the entry whose id matches with `step` (keeps position). */
function replaceStep(steps: StepDef[], id: string, step: StepDef): StepDef[] {
  return steps.map((s) => (s.id === id ? step : s));
}

/** Combo bowling items are configured programmatically — hide kiosk-added
 *  bowling steps on combo sessions, matching the web registry's gating. */
function hiddenInCombo(step: StepDef): StepDef {
  return {
    ...step,
    isVisible: (item, session) => !session.comboSpecialId && step.isVisible(item, session),
  };
}

/** Insert `step` right after the entry with `afterId` (append if not found). */
function insertAfter(steps: StepDef[], afterId: string, step: StepDef): StepDef[] {
  const idx = steps.findIndex((s) => s.id === afterId);
  if (idx < 0) return [...steps, step];
  return [...steps.slice(0, idx + 1), step, ...steps.slice(idx + 1)];
}

export const KIOSK_STEP_REGISTRY: Record<SessionItem["kind"], StepDef[]> = {
  // Kiosk = walk-up: no race date step — KioskFlow stamps item.date = today
  // at creation; the (fully reused) heat picker then shows today's heats,
  // sorted earliest-first with the complete restriction-rule gating.
  //
  // Identity is now a per-PERSON people list (KioskRacePeopleStep, id
  // "race-party"): new + returning racers mix in one transaction, each set up
  // with a real account + waiver right here (owner rule). The item-level
  // new/returning fork (race-experience) is dropped — the product/heat steps
  // read session.party (isNewRacer/memberships/category) directly and already
  // span tiers for a mixed party, Starter-gating the new racers at heats.
  race: replaceStep(
    // Drop the web combo OVERVIEW step (combo-intro) — the kiosk shows its own
    // readable KioskVipOverview BEFORE the flow, so the in-flow one was a
    // duplicate (owner: "not sure why we have two steps").
    STEP_REGISTRY.race.filter(
      (s) => s.id !== "race-date" && s.id !== "race-experience" && s.id !== "combo-intro",
    ),
    "race-party",
    KioskRacePeopleStep as StepDef,
  ),
  // Kiosk = walk-up: no date step (always today). LEAD with the same people
  // list (owner: "add people new or returning", not a bare YOUR INFO form) —
  // it self-hides for duckpin, so duckpin stays contact → product → slot.
  // Contact still follows (email/phone for the receipt + BMI bill); the slot
  // step leads with the next available time and keeps the grid as "later".
  attraction: [
    KioskAttractionPeopleStep as StepDef,
    ...STEP_REGISTRY.attraction.filter(
      (s) => s.id !== "attraction-date" && s.id !== "attraction-slot",
    ),
    KioskSlotStep as StepDef,
  ],
  // Kiosk rules: today-only "bowl now" time step (replaces the calendar), and
  // names/shoe sizes/bumpers REQUIRED in-flow (web collects them post-booking).
  bowling: insertAfter(
    replaceStep(
      [...STEP_REGISTRY.bowling],
      "bowling-slots",
      hiddenInCombo(hiddenForWorldCup(KioskBowlingTimeStep as StepDef)),
    ),
    "bowling-shoes",
    hiddenInCombo(KioskBowlingDetailsStep as StepDef),
  ),
  kbf: insertAfter(
    replaceStep([...STEP_REGISTRY.kbf], "bowling-slots", KioskBowlingTimeStep as StepDef),
    "bowling-shoes",
    KioskBowlingDetailsStep as StepDef,
  ),
};
