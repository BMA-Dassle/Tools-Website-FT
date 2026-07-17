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

export const KIOSK_SCHEMA_VERSION = 3; // v3: required bowler roster step (names/shoes/bumpers)
export const KIOSK_SESSION_STORAGE_KEY = "kiosk_booking_session";

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
  race: [...STEP_REGISTRY.race],
  // Kiosk = walk-up: no date step (always today); the slot step leads with
  // the next available time and keeps the full web grid as "later today".
  attraction: STEP_REGISTRY.attraction
    .filter((s) => s.id !== "attraction-date" && s.id !== "attraction-slot")
    .concat([KioskSlotStep as StepDef]),
  // Kiosk rule: names/shoe sizes/bumpers are REQUIRED in-flow (web collects
  // them post-booking). Roster lands right after the shoe-rental step.
  bowling: insertAfter(
    [...STEP_REGISTRY.bowling],
    "bowling-shoes",
    hiddenInCombo(KioskBowlingDetailsStep as StepDef),
  ),
  kbf: insertAfter([...STEP_REGISTRY.kbf], "bowling-shoes", KioskBowlingDetailsStep as StepDef),
};
