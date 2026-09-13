import { describe, expect, it } from "vitest";
import { QUEUE_LEADS, PROTO_NOW, ALL_REPS } from "../test-support";
import { NO_SUGGESTION, suggestFor } from "./suggest";

/**
 * The engine seam before B2 is wired: every lead gets `suggestion: null`,
 * `trace: []` — never a throw, never a guess. The follow-up stage that points
 * this at `assignDecision` replaces these expectations with the seeded
 * scenarios (L-1061 → R6 Kelsea, L-1060 → R3 Guest Services, …).
 */
describe("suggestFor (stub)", () => {
  it("answers null / [] for every seeded queue lead, with or without a context", async () => {
    for (const lead of QUEUE_LEADS) {
      expect(await suggestFor(lead)).toEqual({ suggestion: null, trace: [] });
      expect(await suggestFor(lead, { now: PROTO_NOW, reps: ALL_REPS })).toEqual({
        suggestion: null,
        trace: [],
      });
    }
  });

  it("NO_SUGGESTION is the frozen empty answer", () => {
    expect(NO_SUGGESTION).toEqual({ suggestion: null, trace: [] });
    expect(Object.isFrozen(NO_SUGGESTION)).toBe(true);
  });
});
