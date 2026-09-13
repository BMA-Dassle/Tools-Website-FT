import { describe, expect, it } from "vitest";
import type { CrmUser } from "../../core/types";
import { ALL_REPS, PROTO_NOW, REPS, makeLead, minsAgo, minsFromNow } from "../test-support";
import {
  bucketDue,
  buildLanes,
  buildRepMyDay,
  dateLabelFor,
  endOfEasternDay,
  greetingFor,
  loadBadges,
  loadMyDay,
} from "./my-day";

/**
 * My Day buckets (brief §4 B3 tests) at the prototype's clock — Saturday
 * September 12, 2026, 7:30 PM ET — where "Good evening, Kelsea" and
 * "Saturday, September 12" are the pinned copy (direction-b.html `today`).
 */

// The prototype's due items for Kelsea, from crm-data.js:
//   L-1042 due today 16:00  → overdue (3.5 h ago)
//   L-1048 due today 14:00  → overdue
//   L-1055 due 10 min ago   → overdue
//   L-1051 due tomorrow 9AM → not today
const L1042 = makeLead({
  id: "1042",
  rep: "1",
  status: "quote",
  nextAction: { kind: "call", due: "2026-09-12T20:00:00.000Z", label: "Follow up on quote" },
});
const L1048 = makeLead({
  id: "1048",
  rep: "1",
  status: "contract",
  nextAction: {
    kind: "text",
    due: "2026-09-12T18:00:00.000Z",
    label: "Contract unsigned 2 days — nudge",
  },
});
const L1055 = makeLead({
  id: "1055",
  rep: "1",
  status: "assigned",
  assignedAt: minsAgo(70),
  nextAction: { kind: "call", due: minsAgo(10), label: "New lead — first touch due" },
});
const L1051 = makeLead({
  id: "1051",
  rep: "1",
  status: "waiting",
  nextAction: {
    kind: "email",
    due: "2026-09-13T13:00:00.000Z",
    label: "Waiting 4 days — send menu options",
  },
});
const LATER_TONIGHT = makeLead({
  id: "7",
  rep: "1",
  status: "contacted",
  nextAction: { kind: "call", due: minsFromNow(90), label: "Promised a call back tonight" },
});
const DUE = [L1048, L1042, L1055, LATER_TONIGHT, L1051]; // soonest first, as SQL returns them

describe("ET copy", () => {
  it("greeting by ET hour", () => {
    expect(greetingFor(PROTO_NOW, "Kelsea")).toBe("Good evening, Kelsea");
    expect(greetingFor(new Date("2026-09-12T13:00:00Z"), "Jacob")).toBe("Good morning, Jacob"); // 9 AM ET
    expect(greetingFor(new Date("2026-09-12T18:30:00Z"), "Lori")).toBe("Good afternoon, Lori"); // 2:30 PM ET
    expect(greetingFor(new Date("2026-09-13T03:30:00Z"), "Eric")).toBe("Good evening, Eric"); // 11:30 PM ET, still Saturday
  });
  it("date label in ET, even after 8 PM ET when UTC is already tomorrow", () => {
    expect(dateLabelFor(PROTO_NOW)).toBe("Saturday, September 12");
    expect(dateLabelFor(new Date("2026-09-13T03:30:00Z"))).toBe("Saturday, September 12");
  });
  it("endOfEasternDay is midnight ET, expressed as an instant", () => {
    expect(endOfEasternDay(PROTO_NOW).toISOString()).toBe("2026-09-13T04:00:00.000Z");
    expect(endOfEasternDay(new Date("2026-12-12T20:00:00Z")).toISOString()).toBe(
      "2026-12-13T05:00:00.000Z",
    ); // EST
  });
});

describe("bucketDue", () => {
  it("overdue = past now; due today = before midnight ET; tomorrow stays out", () => {
    const b = bucketDue(DUE, PROTO_NOW);
    expect(b.overdue.map((l) => l.publicId)).toEqual(["L-1048", "L-1042", "L-1055"]);
    expect(b.dueToday.map((l) => l.publicId)).toEqual(["L-7"]);
  });
  it("a lead without a next action is ignored", () => {
    expect(bucketDue([makeLead({ id: "9", rep: "1" })], PROTO_NOW)).toEqual({
      overdue: [],
      dueToday: [],
    });
  });
});

