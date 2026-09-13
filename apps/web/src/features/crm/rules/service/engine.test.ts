import { describe, expect, it } from "vitest";
import type { AssignmentRule } from "~/features/crm/core/types";
import {
  PROTOTYPE_NOW,
  PROTOTYPE_NOW_AFTERNOON,
  QUEUE_LEADS,
  REP_ID,
  RULES,
  SHIFTS_TODAY,
  prototypeContext,
} from "../test-support";
import {
  activeRules,
  assignDecision,
  autoPick,
  candidateReps,
  decideByRules,
  standardPick,
  whenMatches,
  type EngineLead,
} from "./engine";

/**
 * The engine matrix (brief §3.10, B2 "Tests"): the 7 seeded rules × the 4
 * seeded queue leads at the prototype's OWN clock (19:30 ET, Sat Sep 12) and at
 * a second clock (14:00 ET), plus the branches the seeded leads never reach.
 * `ctx.now` is injected every time — nothing here reads the wall clock.
 */

const byId = (id: string) => RULES.find((r) => r.id === id)!;
const R = (n: number) => byId(String(n));

describe("assignDecision at the prototype's clock — 2026-09-12T19:30-04:00", () => {
  const ctx = prototypeContext({ now: PROTOTYPE_NOW });

  it("L-1061 (FT · 42 · corporate · Oct 16) → R6 / Kelsea, `lowest Oct volume`, with the R5 next-shift note", () => {
    const d = assignDecision(QUEUE_LEADS["L-1061"], ctx);
    expect(d.rep?.slug).toBe("kelsea");
    expect(d.reason).toBe("lowest Oct volume");
    expect(d.finalRuleId).toBe(R(6).id);
    expect(d.outcome).toBe("assign");
    const r5 = d.trace.find((t) => t.ruleId === R(5).id)!;
    expect(r5.hit).toBe(true);
    // Kelsea's Saturday shift is 10–18, so at 19:30 nobody is on; her next is Sunday 9 AM.
    expect(r5.note).toBe(
      "nobody on shift now · next in: Kelsea 9 AM tomorrow → standard rule picks between them",
    );
    const r4 = d.trace.find((t) => t.ruleId === R(4).id)!;
    expect(r4).toEqual({ ruleId: R(4).id, hit: false, note: "nobody is off" });
    const r6 = d.trace.find((t) => t.ruleId === R(6).id)!;
    expect(r6.note).toBe("Kelsea has the lowest Oct volume (60 guests in 1 leads)");
    // R1–R3 were evaluated and missed; R7 was never reached.
    expect(d.trace.map((t) => [t.ruleId, t.hit])).toEqual([
      ["1", false],
      ["2", false],
      ["3", false],
      ["4", false],
      ["5", true],
      ["6", true],
    ]);
  });

  it("L-1062 (HPFM · 55 · holiday · Dec 11) → R4 skips Lori (PTO), then R6 / Kelsea", () => {
    const d = assignDecision(QUEUE_LEADS["L-1062"], ctx);
    expect(d.rep?.slug).toBe("kelsea");
    expect(d.reason).toBe("lowest Dec volume");
    expect(d.finalRuleId).toBe(R(6).id);
    const r4 = d.trace.find((t) => t.ruleId === R(4).id)!;
    expect(r4).toEqual({ ruleId: R(4).id, hit: true, note: "skipped Lori (off today)" });
    const r5 = d.trace.find((t) => t.ruleId === R(5).id)!;
    expect(r5.note).toBe(
      "nobody on shift now · next in: Kelsea 9 AM tomorrow → standard rule picks between them",
    );
  });

  it("L-1060 (HPN · 18 · birthday · kids) → R2 `routed to Guest Services`", () => {
    const d = assignDecision(QUEUE_LEADS["L-1060"], ctx);
    expect(d.rep?.slug).toBe("gs");
    expect(d.reason).toBe("routed to Guest Services");
    expect(d.finalRuleId).toBe(R(2).id);
    expect(d.outcome).toBe("route");
    expect(d.trace).toEqual([
      { ruleId: "1", hit: false },
      { ruleId: "2", hit: true },
    ]);
  });

  it("L-1059 (HPFM · 120 · school) → R1 `held for Marketing Director`", () => {
    const d = assignDecision(QUEUE_LEADS["L-1059"], ctx);
    expect(d.rep?.slug).toBe("mkt");
    expect(d.reason).toBe("held for Marketing Director");
    expect(d.finalRuleId).toBe(R(1).id);
    expect(d.outcome).toBe("hold");
    expect(d.trace).toEqual([{ ruleId: "1", hit: true }]);
  });
});

