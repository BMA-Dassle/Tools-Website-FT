/**
 * Kiosk STAFF MODE — shared types.
 *
 * Staff mode is what a staff Intercard card turns on: the kiosk knows WHICH
 * employee is standing at it (not just "someone with the PIN"), and for a short
 * idle window shows staff-only actions on the people it is looking at. Built as
 * kiosk-wide pieces (store, scan gate, bar, per-person actions, sheets) so any
 * page can become a staff surface by mounting `StaffModeSurface`; the Your Crew
 * page is the first (owner 2026-09-04).
 *
 * Staff surface → hardcoded English (house precedent: the i18n rule exempts
 * staff-only UI).
 */

/** The employee a resolved staff card names. Comes from the owner's Pandora
 *  card→employee endpoint via /api/kiosk/staff-card; carried inside the signed
 *  staff token so the actions route never trusts the client's copy. */
export interface StaffEmployee {
  /** Employer-side id (whatever the Pandora endpoint returns — a string). */
  id: string;
  /** Display name, e.g. "Sam Ortiz". */
  name: string;
  /** Optional role / title when the endpoint carries one. */
  role?: string;
  /** Last 4 of the Intercard account the card carried — shown in the bar so
   *  staff can tell whose card armed the kiosk. Never the full account. */
  cardTail: string;
}

/** Pandora location KEY the sheets/actions route on — the same three the rest
 *  of the kiosk uses (PANDORA_LOCATION_MAP). Center first: a Naples kiosk is
 *  "naples" regardless of brand. */
export type StaffLocation = "fasttrax" | "headpinz" | "naples";

/** A person on the roster a staff action targets. Trimmed from PartyMember so
 *  the sheets work off ANY roster (crew, wizard, check-in party). */
export interface StaffTarget {
  /** Local roster id (for a later "refresh this person" hook). */
  memberId: string;
  /** BMI person id — 17-digit Office id or short Pandora id, RAW digit string
   *  (never Number() it). The Office reads use this. */
  personId: string;
  /** SHORT Pandora id when the session resolved one — Pandora WRITES prefer it
   *  (Pandora rejects 17-digit Office ids on several endpoints). */
  pandoraPersonId?: string;
  name: string;
  isMinor?: boolean;
}

export type StaffSheetKind = "membership" | "comp" | "history";
