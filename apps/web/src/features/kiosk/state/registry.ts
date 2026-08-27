/**
 * Kiosk step registry — starts as a clone of the web wizard's STEP_REGISTRY
 * (the flows ARE the web flows; the kiosk is a presentation shell). Later
 * kiosk stages override individual entries here (first-available time steps,
 * required bowling details, who's-playing/waivers) WITHOUT ever touching the
 * web registry — zero risk to the live booking flow.
 */
import { STEP_REGISTRY, type SessionItem, type StepDef } from "~/features/booking";
import {
  RaceHeatPickerStepAdultKiosk,
  RaceHeatPickerStepJuniorKiosk,
} from "~/components/features/booking/steps/race/RaceHeatPickerStep";
import { withKartingCheckIn } from "~/components/features/booking/steps/race/karting-check-in-context";
import { classicOnly, hiddenForDuckpin } from "~/features/booking/state/steps";
import { getPackage } from "@/lib/packages";
import { KioskSlotStep } from "../steps/KioskSlotStep";
import { KioskBowlingDetailsStep } from "../steps/KioskBowlingDetailsStep";
import { KioskBowlingTimeStep } from "../steps/KioskBowlingTimeStep";
import { KioskBowlingTierStep } from "../steps/KioskBowlingTierStep";
import { KioskBowlingOfferStep } from "../steps/KioskBowlingOfferStep";
import { KioskBowlingPeopleStep } from "../steps/KioskBowlingPeopleStep";
import {
  KioskRacePeopleStep,
  KioskAttractionPeopleStep,
  KioskRaceSimPeopleStep,
} from "../steps/KioskPeopleStep";
import { KioskRaceSimProductStep } from "../steps/KioskRaceSimProductStep";
import { KioskRaceSimTrackStep } from "../steps/KioskRaceSimTrackStep";
import { KioskRaceSimSlotStep } from "../steps/KioskRaceSimSlotStep";
import { ContactStep } from "~/components/features/booking/steps/ContactStep";

export const KIOSK_SCHEMA_VERSION = 16; // v15: racesim flow mirrors racing (people-first, contact, track, time)
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
 * package onto the item's CATEGORY — they picked it by tapping the tile, so no
 * reselect (owner 2026-07-19). Because visible steps are filtered by isVisible,
 * hiding it also makes Back skip it. Package fields are per-category
 * (packageIdAdult/Junior), so a mixed party skips BOTH product steps when both
 * variants preseeded (owner 2026-07-19), and each category falls back to its own
 * product step whenever its side wasn't preseeded (no single eligible variant /
 * normal racing / combo) — no other path is disrupted.
 */
