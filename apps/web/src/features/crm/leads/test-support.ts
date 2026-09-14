/**
 * Fixtures for the leads tests — the prototype's seeded rows re-expressed as
 * `LeadView` / `CrmRep`, at the PROTOTYPE'S OWN CLOCK (`crm-data.js:5`,
 * `NOW = 2026-09-12T19:30-04:00`). Test-only; never imported by production
 * code (the index does not export it).
 */

import type { CrmRep } from "../core/types";
import type { LeadView } from "./contracts";

export const PROTO_NOW = new Date("2026-09-12T19:30:00-04:00");

export function minsAgo(m: number, now: Date = PROTO_NOW): string {
  return new Date(now.getTime() - m * 60_000).toISOString();
}

export function minsFromNow(m: number, now: Date = PROTO_NOW): string {
  return new Date(now.getTime() + m * 60_000).toISOString();
}

export function makeRep(overrides: Partial<CrmRep> & Pick<CrmRep, "id" | "slug">): CrmRep {
  const first = overrides.firstName ?? overrides.slug[0]!.toUpperCase() + overrides.slug.slice(1);
  return {
    displayName: first,
    firstName: first,
    initials: first.slice(0, 2).toUpperCase(),
    role: "rep",
    email: `${overrides.slug}@headpinz.com`,
    ssoSub: null,
    bmiUserId: null,
    bmiUsername: null,
    sevenShiftsUserId: null,
    voxDid: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: ["HPFM", "FT", "HPN"],
    active: true,
    sortOrder: 100,
    ...overrides,
  };
}

/** The seven seeded reps with the ids the tests use (`crm_reps.id` as text). */
export const REPS = {
  kelsea: makeRep({
    id: "1",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    bmiUserId: "28267036",
    bmiUsername: "Kelsea Kosco",
    centres: ["HPFM", "FT"],
    sortOrder: 10,
  }),
  lori: makeRep({
    id: "2",
    slug: "lori",
    displayName: "Lori Lehman",
    firstName: "Lori",
    initials: "LL",
    bmiUserId: "465247",
    bmiUsername: "Lori Lehman",
    centres: ["HPFM"],
    sortOrder: 20,
  }),
  stephanie: makeRep({
    id: "3",
    slug: "stephanie",
    displayName: "Stephanie Wegman",
    firstName: "Stephanie",
    initials: "SW",
    bmiUserId: "465242",
    bmiUsername: "Stephanie Wegman",
    centres: ["HPN"],
    sortOrder: 30,
  }),
  gs: makeRep({
    id: "4",
    slug: "gs",
    displayName: "Guest Services",
    firstName: "Guest Services",
    initials: "GS",
    role: "bucket",
    bmiUserId: "30080112",
    bmiUsername: "Guest Services",
    sortOrder: 40,
  }),
  mkt: makeRep({
    id: "5",
    slug: "mkt",
    displayName: "Marketing Director",
    firstName: "Marketing",
    initials: "MD",
    role: "hold",
    email: null,
    sortOrder: 50,
  }),
  jacob: makeRep({
    id: "6",
    slug: "jacob",
    displayName: "Jacob",
    firstName: "Jacob",
    initials: "J",
    role: "director",
    sortOrder: 60,
  }),
} as const;

export const ALL_REPS: CrmRep[] = Object.values(REPS);

export function makeLead(overrides: Partial<LeadView> & Pick<LeadView, "id">): LeadView {
  const id = overrides.id;
  return {
    publicId: `L-${id}`,
    contactId: `9${id}`,
    accountId: null,
    centre: "HPFM",
    eventDate: "2026-10-17",
    eventTime: "18:00",
    guests: 24,
    type: "corporate",
    source: "web",
    isProspect: false,
    status: "new",
    rep: null,
    assignedAt: null,
    heldForRep: null,
    firstTouchAt: null,
    guestIntroAt: null,
    contract: null,
    nextAction: null,
    valueCents: 0,
    lostReason: null,
    notes: null,
    bmi: {
      projectId: null,
      projectNumber: null,
      stateId: null,
      stateName: null,
      personId: null,
      syncedAt: null,
    },
    mintStatus: "pending",
    mintError: null,
    mintAttempts: 0,
    gfShortId: null,
    lastYearBmiProjectId: null,
    coldRowId: null,
    createdBy: null,
    createdAt: minsAgo(8),
    updatedAt: minsAgo(8),
    archivedAt: null,
    kids: false,
    guest: {
      first: "Marcus",
      last: "Bellamy",
      phone: "+12395552710",
      email: "marcus.bellamy@gulfcoastlogistics.com",
      company: "Gulf Coast Logistics",
      prefers: null,
    },
    repSlug: null,
    repName: null,
    requestedRep: null,
    ...overrides,
  };
}

/** The `LeadView.requestedRep` projection of a roster row (B7). */
export function asRequestedRep(rep: CrmRep) {
  return {
    id: rep.id,
    slug: rep.slug,
    firstName: rep.firstName,
    displayName: rep.displayName,
  };
}

/** The four unassigned queue leads from `crm-data.js:63-82`. */
export const QUEUE_LEADS: LeadView[] = [
  makeLead({
    id: "1061",
    centre: "FT",
    eventDate: "2026-10-16",
    eventTime: "17:30",
    guests: 42,
    type: "corporate",
    source: "web",
    createdAt: minsAgo(8),
    bmi: {
      projectId: "63000000009561437",
      projectNumber: "DH2891",
      stateId: null,
      stateName: "New Lead",
      personId: "63000000009561438",
      syncedAt: minsAgo(8),
    },
    mintStatus: "minted",
    notes: "Quarterly team event. Wants karting + pizza. Asked about Friday pricing.",
  }),
  makeLead({
    id: "1060",
    centre: "HPN",
    eventDate: "2026-10-03",
    eventTime: "13:00",
    guests: 18,
    type: "birthday",
    kids: true,
    source: "web",
    createdAt: minsAgo(41),
    guest: {
      first: "Priya",
      last: "Natarajan",
      phone: "+12395558841",
      email: "priya.n@outlook.com",
      company: null,
      prefers: "text",
    },
    mintStatus: "minted",
  }),
  makeLead({
    id: "1059",
    centre: "HPFM",
    eventDate: "2026-11-20",
    eventTime: "10:00",
    guests: 120,
    type: "school",
    source: "phone",
    createdAt: minsAgo(118),
    guest: {
      first: "Dana",
      last: "Whitfield",
      phone: "+12395554470",
      email: "dwhitfield@leeschools.net",
      company: "Lee County Schools — Cypress Lake HS",
      prefers: null,
    },
    mintStatus: "minted",
  }),
  makeLead({
    id: "1062",
    centre: "HPFM",
    eventDate: "2026-12-11",
    eventTime: "18:00",
    guests: 55,
    type: "holiday",
    source: "referral",
    createdAt: minsAgo(3),
    guest: {
      first: "Tomás",
      last: "Herrera",
      phone: "+12395551932",
      email: "tomas@herrerarealty.com",
      company: "Herrera Realty Group",
      prefers: null,
    },
    mintStatus: "minted",
  }),
];
