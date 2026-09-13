import { describe, expect, it } from "vitest";
import type { SweepCandidate } from "../data/volume-db";
import { PROTOTYPE_NOW, PROTOTYPE_NOW_AFTERNOON, prototypeContext } from "../test-support";
import {
  SWEEP_HELD_REASON,
  SWEEP_NOT_APPLIED_REASON,
  isAfterHours,
  mirrorIdempotencyKey,
  runAssignSweep,
  sweepIdempotencyKey,
} from "./sweep";

/** Idempotency per ET hour; the delay window; the after-hours hold; `applied: 0` until B3. */

const candidate = (over: Partial<SweepCandidate>): SweepCandidate => ({
  id: "101",
  publicId: "L-1061",
  centre: "FT",
  guests: 42,
  type: "corporate",
  eventDate: "2026-10-16",
  source: "web",
  kids: undefined,
  createdAt: "2026-09-12T23:22:00Z", // 8 min before 19:30 ET
  ...over,
});

describe("idempotency keys", () => {
  it("sweep: one per ET hour — 23:30Z Sep 12 is 19:xx ET Sep 12; 03:10Z Sep 13 is 23:xx ET Sep 12", () => {
    expect(sweepIdempotencyKey(new Date("2026-09-12T23:30:00Z"))).toBe(
      "assign-sweep:2026-09-12T19",
    );
    expect(sweepIdempotencyKey(new Date("2026-09-12T23:59:00Z"))).toBe(
      "assign-sweep:2026-09-12T19",
    );
    expect(sweepIdempotencyKey(new Date("2026-09-13T00:00:00Z"))).toBe(
      "assign-sweep:2026-09-12T20",
    );
    expect(sweepIdempotencyKey(new Date("2026-09-13T03:10:00Z"))).toBe(
      "assign-sweep:2026-09-12T23",
    );
    expect(sweepIdempotencyKey(new Date("2026-09-13T04:10:00Z"))).toBe(
      "assign-sweep:2026-09-13T00",
    );
  });
  it("mirror: one per ET day", () => {
    expect(mirrorIdempotencyKey(new Date("2026-09-13T03:10:00Z"))).toBe(
      "sevenshifts-mirror:2026-09-12",
    );
    expect(mirrorIdempotencyKey(new Date("2026-09-13T04:10:00Z"))).toBe(
      "sevenshifts-mirror:2026-09-13",
    );
  });
});

describe("isAfterHours (9 AM – 9 PM ET)", () => {
  it("is false at 14:00 and 19:30 ET, true at 21:00 and 08:59 ET", () => {
    expect(isAfterHours(PROTOTYPE_NOW_AFTERNOON)).toBe(false);
    expect(isAfterHours(PROTOTYPE_NOW)).toBe(false);
    expect(isAfterHours(new Date("2026-09-12T21:00:00-04:00"))).toBe(true);
    expect(isAfterHours(new Date("2026-09-12T08:59:00-04:00"))).toBe(true);
    expect(isAfterHours(new Date("2026-09-12T09:00:00-04:00"))).toBe(false);
  });
});

describe("runAssignSweep", () => {
  it("asks for leads older than now − delay, decides each with the engine, applies nothing (B3 lands the rail)", async () => {
    let askedOlderThan: Date | null = null;
    let askedLimit = 0;
    const result = await runAssignSweep({
      now: PROTOTYPE_NOW,
      settings: { delayMinutes: 60, afterHours: "assign" },
      async listCandidates(olderThan, limit) {
        askedOlderThan = olderThan;
        askedLimit = limit;
        return [
          candidate({}),
          candidate({
            id: "102",
            publicId: "L-1059",
            centre: "HPFM",
            guests: 120,
            type: "school",
            eventDate: "2026-11-20",
            source: "phone",
            createdAt: "2026-09-12T21:32:00Z",
          }),
        ];
      },
      async loadContext() {
        return prototypeContext({ now: PROTOTYPE_NOW });
      },
    });
    expect(askedOlderThan!.toISOString()).toBe("2026-09-12T22:30:00.000Z"); // 19:30 ET − 60 min
    expect(askedLimit).toBe(200);
    expect(result.applied).toBe(0);
    expect(result.reason).toBe(SWEEP_NOT_APPLIED_REASON);
    expect(result.held).toBe(false);
    expect(result.candidates).toBe(2);
    expect(
      result.decisions.map((d) => [d.publicId, d.rep?.slug ?? null, d.outcome, d.reason]),
    ).toEqual([
      ["L-1061", "kelsea", "assign", "lowest Oct volume"],
      ["L-1059", "mkt", "hold", "held for Marketing Director"],
    ]);
    expect(result.decisions[0].ageMinutes).toBe(8);
    expect(result.decisions[1].ageMinutes).toBe(118);
    expect(result.decisions[0].finalRuleId).toBe("6");
    // The rep on the wire is the PUBLIC projection — no DIDs, chat ids, Office names.
    expect(Object.keys(result.decisions[0].rep!).sort()).toEqual([
      "centres",
      "displayName",
      "firstName",
      "id",
      "initials",
      "role",
      "slug",
    ]);
  });

  it("hold9am outside business hours: decisions computed, run marked held, nothing applied even with a rail", async () => {
    let applied = 0;
    const result = await runAssignSweep({
      now: new Date("2026-09-12T22:15:00-04:00"),
      settings: { delayMinutes: 30, afterHours: "hold9am" },
      listCandidates: async () => [candidate({})],
      loadContext: async () => prototypeContext({ now: new Date("2026-09-12T22:15:00-04:00") }),
      applyDecisions: async (ds) => {
        applied += ds.length;
        return ds.length;
      },
    });
    expect(result.held).toBe(true);
    expect(result.reason).toBe(SWEEP_HELD_REASON);
    expect(result.decisions).toHaveLength(1);
    expect(result.applied).toBe(0);
    expect(applied).toBe(0);
  });

  it("`assign` after hours runs; a wired rail is applied and counted", async () => {
    const result = await runAssignSweep({
      now: new Date("2026-09-12T22:15:00-04:00"),
      settings: { delayMinutes: 30, afterHours: "assign" },
      listCandidates: async () => [candidate({})],
      loadContext: async () => prototypeContext({ now: new Date("2026-09-12T22:15:00-04:00") }),
      applyDecisions: async (ds) => ds.length,
    });
    expect(result.held).toBe(false);
    expect(result.applied).toBe(1);
    expect(result.reason).toBe("applied");
  });

  it("no candidates → no context load, empty decisions", async () => {
    let loaded = 0;
    const result = await runAssignSweep({
      now: PROTOTYPE_NOW,
      settings: { delayMinutes: 60, afterHours: "hold9am" },
      listCandidates: async () => [],
      loadContext: async () => {
        loaded++;
        return prototypeContext();
      },
    });
    expect(loaded).toBe(0);
    expect(result.decisions).toEqual([]);
    expect(result.candidates).toBe(0);
    expect(result.applied).toBe(0);
  });
});