describe("assignDecision at the second clock — 2026-09-12T14:00-04:00", () => {
  const ctx = prototypeContext({ now: PROTOTYPE_NOW_AFTERNOON });

  it("L-1061 → R5 / Kelsea `on shift now` — she is the only FT candidate on shift", () => {
    const d = assignDecision(QUEUE_LEADS["L-1061"], ctx);
    expect(d.rep?.slug).toBe("kelsea");
    expect(d.reason).toBe("on shift now");
    expect(d.finalRuleId).toBe(R(5).id);
    expect(d.trace.at(-1)).toEqual({
      ruleId: R(5).id,
      hit: true,
      note: "Kelsea is the only one on shift now",
    });
  });

  it("L-1062 → R4 skips Lori, R5 finds Kelsea alone on shift", () => {
    const d = assignDecision(QUEUE_LEADS["L-1062"], ctx);
    expect(d.rep?.slug).toBe("kelsea");
    expect(d.finalRuleId).toBe(R(5).id);
  });

  it("the hold and route rules do not depend on the clock", () => {
    expect(assignDecision(QUEUE_LEADS["L-1060"], ctx).finalRuleId).toBe(R(2).id);
    expect(assignDecision(QUEUE_LEADS["L-1059"], ctx).finalRuleId).toBe(R(1).id);
  });
});

