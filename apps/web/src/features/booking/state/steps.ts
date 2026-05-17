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
import type { ComponentType } from "react";
import type { BookingItem, BookingSession, SessionItem } from "./types";

export interface StepDef<I extends BookingItem = BookingItem> {
  /** Stable id for breadcrumb + URL hash sync. */
  id: string;
  /** User-facing title. */
  title: string;
  /** Component reads the active item + session, dispatches via onChange. */
  Component: ComponentType<{
    item: I;
    session: BookingSession;
    onChange: (patch: Partial<I>) => void;
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

/**
 * Default per-kind step lists. Real lists per PR-B2..B6 will replace
 * these placeholders with typed step components.
 */
export const STEP_REGISTRY: Record<SessionItem["kind"], StepDef[]> = {
  race: [
    makePlaceholder("date", "Date"),
    makePlaceholder("party", "Party"),
    makePlaceholder("product", "Product"),
    makePlaceholder("heat", "Heat"),
    makePlaceholder("review", "Review"),
  ],
  attraction: [
    makePlaceholder("date", "Date"),
    makePlaceholder("slot", "Slot"),
    makePlaceholder("party", "Party"),
    makePlaceholder("review", "Review"),
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
