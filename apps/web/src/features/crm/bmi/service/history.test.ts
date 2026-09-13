import { describe, expect, it, vi } from "vitest";
import type { MirrorProject } from "../data/projects-mirror-db";

/**
 * The wire projection of a mirror row: the rep chip is joined from
 * `responsible_user_id` → `crm_reps.bmi_user_id`, the centre from the
 * location, and nothing on the wire is a number that was an id.
 */

vi.mock("~/features/crm/reps", () => ({
  listReps: async () => [
    { slug: "kelsea", firstName: "Kelsea", initials: "KK", bmiUserId: "28267036" },
    { slug: "jacob", firstName: "Jacob", initials: "J", bmiUserId: null },
  ],
}));

const calls = vi.hoisted(() => ({
  accounts: 0,
  events: 0,
  counts: 0,
}));

vi.mock("~/features/crm/leads", () => ({
  searchAccounts: async () => {
    calls.accounts++;
    return { items: [], nextCursor: "acc-2" };
  },
}));

vi.mock("../data/projects-mirror-db", () => ({
  searchMirrorProjects: async () => {
    calls.events++;
    return { items: [], nextCursor: "ev-2" };
  },
  countMirrorProjects: async () => {
    calls.counts++;
    return { total: 12, groupEvents: 4 };
  },
  listSyncRuns: async () => [],
  listLastYearHosts: async () => ({ items: [], nextCursor: null }),
  listMirrorProjectsForAccount: async () => ({ items: [], nextCursor: null }),
}));

const { historySearch, repIndex, toMirrorEvent } = await import("./history");

const ROW: MirrorProject = {
  projectId: "58454076",
  clientKey: "headpinzftmyers",
  locationId: 467486,
  number: "DH2320",
  name: "Storm Smart — Install crews",
  stateId: "-3",
  stateName: "Confirmation",
  kindId: "-1",
  responsibleUserId: "28267036",
  responsibleName: "Kelsea Kosco",
  eventDate: "2025-10-25",
  eventStart: "2025-10-25T22:00:00.000Z",
  persons: 64,
  totalValueCents: 496_000,
  balanceCents: 0,
  personId: "63000000009561437",
  personName: "Pat Storm",
  personPhone: "+12395551602",
  personEmail: "pat@stormsmart.com",
  products: null,
  source: "backfill",
  bmiCreatedAt: null,
  bmiUpdatedAt: null,
  syncedAt: "2026-09-12T23:00:00.000Z",
  accountId: "7",
  contactId: "8",
};

describe("toMirrorEvent", () => {
  it("joins the rep by bmi_user_id and maps the FastTrax location to FT", async () => {
    const reps = await repIndex();
    expect(reps.size).toBe(1); // a rep without a BMI user id cannot be attributed
    const e = toMirrorEvent(ROW, reps);
    expect(e).toMatchObject({
      projectId: "58454076",
      centre: "FT",
      number: "DH2320",
      rep: { slug: "kelsea", firstName: "Kelsea", initials: "KK" },
      totalValueCents: 496_000,
      accountId: "7",
    });
    expect(toMirrorEvent({ ...ROW, responsibleUserId: "1" }, reps).rep).toBeNull();
    expect(toMirrorEvent({ ...ROW, locationId: null }, reps).centre).toBeNull();
  });
});

describe("historySearch skips the work the screen already has", () => {
  it("a finished list is not re-read, and the mirror counts are a first-page-only cost", async () => {
    const first = await historySearch({ q: "acme" });
    expect(first.mirror).toMatchObject({ projects: 12, groupEvents: 4 });
    expect([calls.accounts, calls.events, calls.counts]).toEqual([1, 1, 1]);

    // Page two of the events only: accounts are done and the counts are on screen.
    const next = await historySearch({
      q: "acme",
      accounts: false,
      status: false,
      eventsCursor: "ev-2",
    });
    expect(next.accounts).toEqual([]);
    expect(next.accountsNextCursor).toBeNull();
    expect(next.mirror).toBeNull();
    expect([calls.accounts, calls.events, calls.counts]).toEqual([1, 2, 1]);

    // An empty query has no events to search at all.
    await historySearch({ q: "", status: false });
    expect(calls.events).toBe(2);
  });
});
