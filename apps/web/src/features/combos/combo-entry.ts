import type { BookingSession, SessionItem } from "~/features/booking/state/types";

/**
 * What the combo booking entry (`/book/combo/[id]/v2`) should do with the
 * session it hydrated from sessionStorage.
 *
 * Pure decision, kept out of BookingFlow so it can be unit-tested without
 * mounting the wizard. Bug this fixes (owner recording 2026-08-24,
 * `vipexpissue.mp4`): the entry used to seed the combo ONLY when the cart was
 * empty and otherwise did nothing — so a tab that had touched any other flow
 * first (the Karting tile seeds an empty race item on entry; a duplicated
 * "Book bowling" tab copies its sessionStorage) rendered a PLAIN race wizard
 * under a "Book the VIP Experience" title, and the guest could never reach the
 * VIP schedule. Clicking a VIP link is intent to book the VIP — symmetric with
 * the reverse path, where entering a normal activity tears a stale combo down.
 */
export type ComboEntryPlan =
  /** The session already IS this combo (guest came back mid-booking): touch nothing. */
  | { kind: "resume" }
  /**
   * Seed the combo. `release` lists the non-combo (or other-combo) items that
   * must leave the cart first — their vendor holds are released best-effort,
   * exactly like the cart's "Remove" — and is empty on a clean cart.
   */
  | { kind: "seed"; release: SessionItem[] };

export function planComboEntry(session: BookingSession, comboId: string): ComboEntryPlan {
  if (session.comboSpecialId === comboId && session.items.length > 0) {
    return { kind: "resume" };
  }
  return { kind: "seed", release: session.items };
}
