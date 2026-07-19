/**
 * Kiosk step registry — starts as a clone of the web wizard's STEP_REGISTRY
 * (the flows ARE the web flows; the kiosk is a presentation shell). Later
 * kiosk stages override individual entries here (first-available time steps,
 * required bowling details, who's-playing/waivers) WITHOUT ever touching the
 * web registry — zero risk to the live booking flow.
 */
import { STEP_REGISTRY, type SessionItem, type StepDef } from "~/features/booking";
import { getPackage } from "@/lib/packages";
import { KioskSlotStep } from "../steps/KioskSlotStep";
import { KioskBowlingDetailsStep } from "../steps/KioskBowlingDetailsStep";
import { KioskBowlingTimeStep } from "../steps/KioskBowlingTimeStep";
import { KioskBowlingTierStep } from "../steps/KioskBowlingTierStep";
import { KioskBowlingPeopleStep } from "../steps/KioskBowlingPeopleStep";
import { KioskRacePeopleStep, KioskAttractionPeopleStep } from "../steps/KioskPeopleStep";

export const KIOSK_SCHEMA_VERSION = 9; // v9: race-pack step (flag-gated, off by default)
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

/**
 * Skip the race product step when the guest launched from an Experiences package
 * tile (session.preferredPackageId) AND the flow has already resolved that
 * package onto the item — they picked it by tapping the tile, so no reselect
 * (owner 2026-07-19). Because visible steps are filtered by isVisible, hiding it
 * also makes Back skip it. Falls back to showing the step whenever nothing was
 * preseeded (mixed party / no single eligible variant / normal racing / combo),
 * so no other path is disrupted.
 */
function skipWhenPreselected(step: StepDef): StepDef {
  const stepCategory = step.id.includes("junior") ? "junior" : "adult";
  return {
    ...step,
    isVisible: (item, session) => {
      if (!step.isVisible(item, session)) return false;
      const pkgId = (item as { packageId?: string }).packageId;
      const preferred = session.preferredPackageId;
      if (!preferred || typeof pkgId !== "string" || !pkgId.startsWith(preferred)) return true;
      // Skip ONLY the product step whose category matches the preseeded package —
      // a mixed party (a later-added junior on an adult preseed) still gets its
      // own product step, so no racer is left without a package.
      const pkgCategory = getPackage(pkgId)?.category;
      return !(pkgCategory === "any" || pkgCategory === stepCategory);
    },
  };
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
  // Race packs (credit packs) live INSIDE the product step as a teaser card +
  // the standalone attract-screen flow — no dedicated wizard step (owner final
  // design 2026-07-18; the old flag-dark KioskRacePackStep was retired).
  race: replaceStep(
    // Drop the web combo OVERVIEW step (combo-intro) — the kiosk shows its own
    // readable KioskVipOverview BEFORE the flow, so the in-flow one was a
    // duplicate (owner: "not sure why we have two steps"). Also drop the combo
    // "Your Schedule" REVIEW step (combo-itinerary): the schedule-confirm modal
    // already showed + booked the whole itinerary, so on the kiosk it was a
    // dead extra tap (owner 2026-07-18: "shouldn't exist — just return to main
    // menu"); KioskFlow treats the cursor landing past combo-start as
    // combo-complete and returns to the category chooser.
    STEP_REGISTRY.race
      .filter(
        (s) =>
          s.id !== "race-date" &&
          s.id !== "race-experience" &&
          s.id !== "combo-intro" &&
          s.id !== "combo-itinerary",
      )
      // Preselected-package launch (Experiences → Ultimate Qualifier tile) skips
      // the product step so the guest doesn't reselect what they just tapped.
      .map((s) =>
        s.id === "race-product-adult" || s.id === "race-product-junior"
          ? skipWhenPreselected(s)
          : s,
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
  // Kiosk rules: LEAD with the add-bowlers + main-contact step (owner: bowling
  // should be the add-people screen, not a bare YOUR INFO form) — drops the web
  // ContactStep + player-count stepper (the people step writes item.players +
  // playerCount + session.contact, which is exactly what reserve reads). Then
  // today-only "bowl now" time step (replaces the calendar), and names/shoe
  // sizes/bumpers REQUIRED in-flow (web collects them post-booking).
  bowling: (() => {
    let steps = [...STEP_REGISTRY.bowling].filter(
      (s) => s.id !== "contact" && s.id !== "bowling-players",
    );
    steps = replaceStep(
      steps,
      "bowling-slots",
      hiddenInCombo(hiddenForWorldCup(KioskBowlingTimeStep as StepDef)),
    );
    // Classic vs VIP Suites — kiosk-native Podium reskin (writes only item.tier;
    // the offer step still does duration + slot + hold).
    steps = replaceStep(
      steps,
      "bowling-tier",
      hiddenInCombo(hiddenForWorldCup(KioskBowlingTierStep as StepDef)),
    );
    steps = insertAfter(steps, "bowling-shoes", hiddenInCombo(KioskBowlingDetailsStep as StepDef));
    return [hiddenInCombo(KioskBowlingPeopleStep as StepDef), ...steps];
  })(),
  kbf: insertAfter(
    replaceStep([...STEP_REGISTRY.kbf], "bowling-slots", KioskBowlingTimeStep as StepDef),
    "bowling-shoes",
    KioskBowlingDetailsStep as StepDef,
  ),
};
