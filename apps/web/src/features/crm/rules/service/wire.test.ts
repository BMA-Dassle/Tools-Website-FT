import { describe, expect, it } from "vitest";
import {
  PROTOTYPE_NOW,
  QUEUE_LEADS,
  REPS,
  REP_ID,
  RULES,
  SHIFTS_TODAY,
  SHIFTS_TOMORROW,
  prototypeContext,
} from "../test-support";
import { assignDecision } from "./engine";
import { nowLabel, rosterDateLabel, ruleCode, toDecisionWire, toRosterRows } from "./wire";

/** Engine output and the roster as the client receives them; the two ET labels. */

describe("ruleCode / toDecisionWire", () => {
  it("codes come from position; the trace carries code + label; the rep is the public projection", () => {
    expect(ruleCode({ position: 3 })).toBe("R3");
    const d = assignDecision(QUEUE_LEADS["L-1061"], prototypeContext());
    const w = toDecisionWire(d, RULES);
    expect(w.finalRuleCode).toBe("R6");
    expect(w.finalRuleId).toBe("6");
    expect(w.outcome).toBe("assign");
    expect(w.trace.map((t) => t.code)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
    expect(w.trace[0].label).toBe("Big groups go to Marketing");
    expect(w.trace[5].note).toBe("Kelsea has the lowest Oct volume (60 guests in 1 leads)");
    expect(w.rep).toEqual({
      id: "1",
      slug: "kelsea",
      displayName: "Kelsea Kosco",
      firstName: "Kelsea",
      initials: "KK",
      role: "rep",
      centres: ["HPFM", "FT"],
    });
  });

  it("a queued decision has rep null and finalRuleCode R7; an unknown rule id keeps the id as the code", () => {
    const d = assignDecision(
      { ...QUEUE_LEADS["L-1060"], kids: false },
      prototypeContext({ reps: REPS.filter((r) => r.slug !== "stephanie") }),
    );
    const w = toDecisionWire(d, RULES);
    expect(w.rep).toBeNull();
    expect(w.finalRuleCode).toBe("R7");
    const orphan = toDecisionWire(
      { ...d, trace: [{ ruleId: "999", hit: false }], finalRuleId: undefined },
      RULES,
    );
    expect(orphan.trace[0]).toEqual({ ruleId: "999", hit: false, code: "999", label: "999" });
    expect(orphan.finalRuleCode).toBeNull();
  });

  it("B7's guest-request STEP reads as a step, not as a missing rule", () => {
    const d = assignDecision(
      { ...QUEUE_LEADS["L-1061"], requestedRepId: REP_ID.kelsea },
      prototypeContext(),
    );
    const w = toDecisionWire(d, RULES);
    expect(w.trace.at(-1)).toEqual({
      ruleId: "guest-request",
      hit: true,
      note: "Guest asked for Kelsea — honoured",
      code: "GUEST",
      label: "Guest's choice of planner",
    });
  });
});

describe("toRosterRows", () => {
  it("one row per non-director rep with windows, override and status at 19:30 ET", () => {
    const rows = toRosterRows(REPS, {
      shiftsToday: SHIFTS_TODAY,
      shiftsTomorrow: SHIFTS_TOMORROW,
      now: PROTOTYPE_NOW,
    });
    expect(rows.map((r) => r.rep.slug)).toEqual(["kelsea", "lori", "stephanie", "gs", "mkt"]);
    expect(rows[0]).toEqual({
      rep: expect.objectContaining({ slug: "kelsea" }),
      today: { startHour: 10, endHour: 18, label: "10 AM – 6 PM" },
      tomorrow: { startHour: 9, endHour: 17, label: "9 AM – 5 PM" },
      offToday: false,
      offReason: null,
      status: { kind: "next", label: "Next 9 AM tomorrow" },
    });
    expect(rows[1]).toMatchObject({
      today: null,
      offToday: true,
      offReason: "PTO",
      status: { kind: "off", label: "Off · PTO" },
    });
    expect(rows[2].status).toEqual({ kind: "on", label: "On shift" });
    expect(rows[4]).toMatchObject({
      today: null,
      status: { kind: "next", label: "Next 9 AM tomorrow" },
    });
  });
});

describe("labels", () => {
  it("rosterDateLabel = 'Sat Sep 12'; nowLabel rounds down to the half hour, ET weekday", () => {
    expect(rosterDateLabel(PROTOTYPE_NOW)).toBe("Sat Sep 12");
    expect(nowLabel(PROTOTYPE_NOW)).toBe("7:30 PM on a Saturday");
    expect(nowLabel(new Date("2026-09-12T19:44:00-04:00"))).toBe("7:30 PM on a Saturday");
    expect(nowLabel(new Date("2026-09-12T14:10:00-04:00"))).toBe("2 PM on a Saturday");
    // 03:10Z Sunday is still Saturday 11:10 PM in ET.
    expect(nowLabel(new Date("2026-09-13T03:10:00Z"))).toBe("11 PM on a Saturday");
    expect(rosterDateLabel(new Date("2026-09-13T03:10:00Z"))).toBe("Sat Sep 12");
  });
});
