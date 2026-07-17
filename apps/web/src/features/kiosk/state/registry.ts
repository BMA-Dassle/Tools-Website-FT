/**
 * Kiosk step registry — starts as a clone of the web wizard's STEP_REGISTRY
 * (the flows ARE the web flows; the kiosk is a presentation shell). Later
 * kiosk stages override individual entries here (first-available time steps,
 * required bowling details, who's-playing/waivers) WITHOUT ever touching the
 * web registry — zero risk to the live booking flow.
 */
import { STEP_REGISTRY, type SessionItem, type StepDef } from "~/features/booking";
import { KioskSlotStep } from "../steps/KioskSlotStep";

export const KIOSK_SCHEMA_VERSION = 2; // v2: attraction date+slot → KioskSlotStep (book-now)
export const KIOSK_SESSION_STORAGE_KEY = "kiosk_booking_session";

export const KIOSK_STEP_REGISTRY: Record<SessionItem["kind"], StepDef[]> = {
  race: [...STEP_REGISTRY.race],
  // Kiosk = walk-up: no date step (always today); the slot step leads with
  // the next available time and keeps the full web grid as "later today".
  attraction: STEP_REGISTRY.attraction
    .filter((s) => s.id !== "attraction-date" && s.id !== "attraction-slot")
    .concat([KioskSlotStep as StepDef]),
  bowling: [...STEP_REGISTRY.bowling],
  kbf: [...STEP_REGISTRY.kbf],
};
