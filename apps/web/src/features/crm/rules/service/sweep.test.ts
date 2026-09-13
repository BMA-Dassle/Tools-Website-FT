import { afterEach, describe, expect, it, vi } from "vitest";
import type { SweepDecision } from "../contracts";
import type { SweepCandidate } from "../data/volume-db";
import { PROTOTYPE_NOW, prototypeContext } from "../test-support";
import {
  SWEEP_APPLIED_REASON,
  SWEEP_DISABLED_REASON,
  SWEEP_NOT_APPLIED_REASON,
  applySweepDecisions,
  mirrorIdempotencyKey,
  runAssignSweep,
  sweepIdempotencyKey,
  type SweepTraces,
} from "./sweep";

/**
 * Idempotency per ET hour; the retry window; the kill switch; the fact that it
 * runs AT ALL HOURS now that the hold-until-9-AM branch is gone; and the live
 * rail — `applySweepDecisions` calls `assignLead` once per decision that
 * resolved a rep, skips the rest, and survives one that throws.
 *
 * `~/features/crm/leads` is mocked because the rail reaches it through a
 * DYNAMIC import (the edge that would otherwise close a cycle between two
 * re-export barrels); the mock records what the sweep asked for.
 */

const { assigns, throwOn } = vi.hoisted(() => ({
  assigns: [] as { leadId: string; repId: string | null; [k: string]: unknown }[],
  throwOn: new Set<string>(),
}));

vi.mock("~/features/crm/leads", () => ({
  assignLead: async (input: { leadId: string; repId: string | null }) => {
    assigns.push(input);
    if (throwOn.has(input.leadId)) throw new Error("lead 101 not found");
    return {};
  },
}));

afterEach(() => {
  throwOn.clear();
});

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