describe("buildRepMyDay / buildLanes", () => {
  it("the rep view: three columns and the prototype's greeting", () => {
    const v = buildRepMyDay("Kelsea", DUE, [L1055], PROTO_NOW);
    expect(v.kind).toBe("rep");
    expect(v.greeting).toBe("Good evening, Kelsea");
    expect(v.dateLabel).toBe("Saturday, September 12");
    expect(v.overdue).toHaveLength(3);
    expect(v.dueToday).toHaveLength(1);
    expect(v.newLeads.map((l) => l.publicId)).toEqual(["L-1055"]);
  });
  it("lanes: every rep who can hold a lead — reps AND the Guest Services bucket, never a hold or a director", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      makeLead({
        id: String(100 + i),
        rep: "3",
        nextAction: { kind: "call", due: minsFromNow(10 + i), label: "x" },
      }),
    );
    const lanes = buildLanes(ALL_REPS, [...DUE, ...many], PROTO_NOW);
    // `mkt` is a hold and `jacob`/`eric` are directors — neither can be assigned
    // a lead, so neither gets a lane. `gs` can (rule R3 sends kids' birthdays
    // there), so it does, even though the prototype's three hard-coded lanes
    // leave it out.
    expect(lanes.map((l) => l.rep.slug)).toEqual(["kelsea", "lori", "stephanie", "gs"]);
    expect(lanes[0]).toMatchObject({ overdue: 3 });
    expect(lanes[0]!.due).toHaveLength(5);
    expect(lanes[1]!.due).toHaveLength(0);
    expect(lanes[2]!.due).toHaveLength(5);
    expect(lanes[2]!.overdue).toBe(0);
    expect(lanes[3]).toMatchObject({ overdue: 0 });
    expect(lanes[3]!.due).toHaveLength(0);
  });
});

const deps = (over: Partial<Parameters<typeof loadMyDay>[1]> = {}) => ({
  listDue: async (repId?: string | null) => (repId ? DUE.filter((l) => l.rep === repId) : DUE),
  listNew: async () => [L1055],
  listReps: async () => ALL_REPS,
  countUnassigned: async () => 4,
  countInStatus: async () => 3,
  listUnassigned: async () => [makeLead({ id: "1059", createdAt: minsAgo(118) })],
  settings: async () => ({
    bmiWrites: { enabled: true, offCentres: [] },
    sweep: { delayMinutes: 60, afterHours: "hold9am" as const },
    responseTargetMinutes: 60,
  }),
  now: () => PROTO_NOW,
  ...over,
});

const rep: Pick<CrmUser, "role" | "name" | "email" | "rep"> = {
  role: "rep",
  name: "Kelsea Kosco",
  email: "kelsea@headpinz.com",
  rep: REPS.kelsea,
};
const director: Pick<CrmUser, "role" | "name" | "email" | "rep"> = {
  role: "director",
  name: "Jacob",
  email: "jacob@headpinz.com",
  rep: REPS.jacob,
};

describe("loadMyDay / loadBadges", () => {
  it("a rep gets their own columns", async () => {
    const v = await loadMyDay(rep, deps());
    expect(v.kind).toBe("rep");
    if (v.kind !== "rep") return;
    expect(v.overdue).toHaveLength(3);
    expect(v.newLeads).toHaveLength(1);
  });
  it("a sales user with no rep row gets an empty board, not an error", async () => {
    const v = await loadMyDay({ ...rep, rep: null }, deps());
    expect(v).toMatchObject({
      kind: "rep",
      greeting: "Good evening, Kelsea",
      overdue: [],
      dueToday: [],
      newLeads: [],
    });
  });
  it("a director gets the tiles, the sweep countdown and the lanes", async () => {
    const v = await loadMyDay(director, deps());
    expect(v.kind).toBe("director");
    if (v.kind !== "director") return;
    expect(v.greeting).toBe("Good evening, Jacob");
    expect(v.dateLabel).toBe("Saturday, September 12");
    expect(v.tiles).toEqual({ unassigned: 4, overdueTeam: 3, contractsOut: 3 });
    expect(v.autoAssignInMinutes).toBe(0);
    expect(v.lanes.map((l) => l.rep.slug)).toEqual(["kelsea", "lori", "stephanie", "gs"]);
  });
  it("badges: a rep's own overdue and no queue; the director's team overdue and the queue", async () => {
    expect(await loadBadges(rep, deps())).toEqual({ overdue: 3, unassigned: 0 });
    expect(await loadBadges(director, deps())).toEqual({ overdue: 3, unassigned: 4 });
    expect(await loadBadges({ role: "rep", rep: null }, deps())).toEqual({
      overdue: 0,
      unassigned: 0,
    });
  });
});
