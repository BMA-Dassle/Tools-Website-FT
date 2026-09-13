import { describe, expect, it, vi } from "vitest";
import {
  PROTOTYPE_NOW,
  PROTOTYPE_NOW_AFTERNOON,
  prototypeContext,
} from "~/features/crm/rules/test-support";
import { QUEUE_LEADS, PROTO_NOW, ALL_REPS, REPS, asRequestedRep, makeLead } from "../test-support";
import { NO_SUGGESTION, suggestFor, toEngineLead } from "./suggest";

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
  });

  it("L-1059 (120 guests) → R1 held for the Marketing Director", async () => {
    const r = await suggestFor(lead("L-1059"), {
      now: PROTOTYPE_NOW,
      engine: prototypeContext({ now: PROTOTYPE_NOW }),
    });
    expect(r.outcome).toBe("hold");
    expect(r.suggestion?.rep.slug).toBe("mkt");
    expect(r.suggestion?.reason).toBe("held for Marketing Director");
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

  // Owner, 2026-09-13 14:50: every resolved decision is applied at capture, so
  // there is nothing left for an `isImmediate` predicate to say. The seam's only
  // question is whether the engine named anybody.
  it("every outcome that names a rep resolves one; queue and none resolve nobody", async () => {
    const resolved = await Promise.all(
      ["L-1061", "L-1060", "L-1059"].map((id) =>
        suggestFor(lead(id), {
          now: PROTOTYPE_NOW,
          engine: prototypeContext({ now: PROTOTYPE_NOW }),
        }),
      ),
    );
    expect(resolved.map((r) => r.outcome)).toEqual(["assign", "route", "hold"]);
    expect(resolved.every((r) => r.suggestion !== null)).toBe(true);

    const unresolved = await suggestFor(lead("L-1061"), {
      now: PROTOTYPE_NOW,
      engine: prototypeContext({ now: PROTOTYPE_NOW, reps: [], openVolumeByRepMonth: {} }),
    });
    expect(["queue", "none"]).toContain(unresolved.outcome);
    expect(unresolved.suggestion).toBeNull();
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

  it("toEngineLead reads the fields the rules test, `kids` and the guest's planner included", () => {
    const l = makeLead({ id: "1", centre: "HPN", guests: 18, type: "birthday", kids: true });
    expect(toEngineLead(l)).toEqual({
      centre: "HPN",
      guests: 18,
      type: "birthday",
      eventDate: l.eventDate,
      source: l.source,
      kids: true,
      requestedRepId: null,
    });
    expect(ALL_REPS.length).toBeGreaterThan(0);
  });

  // B7 — the guest's planner, weighed by the engine and read back through the seam.
  describe("the planner the guest asked for", () => {
    const engine = () => prototypeContext({ now: PROTOTYPE_NOW });

    it("reaches the engine as an id off the lead row", () => {
      const l = makeLead({ id: "2", centre: "FT", requestedRep: asRequestedRep(REPS.kelsea) });
      expect(toEngineLead(l).requestedRepId).toBe(REPS.kelsea.id);
    });

    it("honoured: the seam returns that planner, and it applies AT CAPTURE", async () => {
      const l = makeLead({
        id: "3",
        centre: "FT",
        guests: 42,
        type: "corporate",
        eventDate: "2026-10-16",
        requestedRep: { id: "1", slug: "kelsea", firstName: "Kelsea", displayName: "Kelsea Kosco" },
      });
      const r = await suggestFor(l, { now: PROTOTYPE_NOW, engine: engine() });
      expect(r.suggestion?.rep.slug).toBe("kelsea");
      expect(r.suggestion?.reason).toBe("guest asked for Kelsea");
      expect(r.requested?.honoured).toBe(true);
      // The step reads as a step on the trace, not as a mystery rule id.
      expect(r.trace.at(-1)).toMatchObject({
        code: "GUEST",
        label: "Guest's choice of planner",
        hit: true,
      });
    });

    it("overridden by a hold: carried on the trace, and the hold still applies", async () => {
      const l = makeLead({
        id: "4",
        centre: "HPFM",
        guests: 120,
        type: "school",
        eventDate: "2026-11-20",
        requestedRep: { id: "1", slug: "kelsea", firstName: "Kelsea", displayName: "Kelsea Kosco" },
      });
      const r = await suggestFor(l, { now: PROTOTYPE_NOW, engine: engine() });
      expect(r.suggestion?.rep.slug).toBe("mkt");
      expect(r.requested?.outcome).toBe("overridden");
      expect(r.trace.at(-1)!.note).toContain("takes precedence");
    });

    it("a lead with no request carries no verdict at all", async () => {
      const r = await suggestFor(lead("L-1061"), {
        now: PROTOTYPE_NOW,
        engine: engine(),
      });
      expect(r.requested).toBeUndefined();
    });
  });
});