describe("branches the seeded queue never reaches", () => {
  it("two on shift → R5 narrows, R6 picks the lower party-month volume", () => {
    const ctx = prototypeContext({
      now: PROTOTYPE_NOW_AFTERNOON,
      shiftsToday: {
        [REP_ID.kelsea]: { window: { startHour: 10, endHour: 18 }, off: false, offReason: null },
        [REP_ID.lori]: { window: { startHour: 12, endHour: 20 }, off: false, offReason: null },
      },
    });
    const d = assignDecision(QUEUE_LEADS["L-1062"], ctx);
    const r5 = d.trace.find((t) => t.ruleId === "5")!;
    expect(r5.note).toBe("Kelsea and Lori are on shift now → standard rule picks between them");
    // Dec volume: Kelsea 40 / Lori 20 → Lori.
    expect(d.rep?.slug).toBe("lori");
    expect(d.reason).toBe("lowest Dec volume");
    expect(d.finalRuleId).toBe("6");
  });

  it("nobody on shift → the same-day next-shift set only (today beats tomorrow)", () => {
    const ctx = prototypeContext({
      now: new Date("2026-09-12T08:00:00-04:00"),
      shiftsToday: {
        [REP_ID.kelsea]: { window: { startHour: 10, endHour: 18 }, off: false, offReason: null },
        [REP_ID.lori]: { window: null, off: false, offReason: null },
      },
      shiftsTomorrow: {
        [REP_ID.lori]: { window: { startHour: 9, endHour: 17 }, off: false, offReason: null },
      },
    });
    const d = assignDecision(QUEUE_LEADS["L-1062"], ctx);
    const r5 = d.trace.find((t) => t.ruleId === "5")!;
    expect(r5.note).toBe(
      "nobody on shift now · next in: Kelsea 10 AM today → standard rule picks between them",
    );
    expect(d.rep?.slug).toBe("kelsea");
  });

  it("a tie on guests falls to fewest leads, then to roster order", () => {
    const ctx = prototypeContext({
      now: PROTOTYPE_NOW_AFTERNOON,
      shiftsToday: {},
      shiftsTomorrow: {},
      openVolumeByRepMonth: {
        [REP_ID.kelsea]: { "2026-12": { guests: 50, count: 2 } },
        [REP_ID.lori]: { "2026-12": { guests: 50, count: 1 } },
      },
    });
    const d = assignDecision(QUEUE_LEADS["L-1062"], ctx);
    expect(d.trace.find((t) => t.ruleId === "5")?.note).toBe("no upcoming shifts on file");
    expect(d.rep?.slug).toBe("lori");
    const tie = prototypeContext({
      now: PROTOTYPE_NOW_AFTERNOON,
      shiftsToday: {},
      shiftsTomorrow: {},
      openVolumeByRepMonth: {},
    });
    expect(assignDecision(QUEUE_LEADS["L-1062"], tie).rep?.slug).toBe("kelsea");
  });

  it("hold ≥ 100 wins over everything below it; 99 does not", () => {
    const ctx = prototypeContext();
    expect(assignDecision({ ...QUEUE_LEADS["L-1061"], guests: 100 }, ctx).outcome).toBe("hold");
    expect(assignDecision({ ...QUEUE_LEADS["L-1061"], guests: 99 }, ctx).outcome).toBe("assign");
  });

  it("kids' birthday routes to Guest Services; an adult birthday (kids:false) does not", () => {
    const ctx = prototypeContext();
    const kids = assignDecision({ ...QUEUE_LEADS["L-1060"], kids: true }, ctx);
    expect(kids.finalRuleId).toBe("2");
    const unknown = assignDecision({ ...QUEUE_LEADS["L-1060"], kids: undefined }, ctx);
    expect(unknown.finalRuleId).toBe("2"); // the prototype's behaviour when nobody said
    const adult = assignDecision({ ...QUEUE_LEADS["L-1060"], kids: false }, ctx);
    expect(adult.finalRuleId).not.toBe("2");
    expect(adult.rep?.slug).toBe("stephanie");
  });

  it("school ≤ 39 routes to Guest Services; 40 goes to the reps", () => {
    const ctx = prototypeContext();
    const small = assignDecision({ ...QUEUE_LEADS["L-1059"], guests: 39 }, ctx);
    expect(small.finalRuleId).toBe("3");
    expect(small.rep?.slug).toBe("gs");
    const forty = assignDecision({ ...QUEUE_LEADS["L-1059"], guests: 40 }, ctx);
    expect(forty.finalRuleId).toBe("6");
  });

  it("no candidate at the centre → R6 `no eligible rep` → R7 fallback `waits for Jacob`", () => {
    const ctx = prototypeContext({
      reps: prototypeContext().reps.filter((r) => r.slug !== "stephanie"),
    });
    const d = assignDecision({ ...QUEUE_LEADS["L-1060"], kids: false }, ctx);
    expect(d.rep).toBeNull();
    expect(d.reason).toBe("waits for Jacob");
    expect(d.finalRuleId).toBe("7");
    expect(d.outcome).toBe("queue");
    expect(d.trace.find((t) => t.ruleId === "6")).toEqual({
      ruleId: "6",
      hit: false,
      note: "no eligible rep",
    });
    expect(autoPick({ ...QUEUE_LEADS["L-1060"], kids: false }, ctx)?.slug).toBe("gs");
  });

  it("every rule disabled → `no rule matched`, empty trace", () => {
    const ctx = prototypeContext({ rules: RULES.map((r) => ({ ...r, enabled: false })) });
    expect(assignDecision(QUEUE_LEADS["L-1061"], ctx)).toEqual({
      rep: null,
      reason: "no rule matched",
      trace: [],
      outcome: "none",
    });
  });

  it("R1 off → a 120-guest lead goes to the standard rule (the Rules-screen smoke)", () => {
    const rules = RULES.map((r) => (r.id === "1" ? { ...r, enabled: false } : r));
    const d = assignDecision(
      { centre: "HPFM", guests: 120, type: "corporate", eventDate: "2026-10-16" },
      prototypeContext({ rules }),
    );
    expect(d.outcome).toBe("assign");
    expect(d.finalRuleId).toBe("6");
    expect(d.trace.some((t) => t.ruleId === "1")).toBe(false);
  });

  it("a hold/route rule naming a slug that is not on the roster is noted and skipped", () => {
    const rules: AssignmentRule[] = [
      { ...R(1), then: { hold: "nobody" } },
      ...RULES.filter((r) => r.id !== "1"),
    ];
    const d = assignDecision(QUEUE_LEADS["L-1059"], prototypeContext({ rules }));
    expect(d.trace[0]).toEqual({ ruleId: "1", hit: true, note: "no rep 'nobody' on the roster" });
    expect(d.finalRuleId).toBe("6");
  });

  it("rules run in position order, not array order, and only when enabled", () => {
    const shuffled = [R(7), R(6), R(5), R(4), R(3), R(2), R(1)];
    expect(activeRules(shuffled).map((r) => r.id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(activeRules([{ ...R(1), enabled: false }, R(2)]).map((r) => r.id)).toEqual(["2"]);
  });
});

describe("the extra when-clause fields (centre, source, partyMonth)", () => {
  const base: AssignmentRule = {
    id: "9",
    position: 0,
    enabled: true,
    kind: "route",
    label: "x",
    why: null,
    when: {},
    then: { route: "gs" },
  };
  it("match only their own value; absent = any", () => {
    const lead = QUEUE_LEADS["L-1062"];
    expect(whenMatches({ ...base, when: { centre: "HPFM" } }, lead)).toBe(true);
    expect(whenMatches({ ...base, when: { centre: "HPN" } }, lead)).toBe(false);
    expect(whenMatches({ ...base, when: { source: "referral" } }, lead)).toBe(true);
    expect(whenMatches({ ...base, when: { source: "web" } }, lead)).toBe(false);
    expect(whenMatches({ ...base, when: { partyMonth: "2026-12" } }, lead)).toBe(true);
    expect(whenMatches({ ...base, when: { partyMonth: "2026-11" } }, lead)).toBe(false);
    expect(whenMatches({ ...base, when: {} }, lead)).toBe(true);
  });
});

describe("helpers", () => {
  it("candidateReps: active people with role rep at the centre — buckets, holds and directors excluded", () => {
    const ctx = prototypeContext();
    expect(candidateReps(ctx.reps, "HPFM").map((r) => r.slug)).toEqual(["kelsea", "lori"]);
    expect(candidateReps(ctx.reps, "FT").map((r) => r.slug)).toEqual(["kelsea"]);
    expect(candidateReps(ctx.reps, "HPN").map((r) => r.slug)).toEqual(["stephanie"]);
    const inactive = ctx.reps.map((r) => (r.slug === "lori" ? { ...r, active: false } : r));
    expect(candidateReps(inactive, "HPFM").map((r) => r.slug)).toEqual(["kelsea"]);
  });

  it("standardPick returns undefined for no candidates", () => {
    expect(standardPick([], QUEUE_LEADS["L-1061"], prototypeContext())).toBeUndefined();
  });
});

/**
 * B7 — "Who would you like to work with?". The owner's precedence (2026-09-13
 * 14:05) applied to the SEEDED rules and the prototype's roster, so both halves
 * are pinned against the real rule table rather than a hand-made decision.
 */
describe("the planner the guest asked for", () => {
  const ctx = prototypeContext({ now: PROTOTYPE_NOW });
  const asked = (lead: EngineLead, repId: string): EngineLead => ({
    ...lead,
    requestedRepId: repId,
  });

  it("beats the balancing rule: a FastTrax corporate enquiry that asks for Kelsea gets Kelsea", () => {
    const d = assignDecision(asked(QUEUE_LEADS["L-1061"], REP_ID.kelsea), ctx);
    expect(d.rep?.slug).toBe("kelsea");
    expect(d.reason).toBe("guest asked for Kelsea");
    expect(d.outcome).toBe("assign");
    expect(d.requested?.outcome).toBe("honoured");
    expect(d.trace.at(-1)).toEqual({
      ruleId: "guest-request",
      hit: true,
      note: "Guest asked for Kelsea — honoured",
    });
  });

  it("REPLACES the rules' own pick when the guest names the other planner at HeadPinz", () => {
    // The headline acceptance item, proved end to end through the real engine:
    // the answer with the request must DIFFER from the answer without it.
    // HPFM has two candidates (Kelsea, Lori). Lori is on shift in this context
    // — the seeded roster has her on PTO, which is R4's job, not this one — so
    // R6 picks her for December on volume (20 guests vs Kelsea's 40). The guest
    // asks for Kelsea, and Kelsea gets it.
    const onShift = prototypeContext({
      now: PROTOTYPE_NOW,
      shiftsToday: {
        ...SHIFTS_TODAY,
        // Kelsea's own Saturday window, so 19:30 is still "nobody on shift"
        // and R5 stays non-decisive — only R6 vs the request is under test.
        [REP_ID.lori]: { window: { startHour: 10, endHour: 18 }, off: false, offReason: null },
      },
    });
    const december = { ...QUEUE_LEADS["L-1062"], eventDate: "2026-12-11" };

    const rules = decideByRules(december, onShift);
    expect(rules.rep!.slug).toBe("lori");
    expect(rules.reason).toBe("lowest Dec volume");

    const d = assignDecision(asked(december, REP_ID.kelsea), onShift);
    expect(d.rep!.slug).not.toBe(rules.rep!.slug);
    expect(d.rep!.slug).toBe("kelsea");
    expect(d.reason).toBe("guest asked for Kelsea");
    expect(d.outcome).toBe("assign");
    expect(d.requested?.outcome).toBe("honoured");
    // Not a stored rule — nothing in crm_assignment_rules decided this.
    expect(d.finalRuleId).toBeUndefined();
    expect(d.trace.at(-1)).toEqual({
      ruleId: "guest-request",
      hit: true,
      note: "Guest asked for Kelsea — honoured, ahead of lowest Dec volume",
    });
  });

  it("R4 still wins when the guest names a planner who is off today", () => {
    // R6 would pick Kelsea for December (40 guests vs Lori's 20 — Lori is off
    // today, so R4 removes her; ask for her anyway and R4 still wins).
    const december = { ...QUEUE_LEADS["L-1062"], eventDate: "2026-12-11" };
    const plain = assignDecision(december, ctx);
    expect(plain.rep?.slug).toBe("kelsea");

    const d = assignDecision(asked(december, REP_ID.lori), ctx);
    expect(d.requested?.outcome).toBe("unavailable");
    expect(d.rep?.slug).toBe("kelsea");
    expect(d.reason).toBe("lowest Dec volume");
    expect(d.trace.at(-1)!.note).toBe(
      "Guest asked for Lori — they are off today, so the lead is worked by Kelsea",
    );
  });

  it("does NOT beat R1: a 120-guest enquiry is still held for the Marketing Director", () => {
    const d = assignDecision(asked(QUEUE_LEADS["L-1059"], REP_ID.kelsea), ctx);
    expect(d.rep?.slug).toBe("mkt");
    expect(d.outcome).toBe("hold");
    expect(d.requested?.outcome).toBe("overridden");
    expect(d.requested?.overriddenBy).toBe("1");
    expect(d.trace.at(-1)!.note).toBe(
      "Guest asked for Kelsea — held for Marketing Director takes precedence",
    );
  });

  it("does NOT beat R2: a kids' birthday still goes to Guest Services, request ignored", () => {
    const d = assignDecision(asked(QUEUE_LEADS["L-1060"], REP_ID.stephanie), ctx);
    expect(d.rep?.slug).toBe("gs");
    expect(d.outcome).toBe("route");
    expect(d.requested?.outcome).toBe("ignored");
    expect(d.requested?.honoured).toBe(false);
  });

  it("a planner who does not sell at that centre is not honoured", () => {
    const d = assignDecision(asked(QUEUE_LEADS["L-1061"], REP_ID.lori), ctx);
    expect(d.rep?.slug).toBe("kelsea");
    expect(d.reason).toBe("lowest Oct volume");
    expect(d.requested?.outcome).toBe("unknown");
  });

  it("the Guest Services bucket and the Marketing hold row are not requestable", () => {
    for (const id of [REP_ID.gs, REP_ID.mkt, REP_ID.jacob]) {
      const d = assignDecision(asked(QUEUE_LEADS["L-1061"], id), ctx);
      expect(d.requested?.outcome).toBe("unknown");
      expect(d.rep?.slug).toBe("kelsea");
    }
  });

  it("an id nobody on the roster carries is ignored, never a crash", () => {
    const d = assignDecision(asked(QUEUE_LEADS["L-1061"], "999999"), ctx);
    expect(d.rep?.slug).toBe("kelsea");
    expect(d.requested).toBeUndefined();
  });

  it("no request → byte-identical to the rules' own decision, with no extra trace row", () => {
    for (const lead of Object.values(QUEUE_LEADS)) {
      const plain = decideByRules(lead, ctx);
      const full = assignDecision(lead, ctx);
      expect(full).toEqual(plain);
      expect(full.trace.some((t) => t.ruleId === "guest-request")).toBe(false);
    }
  });
});
