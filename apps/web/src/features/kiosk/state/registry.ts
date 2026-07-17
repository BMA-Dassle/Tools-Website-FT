/**
 * Kiosk step registry — starts as a clone of the web wizard's STEP_REGISTRY
 * (the flows ARE the web flows; the kiosk is a presentation shell). Later
 * kiosk stages override individual entries here (first-available time steps,
 * required bowling details, who's-playing/waivers) WITHOUT ever touching the
 * web registry — zero risk to the live booking flow.
 */
import { STEP_REGISTRY, type SessionItem, type StepDef } from "~/features/booking";

export const KIOSK_SCHEMA_VERSION = 1;
export const KIOSK_SESSION_STORAGE_KEY = "kiosk_booking_session";

export const KIOSK_STEP_REGISTRY: Record<SessionItem["kind"], StepDef[]> = {
  race: [...STEP_REGISTRY.race],
  attraction: [...STEP_REGISTRY.attraction],
  bowling: [...STEP_REGISTRY.bowling],
  kbf: [...STEP_REGISTRY.kbf],
};
