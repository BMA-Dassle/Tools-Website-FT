import { describe, expect, it, vi } from "vitest";
import {
  PROTOTYPE_NOW,
  PROTOTYPE_NOW_AFTERNOON,
  prototypeContext,
} from "~/features/crm/rules/test-support";
import { QUEUE_LEADS, PROTO_NOW, ALL_REPS, makeLead } from "../test-support";
import { NO_SUGGESTION, isImmediate, suggestFor, toEngineLead } from "./suggest";

/**
 * The engine seam, wired (B2's `assignDecision` over B2's seeded rules).
 *
 * The four queue leads are the prototype's own (`crm-data.js:63-82`) and the
 * expectations are the ones §3.10 pins AT THE PROTOTYPE'S CLOCK (19:30 ET):
 * L-1061 → R6 Kelsea "lowest Oct volume", L-1060 → R3 Guest Services,
 * L-1059 → R1 held for the Marketing Director, L-1062 → R6 Kelsea after R4
 * skips Lori. At 14:00 ET, L-1061 is R5 instead — Kelsea is the only one on
 * shift — which is the whole reason `ctx.now` is injected and never read off
 * the runner's UTC clock.
 *
 * `ctx.engine` is the loaded context; the tests pass the prototype's so the
 * engine is exercised without Neon.
 */

const lead = (publicId: string) => QUEUE_LEADS.find((l) => l.publicId === publicId)!;

describe("suggestFor", () => {
  it("L-1061 (42 corporate, FT, Oct) → R6 Kelsea, lowest Oct volume", async () => {
    const r = await suggestFor(lead("L-1061"), {
      now: PROTOTYPE_NOW,
      engine: prototypeContext({ now: PROTOTYPE_NOW }),
    });
    expect(r.outcome).toBe("assign");
    expect(r.suggestion?.rep.slug).toBe("kelsea");
    expect(r.suggestion?.reason).toBe("lowest Oct volume");
    expect(r.suggestion?.finalRuleLabel).toBe("R6");
    expect(r.trace.at(-1)).toMatchObject({ code: "R6", hit: true });
    // Every row carries the rule's label AND its database id — the id is what
    // `crm_assignments.rule_id` stores.
    expect(r.trace.every((t) => typeof t.label === "string" && t.label.length > 0)).toBe(true);
    expect(r.suggestion?.ruleId).toBe(r.trace.at(-1)!.ruleId);
  });

  it("L-1060 (kids' birthday, Naples) → R3 routed to Guest Services", async () => {
    const r = await suggestFor(lead("L-1060"), {
      now: PROTOTYPE_NOW,
      engine: prototypeContext({ now: PROTOTYPE_NOW }),
    });
    expect(r.outcome).toBe("route");
    expect(r.suggestion?.rep.slug).toBe("gs");
    expect(r.suggestion?.reason).toBe("routed to Guest Services");
    expect(isImmediate(r.outcome)).toBe(true);
  });

  it("L-1059 (120 guests) → R1 held for the Marketing Director, and that is immediate", async () => {
    const r = await suggestFor(lead("L-1059"), {
      now: PROTOTYPE_NOW,
      engine: prototypeContext({ now: PROTOTYPE_NOW }),
    });
    expect(r.outcome).toBe("hold");
    expect(r.suggestion?.rep.slug).toBe("mkt");
    expect(r.suggestion?.reason).toBe("held for Marketing Director");
    expect(isImmediate(r.outcome)).toBe(true);
  });

  it("L-1062 (Dec holiday party) → R4 skips Lori, R6 picks Kelsea", async () => {
    const r = await suggestFor(lead("L-1062"), {
      now: PROTOTYPE_NOW,
      engine: prototypeContext({ now: PROTOTYPE_NOW }),
    });
    expect(r.suggestion?.rep.slug).toBe("kelsea");
    const skip = r.trace.find((t) => t.note?.includes("off today"));
    expect(skip?.note).toContain("Lori");
  });

  it("the clock decides: at 14:00 ET L-1061 is R5, Kelsea the only one on shift", async () => {
    const r = await suggestFor(lead("L-1061"), {
      now: PROTOTYPE_NOW_AFTERNOON,
      engine: prototypeContext({ now: PROTOTYPE_NOW_AFTERNOON }),
    });
    expect(r.outcome).toBe("assign");
    expect(r.suggestion?.reason).toBe("on shift now");
    expect(r.suggestion?.finalRuleLabel).toBe("R5");
  });

  it("a balancing pick is NOT immediate — the sweep's delay owns it", async () => {
    const r = await suggestFor(lead("L-1061"), {
      now: PROTOTYPE_NOW,
      engine: prototypeContext({ now: PROTOTYPE_NOW }),
    });
    expect(isImmediate(r.outcome)).toBe(false);
  });

  it("no rule resolves anyone → suggestion null, the trace still explains why", async () => {
    const r = await suggestFor(lead("L-1061"), {
      now: PROTOTYPE_NOW,
      engine: prototypeContext({ now: PROTOTYPE_NOW, reps: [], openVolumeByRepMonth: {} }),
    });
    expect(r.suggestion).toBeNull();
    expect(r.outcome).not.toBe("assign");
    expect(r.trace.length).toBeGreaterThan(0);
  });

  it("a lead is never lost to a broken engine: the load throwing answers NO_SUGGESTION", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rules = await import("~/features/crm/rules");
    const spy = vi
      .spyOn(rules, "loadEngineContext")
      .mockRejectedValue(new Error("no DATABASE_URL"));
    try {
      const r = await suggestFor(lead("L-1061"), { now: PROTO_NOW });
      expect(r).toEqual({ suggestion: null, trace: [], outcome: "none" });
      expect(err).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });

  it("NO_SUGGESTION is the frozen empty answer", () => {
    expect(NO_SUGGESTION).toEqual({ suggestion: null, trace: [], outcome: "none" });
    expect(Object.isFrozen(NO_SUGGESTION)).toBe(true);
  });

  it("toEngineLead reads the six fields the rules test, `kids` included", () => {
    const l = makeLead({ id: "1", centre: "HPN", guests: 18, type: "birthday", kids: true });
    expect(toEngineLead(l)).toEqual({
      centre: "HPN",
      guests: 18,
      type: "birthday",
      eventDate: l.eventDate,
      source: l.source,
      kids: true,
    });
    expect(ALL_REPS.length).toBeGreaterThan(0);
  });
});