function skipWhenPreselected(step: StepDef): StepDef {
  const stepCategory = step.id.includes("junior") ? "junior" : "adult";
  return {
    ...step,
    isVisible: (item, session) => {
      if (!step.isVisible(item, session)) return false;
      // Structural cast (item is the generic SessionItem here) — field names in
      // lockstep with RaceItem.packageIdAdult/Junior (state/types.ts).
      const fields = item as { packageIdAdult?: string | null; packageIdJunior?: string | null };
      const pkgId = stepCategory === "junior" ? fields.packageIdJunior : fields.packageIdAdult;
      const preferred = session.preferredPackageId;
      if (!preferred || typeof pkgId !== "string" || !pkgId.startsWith(preferred)) return true;
      // Skip only when the preseeded variant is still enabled — a flag-disabled
      // variant must fall back to the product step, not dead-end at heats.
      return !getPackage(pkgId);
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
      // KARTING CHECK-IN treatment on the heat grid — kiosk only. The guest is
      // already in the building at the karting end, so the karting desk is the
      // only check-in the screen can mean; on the web, Express Lane is unknown at
      // pick time and the label would risk sending a standard guest to the wrong
      // floor (owner 2026-08-17). Same step ids, so breadcrumbs and canAdvance
      // are untouched — see RaceHeatPickerStep's kiosk variants.
      //
      // combo-start is on this list for the same reason: a combo special
      // REPLACES the heat pickers with its own start-time grid, and that grid
      // sells the identical BMI session slots. It shipped without the treatment
      // and a VIP guest read a bare time as a race time (owner 2026-08-19).
      .map((s) =>
        s.id === "race-heat-adult"
          ? (RaceHeatPickerStepAdultKiosk as StepDef)
          : s.id === "race-heat-junior"
            ? (RaceHeatPickerStepJuniorKiosk as StepDef)
            : s.id === "combo-start"
              ? withKartingCheckIn(s)
              : s,
      )
      .filter(
        (s) =>
          s.id !== "race-date" &&
          s.id !== "race-experience" &&
          s.id !== "combo-intro" &&
          s.id !== "combo-itinerary",
      )
      // Preselected-package launch (Experiences → Ultimate Qualifier tile) skips
      // the product step so the guest doesn't reselect what they just tapped.
      .map((s) => {
        if (s.id === "race-product-adult" || s.id === "race-product-junior") {
          return skipWhenPreselected(s);
        }
        return s;
      }),
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
    // The kiosk replacements swap the CLASSIC web steps, so they must carry
    // the same classicOnly gate the web entries have — replaceStep swaps the
    // whole (wrapped) StepDef, and without re-wrapping, a v3 session would
    // see both flows. The v3 Date/Experience/Time entries flow through from
    // STEP_REGISTRY untouched (BowlingDateStep self-hides on kiosks; the
    // shared Experience/Time steps render their kiosk variant via
    // session.context.kiosk).
    steps = replaceStep(
      steps,
      "bowling-slots",
      hiddenInCombo(hiddenForWorldCup(classicOnly(KioskBowlingTimeStep as StepDef))),
    );
    // Classic vs VIP Suites — kiosk-native Podium reskin (writes only item.tier;
    // the offer step still does duration + slot + hold).
    // Duckpin has a single non-VIP offer — skip the Tier step (matches web).
    steps = replaceStep(
      steps,
      "bowling-tier",
      hiddenInCombo(
        hiddenForWorldCup(hiddenForDuckpin(classicOnly(KioskBowlingTierStep as StepDef))),
      ),
    );
    // Kiosk-native "Choose a Package" (Podium reskin of the classic offer
    // step; same shared useBowlingOffers brain, so the duration + slot +
    // QAMF-hold contract is unchanged; v3 keeps its own kiosk-variant steps).
    steps = replaceStep(
      steps,
      "bowling-offer",
      hiddenInCombo(hiddenForWorldCup(classicOnly(KioskBowlingOfferStep as StepDef))),
    );
    // REPLACE the shoe-quantity step (BowlingShoesStep) with the per-bowler
    // details step: the kiosk should never ask "how many shoes" AND then per-
    // player sizes — the rental count is DERIVED from who picks a rental size
    // (owner 2026-07-25). Details owns the shoe line items now.
    steps = replaceStep(steps, "bowling-shoes", hiddenInCombo(KioskBowlingDetailsStep as StepDef));
    return [hiddenInCombo(KioskBowlingPeopleStep as StepDef), ...steps];
  })(),
  kbf: replaceStep(
    replaceStep(
      replaceStep(
        [...STEP_REGISTRY.kbf],
        "bowling-slots",
        classicOnly(KioskBowlingTimeStep as StepDef),
      ),
      "bowling-offer",
      classicOnly(KioskBowlingOfferStep as StepDef),
    ),
    // Same as bowling: details step REPLACES the shoe-quantity step (count is
    // derived from the per-bowler size picks).
    "bowling-shoes",
    KioskBowlingDetailsStep as StepDef,
  ),
  // Race Sims (FastTrax FM): kiosk-only flow — the web registry's racesim
  // list is deliberately empty. FOLLOWS THE KIOSK RACING FLOW step for step
  // (owner 2026-08-26: "follow racing as close as possible") with the track
  // step added: Who's racing? (whole party, racing semantics) → Your Info
  // (the same ContactStep racing carries — KioskFlow skips it forward once
  // the main person's contact is complete) → Race Options (karting product
  // page layout) → Track (the added step) → Time (heat-picker layout, eager
  // $0-key hold). Racing's pay-mode step (race packs/bundles) and Race Video
  // & Extras (POV camera, headsock, licence) have no sim analog yet — pay
  // mode slots in when sim packs get keys. Checkout fail-closed until the
  // BMI keys are armed (features/race-sims/products.ts).
  racesim: [
    KioskRaceSimPeopleStep as StepDef,
    ContactStep,
    KioskRaceSimProductStep as StepDef,
    KioskRaceSimTrackStep as StepDef,
    KioskRaceSimSlotStep as StepDef,
  ],
};
