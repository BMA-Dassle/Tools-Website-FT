import { describe, expect, it } from "vitest";
import { ALL_REPS, PROTO_NOW, QUEUE_LEADS, makeLead, minsAgo } from "../test-support";
import type { SuggestResult } from "./suggest";
import {
  ageMinutes,
  autoAssignInMinutes,
  buildQueueLeads,
  buildRepColumns,
  loadQueue,
  queueMonths,
} from "./queue";

/**
 * Queue ordering + age (brief §4 B3 tests) at the prototype's clock, the
 * three-month volume columns, and the rep columns (assignable reps only).
 */

describe("queueMonths", () => {
  it("this month and the next two, wrapping the year", () => {
    expect(queueMonths("2026-09-12")).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(queueMonths("2026-12-05")).toEqual(["2026-12", "2027-01", "2027-02"]);
    expect(queueMonths("2026-01-31")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
});

describe("age and the sweep countdown", () => {
  it("ageMinutes floors whole minutes", () => {
    expect(ageMinutes(minsAgo(8), PROTO_NOW)).toBe(8);
    expect(ageMinutes(minsAgo(118), PROTO_NOW)).toBe(118);
    expect(ageMinutes(new Date(PROTO_NOW.getTime() + 5000).toISOString(), PROTO_NOW)).toBe(0);
  });
  it("autoAssignInMinutes counts down from the sweep delay for the OLDEST waiting lead", () => {
    expect(autoAssignInMinutes([], 60, PROTO_NOW)).toBeNull();
    expect(autoAssignInMinutes([{ createdAt: minsAgo(8) }], 60, PROTO_NOW)).toBe(52);
    expect(
      autoAssignInMinutes([{ createdAt: minsAgo(8) }, { createdAt: minsAgo(41) }], 60, PROTO_NOW),
    ).toBe(19);
    // L-1059 has waited 118 min: the sweep is overdue → 0, never negative
    expect(autoAssignInMinutes(QUEUE_LEADS, 60, PROTO_NOW)).toBe(0);
  });
});

describe("buildQueueLeads", () => {
  it("keeps the given (oldest-first) order, computes age, carries the suggestion or null / []", () => {
    const sug = new Map<string, SuggestResult>([
      [
        "1061",
        {
          suggestion: {
            rep: ALL_REPS[0]!,
            reason: "lowest Oct volume",
            ruleId: "6",
            finalRuleLabel: "R6",
          },
          trace: [{ ruleId: "R6", label: "Lowest volume", hit: true }],
        },
      ],
    ]);
    const rows = buildQueueLeads(QUEUE_LEADS, sug, PROTO_NOW);
    expect(rows.map((r) => [r.lead.publicId, r.ageMinutes])).toEqual([
      ["L-1061", 8],
      ["L-1060", 41],
      ["L-1059", 118],
      ["L-1062", 3],
    ]);
    expect(rows[0]!.suggestion).toMatchObject({
      rep: { slug: "kelsea" },
      reason: "lowest Oct volume",
      ruleId: "6",
    });
    expect(rows[0]!.trace).toHaveLength(1);
    expect(rows[1]!.suggestion).toBeNull();
    expect(rows[1]!.trace).toEqual([]);
  });
});

describe("buildRepColumns", () => {
  it("assignable reps only (no hold, no director), in sort order, with every month filled and their untouched leads", () => {
    const months = ["2026-10", "2026-11", "2026-12"];
    const assigned = [
      makeLead({ id: "1055", rep: "1", status: "assigned" }),
      makeLead({ id: "1057", rep: "2", status: "assigned" }),
    ];
    const cols = buildRepColumns(
      ALL_REPS,
      [
        { repId: "1", month: "2026-10", guests: 114, count: 3 },
        { repId: "1", month: "2026-11", guests: 70, count: 1 },
        { repId: "3", month: "2026-10", guests: 136, count: 2 },
        { repId: "1", month: "2027-01", guests: 999, count: 9 },
      ],
      assigned,
      months,
    );
    expect(cols.map((c) => c.rep.slug)).toEqual(["kelsea", "lori", "stephanie", "gs"]);
    expect(cols[0]!.volume).toEqual({
      "2026-10": { guests: 114, count: 3 },
      "2026-11": { guests: 70, count: 1 },
      "2026-12": { guests: 0, count: 0 },
    });
    expect(cols[1]!.volume["2026-10"]).toEqual({ guests: 0, count: 0 });
    expect(cols[0]!.assigned.map((l) => l.publicId)).toEqual(["L-1055"]);
    expect(cols[1]!.assigned.map((l) => l.publicId)).toEqual(["L-1057"]);
    expect(cols[3]!.assigned).toEqual([]);
    // the wire projection carries no DIDs / Office ids
    expect(cols[0]!.rep).not.toHaveProperty("bmiUserId");
  });
});

describe("loadQueue", () => {
  it("wires the pieces: months from ET today, one suggest per unassigned lead, the sweep countdown from settings", async () => {
    const suggested: string[] = [];
    const body = await loadQueue({
      listUnassigned: async () => QUEUE_LEADS,
      listReps: async () => ALL_REPS,
      volume: async (months) => months.map((m) => ({ repId: "1", month: m, guests: 1, count: 1 })),
      listAssigned: async () => [],
      suggest: async (lead) => {
        suggested.push(lead.publicId);
        return { suggestion: null, trace: [] };
      },
      settings: async () => ({
        bmiWrites: { enabled: true, offCentres: [] },
        sweep: { delayMinutes: 45, afterHours: "hold9am" },
        responseTargetMinutes: 60,
      }),
      now: () => PROTO_NOW,
    });
    expect(body.months).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(suggested).toEqual(["L-1061", "L-1060", "L-1059", "L-1062"]);
    expect(body.unassigned).toHaveLength(4);
    expect(body.reps.map((c) => c.rep.slug)).toEqual(["kelsea", "lori", "stephanie", "gs"]);
    expect(body.sweepDelayMinutes).toBe(45);
    expect(body.autoAssignInMinutes).toBe(0);
  });
});
