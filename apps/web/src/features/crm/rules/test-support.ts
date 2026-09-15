/**
 * The prototype's world as engine inputs (`crm-data.js:5-41,63-82`), shared by
 * the engine, sweep and screen tests. Test-only — nothing in `service/` imports
 * this file.
 *
 *   NOW              2026-09-12T19:30-04:00 (a Saturday; `crm-data.js:5`)
 *   reps             kelsea (HPFM, FT) · lori (HPFM) · stephanie (HPN) ·
 *                    gs bucket · mkt hold · jacob / eric directors
 *   shifts           kelsea today 10–18 tomorrow 9–17 · lori off (PTO), tomorrow
 *                    12–20 · stephanie today 12–20 · gs 9–22 both days ·
 *                    mkt tomorrow 9–17
 *   rules            R1..R7 = `RULE_SEED` with ids "1".."7"
 *   queue leads      L-1061 FT corporate 42 Oct 16 · L-1060 HPN birthday 18
 *                    Oct 3 · L-1059 HPFM school 120 Nov 20 · L-1062 HPFM
 *                    holiday 55 Dec 11
 */

import { RULE_SEED } from "~/features/crm/core/seed";
import type { AssignmentRule, CentreCode, CrmRep, RepRole } from "~/features/crm/core/types";
import type { RosterByRep } from "./service/availability";
import type { EngineContext, EngineLead, VolumeByRepMonth } from "./service/engine";

export const PROTOTYPE_NOW = new Date("2026-09-12T19:30:00-04:00");
export const PROTOTYPE_NOW_AFTERNOON = new Date("2026-09-12T14:00:00-04:00");

const ALL: CentreCode[] = ["HPFM", "FT", "HPN"];

function rep(
  id: string,
  slug: string,
  displayName: string,
  firstName: string,
  initials: string,
  role: RepRole,
  centres: CentreCode[],
): CrmRep {
  return {
    id,
    slug,
    displayName,
    firstName,
    initials,
    role,
    email: `${slug}@headpinz.com`,
    ssoSub: null,
    bmiUserId: null,
    bmiUserIds: null,
    bmiUsername: displayName,
    bmiUsernames: null,
    sevenShiftsUserId: null,
    voxDid: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres,
    active: true,
    sortOrder: Number(id) * 10,
  };
}

export const REPS: CrmRep[] = [
  rep("1", "kelsea", "Kelsea Kosco", "Kelsea", "KK", "rep", ["HPFM", "FT"]),
  rep("2", "lori", "Lori Lehman", "Lori", "LL", "rep", ["HPFM"]),
  rep("3", "stephanie", "Stephanie Wegman", "Stephanie", "SW", "rep", ["HPN"]),
  rep("4", "gs", "Guest Services", "Guest Services", "GS", "bucket", ALL),
  rep("5", "mkt", "Marketing Director", "Marketing", "MD", "hold", ALL),
  rep("6", "jacob", "Jacob", "Jacob", "J", "director", ALL),
  rep("7", "eric", "Eric Osborn", "Eric", "EO", "director", ALL),
];

export const REP_ID = {
  kelsea: "1",
  lori: "2",
  stephanie: "3",
  gs: "4",
  mkt: "5",
  jacob: "6",
  eric: "7",
} as const;

export const RULES: AssignmentRule[] = RULE_SEED.map((r, i) => ({
  id: String(i + 1),
  position: r.position,
  enabled: true,
  kind: r.kind,
  label: r.label,
  why: r.why,
  when: { ...r.when },
  then: { ...r.then },
}));

/** `crm-data.js:25-31` as RosterByRep for Sat Sep 12 / Sun Sep 13. */
export const SHIFTS_TODAY: RosterByRep = {
  [REP_ID.kelsea]: { window: { startHour: 10, endHour: 18 }, off: false, offReason: null },
  [REP_ID.lori]: { window: null, off: true, offReason: "PTO" },
  [REP_ID.stephanie]: { window: { startHour: 12, endHour: 20 }, off: false, offReason: null },
  [REP_ID.gs]: { window: { startHour: 9, endHour: 22 }, off: false, offReason: null },
  [REP_ID.mkt]: { window: null, off: false, offReason: null },
};

export const SHIFTS_TOMORROW: RosterByRep = {
  [REP_ID.kelsea]: { window: { startHour: 9, endHour: 17 }, off: false, offReason: null },
  [REP_ID.lori]: { window: { startHour: 12, endHour: 20 }, off: false, offReason: null },
  [REP_ID.stephanie]: { window: null, off: false, offReason: null },
  [REP_ID.gs]: { window: { startHour: 9, endHour: 22 }, off: false, offReason: null },
  [REP_ID.mkt]: { window: { startHour: 9, endHour: 17 }, off: false, offReason: null },
};

/** Open volume by party month — illustrative, like the prototype's leads. */
export const VOLUME: VolumeByRepMonth = {
  [REP_ID.kelsea]: {
    "2026-10": { guests: 60, count: 1 },
    "2026-12": { guests: 40, count: 1 },
  },
  [REP_ID.lori]: {
    "2026-10": { guests: 130, count: 2 },
    "2026-12": { guests: 20, count: 1 },
  },
  [REP_ID.stephanie]: { "2026-10": { guests: 22, count: 1 } },
};

export function prototypeContext(overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    reps: REPS,
    rules: RULES,
    shiftsToday: SHIFTS_TODAY,
    shiftsTomorrow: SHIFTS_TOMORROW,
    openVolumeByRepMonth: VOLUME,
    now: PROTOTYPE_NOW,
    ...overrides,
  };
}

/** The four unassigned queue leads (`crm-data.js:63-82`). */
export const QUEUE_LEADS = {
  "L-1061": {
    centre: "FT",
    guests: 42,
    type: "corporate",
    eventDate: "2026-10-16",
    source: "web",
  },
  "L-1060": {
    centre: "HPN",
    guests: 18,
    type: "birthday",
    eventDate: "2026-10-03",
    source: "web",
    kids: true,
  },
  "L-1059": {
    centre: "HPFM",
    guests: 120,
    type: "school",
    eventDate: "2026-11-20",
    source: "phone",
  },
  "L-1062": {
    centre: "HPFM",
    guests: 55,
    type: "holiday",
    eventDate: "2026-12-11",
    source: "referral",
  },
} as const satisfies Record<string, EngineLead>;