describe("runAssignSweep", () => {
  it("asks for leads older than now − delay, decides each with the engine, hands them to the rail", async () => {
    let askedOlderThan: Date | null = null;
    let askedLimit = 0;
    const handed: SweepDecision[] = [];
    let handedTraces: SweepTraces | undefined;
    const result = await runAssignSweep({
      applyDecisions: async (ds, traces) => {
        handed.push(...ds);
        handedTraces = traces;
        return ds.filter((d) => d.rep).length;
      },
      now: PROTOTYPE_NOW,
      settings: { delayMinutes: 60 },
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
    expect(result.applied).toBe(2);
    expect(result.reason).toBe(SWEEP_APPLIED_REASON);
    expect(handed.map((d) => d.publicId)).toEqual(["L-1061", "L-1059"]);
    // Each hand-off carries the trace the deal's history shows, keyed by lead id,
    // ending on the rule that decided.
    expect(handedTraces!.get("101")!.at(-1)!.code).toBe("R6");
    expect(handedTraces!.get("102")!.at(-1)!.code).toBe("R1");
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

  // The hold-until-9-AM branch is GONE (owner, 2026-09-13 14:50). 22:15 ET and
  // 03:00 ET both used to be "held"; both now hand the lead over, because R5
  // already narrows to whoever works the next shift.
  it.each([
    ["late evening", "2026-09-12T22:15:00-04:00"],
    ["the small hours", "2026-09-13T03:00:00-04:00"],
  ])("runs at %s — nothing is held until 9 AM any more", async (_label, iso) => {
    const now = new Date(iso);
    const result = await runAssignSweep({
      now,
      settings: { delayMinutes: 30 },
      listCandidates: async () => [candidate({})],
      loadContext: async () => prototypeContext({ now }),
      applyDecisions: async (ds) => ds.length,
    });
    expect(result.applied).toBe(1);
    expect(result.reason).toBe(SWEEP_APPLIED_REASON);
    expect(result).not.toHaveProperty("held");
    expect(result).not.toHaveProperty("afterHours");
  });

  it("no candidates → no context load, empty decisions", async () => {
    let loaded = 0;
    const result = await runAssignSweep({
      now: PROTOTYPE_NOW,
      settings: { delayMinutes: 60 },
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
    expect(result.reason).toBe(SWEEP_NOT_APPLIED_REASON);
  });

  it('CRM_AUTO_ASSIGN="false" decides but writes nothing — the rail is never called', async () => {
    let called = 0;
    const result = await runAssignSweep({
      now: PROTOTYPE_NOW,
      settings: { delayMinutes: 60 },
      listCandidates: async () => [candidate({})],
      loadContext: async () => prototypeContext({ now: PROTOTYPE_NOW }),
      autoAssignEnabled: () => false,
      applyDecisions: async (ds) => {
        called++;
        return ds.length;
      },
    });
    expect(called).toBe(0);
    expect(result.applied).toBe(0);
    expect(result.reason).toBe(SWEEP_DISABLED_REASON);
    // The decisions are still computed, so the director can see what it WOULD do.
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].rep?.slug).toBe("kelsea");
  });

  /**
   * The safety net's whole job. A lead the engine could not resolve at capture
   * stays unassigned; the next sweep re-runs the rules against a roster that
   * has since changed (somebody came back on shift, a rule was edited) and
   * hands it over.
   */
  it("a lead the engine could not resolve at capture is picked up on the NEXT run", async () => {
    const settings = { delayMinutes: 60 };
    const listCandidates = async () => [candidate({})];

    const first = await runAssignSweep({
      now: PROTOTYPE_NOW,
      settings,
      listCandidates,
      // Nobody on the roster → nobody to name, exactly as at capture time.
      loadContext: async () =>
        prototypeContext({ now: PROTOTYPE_NOW, reps: [], openVolumeByRepMonth: {} }),
      applyDecisions: async (ds) => ds.filter((d) => d.rep).length,
    });
    expect(first.decisions[0]!.rep).toBeNull();
    expect(first.applied).toBe(0);

    const handed: string[] = [];
    const second = await runAssignSweep({
      now: PROTOTYPE_NOW,
      settings,
      listCandidates,
      // The roster is back.
      loadContext: async () => prototypeContext({ now: PROTOTYPE_NOW }),
      applyDecisions: async (ds) => {
        handed.push(...ds.filter((d) => d.rep).map((d) => d.publicId));
        return handed.length;
      },
    });
    expect(second.decisions[0]!.rep?.slug).toBe("kelsea");
    expect(second.applied).toBe(1);
    expect(handed).toEqual(["L-1061"]);
    expect(second.reason).toBe(SWEEP_APPLIED_REASON);
  });

  it("a lead the fallback rule parks (no rep) is reported but never handed over", async () => {
    const result = await runAssignSweep({
      now: PROTOTYPE_NOW,
      settings: { delayMinutes: 60 },
      // No rep sells at this centre for a 1-guest holiday party in the seeded
      // roster? The fallback rule answers "waits for Jacob" — rep null.
      listCandidates: async () => [candidate({ guests: 500, type: "corporate" })],
      loadContext: async () =>
        prototypeContext({ now: PROTOTYPE_NOW, reps: [], openVolumeByRepMonth: {} }),
      applyDecisions: async (ds) => applySweepDecisions(ds),
    });
    expect(result.decisions[0].rep).toBeNull();
    expect(result.applied).toBe(0);
    expect(result.reason).toBe(SWEEP_NOT_APPLIED_REASON);
  });
});

describe("applySweepDecisions (the live rail)", () => {
  const decision = (over: Partial<SweepDecision>): SweepDecision => ({
    leadId: "101",
    publicId: "L-1061",
    centre: "FT",
    guests: 42,
    type: "corporate",
    eventDate: "2026-10-16",
    source: "web",
    ageMinutes: 61,
    rep: {
      id: "1",
      slug: "kelsea",
      displayName: "Kelsea Kosco",
      firstName: "Kelsea",
      initials: "KK",
      role: "rep",
      centres: ["FT"],
    },
    outcome: "assign",
    reason: "lowest Oct volume",
    finalRuleId: "6",
    ...over,
  });

  it("calls assignLead once per pickable decision with reason 'auto', the rule id and its trace", async () => {
    assigns.length = 0;
    const traces: SweepTraces = new Map([
      ["101", [{ ruleId: "6", hit: true, code: "R6", label: "Balance the month" }]],
    ]);
    const applied = await applySweepDecisions(
      [decision({}), decision({ leadId: "102", publicId: "L-1059", rep: null, outcome: "queue" })],
      traces,
    );
    expect(applied).toBe(1);
    expect(assigns).toHaveLength(1);
    expect(assigns[0]).toMatchObject({
      leadId: "101",
      repId: "1",
      actor: "assign-sweep",
      reason: "auto",
      ruleId: "6",
      note: "lowest Oct volume",
    });
    expect(assigns[0].trace).toEqual(traces.get("101"));
  });

  it("one hand-off that throws does not stop the rest", async () => {
    assigns.length = 0;
    throwOn.add("101");
    const applied = await applySweepDecisions([
      decision({}),
      decision({ leadId: "102", publicId: "L-1062" }),
    ]);
    throwOn.clear();
    expect(applied).toBe(1);
    expect(assigns.map((a) => a.leadId)).toEqual(["101", "102"]);
  });

  it("no decision resolved a rep → the leads sub is never even loaded", async () => {
    assigns.length = 0;
    const applied = await applySweepDecisions([decision({ rep: null, outcome: "queue" })]);
    expect(applied).toBe(0);
    expect(assigns).toHaveLength(0);
  });
});
