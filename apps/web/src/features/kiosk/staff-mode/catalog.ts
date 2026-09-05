/**
 * Staff-mode catalogues — which memberships and comps a staff member can put on
 * a guest's BMI account, and the ids that mean them upstream. PURE.
 *
 * ⚠️ IDS ARE PER BMI CLIENT KEY. `headpinzftmyers` (FastTrax + HeadPinz Fort
 * Myers share one tenant) and `headpinznaples` are DIFFERENT catalogues with
 * different ids for the same-named thing (pandora-memberships.ts — the 8 stuck
 * Naples grants of 2026-08-12 were exactly this). Every entry carries one id
 * per client key.
 *
 * `null` = NOT CONFIGURED. The UI renders that chip disabled with "id not
 * configured" and the server refuses the write — we never guess an id, because
 * the failure mode is a membership on the wrong tenant, not an error.
 *
 * Fort Myers ids read off the owner's Office screenshots 2026-09-04:
 *   MEMBERSHIP KINDS (Office "Memberships" grid)
 *     11260957 License Fee                  60303930 Age Override
 *     12213012 Qualified Intermediate        12744844 Qualified Pro
 *     12757067 Qualified Junior Intermediate 15175025 Qualified Junior Pro
 *     12754847 Employee Pass (kind Pass, 50%)
 *   Present in the grid but deliberately NOT offered here (discount/marketing
 *   memberships, not overrides): Gold Membership 11252390 (50%), League Racer
 *   44597932 (20%, retired 2026-09-01), Spring Break Pass 32052643, Option 1/2,
 *   Turbo Pass 11435559, Speed Pass 11438715. One line each to add.
 *   DEPOSIT KINDS (Office "Credit" grid) — a comp is a free credit of the kind
 *   the activity consumes:
 *     11260967 Credit - Race Comp            48069703 Credit - Headsock
 *     24216636 Credit - Nexus Gel Blaster    306564   Credit - Nexus Laser Tag
 *     46322806 Credit - Viewpoint (POV camera)
 *   Not offered (yet): Duck Pin / Shuffly minutes (24216484 / 393790), Game
 *   Zone tokens (24440175) — tokens live on the Intercard card, not BMI.
 * Naples has its own catalogue (different ids) — still owed.
 */
import type { StaffLocation } from "./types";

export type OfficeClientKey = "headpinzftmyers" | "headpinznaples";

/** Center-first: Naples is its own tenant; both Fort Myers brands share one. */
export function clientKeyForStaffLocation(location: StaffLocation): OfficeClientKey {
  return location === "naples" ? "headpinznaples" : "headpinzftmyers";
}

export interface MembershipKindDef {
  key: string;
  label: string;
  kindId: Record<OfficeClientKey, string | null>;
  /** Owner rule: the licence defaults to one year; every other membership
   *  defaults to 99 years (effectively permanent, still an explicit date —
   *  Pandora will not default `expires`). */
  defaultTermYears: 1 | 99;
}

export const MEMBERSHIP_KINDS: readonly MembershipKindDef[] = [
  {
    key: "license",
    label: "License Fee",
    kindId: { headpinzftmyers: "11260957", headpinznaples: null },
    defaultTermYears: 1,
  },
  {
    key: "qualified-intermediate",
    label: "Qualified Intermediate",
    kindId: { headpinzftmyers: "12213012", headpinznaples: null },
    defaultTermYears: 99,
  },
  {
    key: "qualified-pro",
    label: "Qualified Pro",
    kindId: { headpinzftmyers: "12744844", headpinznaples: null },
    defaultTermYears: 99,
  },
  {
    key: "junior-intermediate",
    label: "Qualified Junior Intermediate",
    kindId: { headpinzftmyers: "12757067", headpinznaples: null },
    defaultTermYears: 99,
  },
  {
    key: "junior-pro",
    label: "Qualified Junior Pro",
    kindId: { headpinzftmyers: "15175025", headpinznaples: null },
    defaultTermYears: 99,
  },
  {
    key: "age-override",
    label: "Age Override",
    kindId: { headpinzftmyers: "60303930", headpinznaples: null },
    defaultTermYears: 99,
  },
  {
    key: "employee-pass",
    label: "Employee Pass",
    kindId: { headpinzftmyers: "12754847", headpinznaples: null },
    defaultTermYears: 99,
  },
];

export interface CompKindDef {
  key: string;
  label: string;
  /** Pandora deposit kind id (F_DPK_ID) — the same rail the kiosk admin panel's
   *  comp action and race-pack credits ride (addDeposit). */
  depositKindId: Record<OfficeClientKey, string | null>;
}

export const COMP_KINDS: readonly CompKindDef[] = [
  {
    key: "race",
    label: "Race",
    depositKindId: { headpinzftmyers: "11260967", headpinznaples: null },
  },
  {
    key: "gel-blaster",
    label: "Gel Blaster",
    depositKindId: { headpinzftmyers: "24216636", headpinznaples: null },
  },
  {
    key: "laser-tag",
    label: "Laser Tag",
    depositKindId: { headpinzftmyers: "306564", headpinznaples: null },
  },
  {
    key: "headsock",
    label: "Headsock",
    depositKindId: { headpinzftmyers: "48069703", headpinznaples: null },
  },
  {
    key: "pov-camera",
    label: "POV Camera",
    depositKindId: { headpinzftmyers: "46322806", headpinznaples: null },
  },
];

export function membershipKind(key: string): MembershipKindDef | null {
  return MEMBERSHIP_KINDS.find((k) => k.key === key) ?? null;
}

export function compKind(key: string): CompKindDef | null {
  return COMP_KINDS.find((k) => k.key === key) ?? null;
}

/** Longest term the server accepts — the 99-year default plus headroom, so a
 *  typo'd year cannot mint a membership to the year 9999. */
export const MAX_TERM_YEARS = 100;
/** Most comps one submit may add. Staff add one or two; twenty is already a
 *  party, and a slipped finger on the stepper should not mint a hundred. */
export const MAX_COMP_QTY = 20;

/** `from` + the kind's default term, as a Date. Pure so the client preview and
 *  the server default agree to the millisecond. */
export function defaultMembershipExpiry(kind: MembershipKindDef, from: Date = new Date()): Date {
  return addYears(from, kind.defaultTermYears);
}

export function addYears(from: Date, years: number): Date {
  const d = new Date(from);
  d.setFullYear(d.getFullYear() + years);
  return d;
}
