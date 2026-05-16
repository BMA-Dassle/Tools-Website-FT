/**
 * Per-activity step registry.
 *
 * Each activity defines an ordered list of StepDef. <StepHost> reads this,
 * filters by `isVisible(draft)` so optional steps can hide, and gates the
 * Next button on `canAdvance(draft)`.
 *
 * PR-B1 ships the SHAPE — every activity has a placeholder step that just
 * renders "TODO: <step name>". Real step components land in PR-B2..B6.
 */
import type { ComponentType } from "react";
import type { Draft } from "./types";
import type { Activity } from "../types";

export interface StepDef<D extends Draft = Draft> {
  /** Stable id for breadcrumb + URL hash sync. */
  id: string;
  /** User-facing title. */
  title: string;
  /** Component receives the draft + a typed dispatch. */
  Component: ComponentType<{ draft: D }>;
  /** Hide the step entirely when this returns false. */
  isVisible: (draft: D) => boolean;
  /**
   * Gate the Next button. Return `true` to allow advance, or
   * `{ reason }` to display a hint. The host doesn't decide UI; it just
   * uses the boolean and surfaces `reason` as a tooltip if needed.
   */
  canAdvance: (draft: D) => true | { reason: string };
}

/** Placeholder step used while real per-activity components land. */
function makePlaceholder<D extends Draft>(id: string, title: string): StepDef<D> {
  return {
    id,
    title,
    Component: () => null, // PR-B1 ships shells; real UIs land per-activity PR.
    isVisible: () => true,
    canAdvance: () => true,
  };
}

/**
 * Default per-activity step lists. Real lists per PR-B2..B6 will replace
 * these placeholders with typed step components.
 */
export const STEP_REGISTRY: Record<Activity, StepDef[]> = {
  race: [
    makePlaceholder("location", "Location"),
    makePlaceholder("date", "Date"),
    makePlaceholder("party", "Party"),
    makePlaceholder("product", "Product"),
    makePlaceholder("heat", "Heat"),
    makePlaceholder("contact", "Contact"),
    makePlaceholder("review", "Review"),
    makePlaceholder("payment", "Payment"),
  ],
  "race-pack": [
    makePlaceholder("location", "Location"),
    makePlaceholder("date", "Date"),
    makePlaceholder("party", "Party"),
    makePlaceholder("pack", "Package"),
    makePlaceholder("heats", "Heats"),
    makePlaceholder("contact", "Contact"),
    makePlaceholder("review", "Review"),
    makePlaceholder("payment", "Payment"),
  ],
  attraction: [
    makePlaceholder("location", "Location"),
    makePlaceholder("date", "Date"),
    makePlaceholder("slot", "Slot"),
    makePlaceholder("party", "Party"),
    makePlaceholder("contact", "Contact"),
    makePlaceholder("review", "Review"),
    makePlaceholder("payment", "Payment"),
  ],
  bowling: [
    makePlaceholder("location", "Location"),
    makePlaceholder("date", "Date"),
    makePlaceholder("slot", "Time"),
    makePlaceholder("lanes", "Lanes"),
    makePlaceholder("addons", "Shoes & Add-ons"),
    makePlaceholder("contact", "Contact"),
    makePlaceholder("review", "Review"),
    makePlaceholder("payment", "Payment"),
  ],
  kbf: [
    // The KBF identity gate is one composite step containing lookup → verify →
    // roster sub-states (see Draft.kbf.identity.phase). Breadcrumb shows one
    // tick, not three.
    makePlaceholder("identity", "Verify"),
    makePlaceholder("slot", "Time"),
    makePlaceholder("bowlers", "Bowlers"),
    makePlaceholder("addons", "Shoes & Add-ons"),
    makePlaceholder("contact", "Contact"),
    makePlaceholder("review", "Review"),
    makePlaceholder("payment", "Payment"),
  ],
};
