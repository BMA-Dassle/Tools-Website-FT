import { describe, expect, it } from "vitest";

import { buildChainFrom, buildChains, wallClockMs, type LegCandidate } from "./combo-itinerary";

/** Candidate from naive ET wall-clock times on 2026-06-01. */
function cand(start: string, minutes: number, payload = ""): LegCandidate<string> {
  const startIso = `2026-06-01T${start}:00Z`;
  return {
    startIso,
    startMs: wallClockMs(startIso),
    endMs: wallClockMs(startIso) + minutes * 60_000,
    payload,
  };
}

describe("wallClockMs — vendor zone normalization", () => {
  it("BMI wall-clock-in-Z and QAMF offset ISOs compare on the same axis", () => {
    // Both mean 2:00 PM ET wall clock.
    expect(wallClockMs("2026-06-01T14:00:00Z")).toBe(wallClockMs("2026-06-01T14:00:00-04:00"));
  });
});

describe("buildChains — greedy-earliest itinerary assembly", () => {
  // Race ~12 min heats; bowling 90 min; 15-min transitions.
  const starters = [cand("13:00", 12, "s1"), cand("14:00", 12, "s2"), cand("21:30", 12, "s3")];
  const lanes = [cand("13:30", 90, "b1"), cand("14:30", 90, "b2"), cand("15:30", 90, "b3")];
  const intermediates = [cand("15:15", 12, "i1"), cand("16:30", 12, "i2"), cand("17:30", 12, "i3")];

  it("anchors on every first-leg candidate and picks the earliest valid chain", () => {
    const results = buildChains([starters, lanes, intermediates], 15);
    expect(results).toHaveLength(3);

    // 1:00 starter ends 1:12 → +15 = 1:27 → earliest lane 1:30; bowl ends 3:00
    // → +15 = 3:15 → earliest intermediate 3:15.
    const r0 = results.find((r) => r.anchor.payload === "s1")!;
    expect(r0.chain?.map((c) => c.payload)).toEqual(["s1", "b1", "i1"]);

    // 2:00 starter ends 2:12 → lane 2:30; ends 4:00 → +15 = 4:15 → int 4:30.
    const r1 = results.find((r) => r.anchor.payload === "s2")!;
    expect(r1.chain?.map((c) => c.payload)).toEqual(["s2", "b2", "i2"]);
  });

  it("marks a late starter infeasible when nothing fits after it", () => {
    const r = buildChains([starters, lanes, intermediates], 15).find(
      (x) => x.anchor.payload === "s3",
    )!;
    expect(r.chain).toBeNull();
  });

  it("transition buffer is enforced, not just ordering", () => {
    // Lane at exactly starter-end + 14 min → too soon with a 15-min buffer.
    const tight = [cand("13:26", 90, "tight"), cand("13:27", 90, "ok")];
    const ints = [cand("18:00", 12, "i")];
    const r = buildChains([[cand("13:00", 12, "s")], tight, ints], 15)[0];
    expect(r.chain?.map((c) => c.payload)).toEqual(["s", "ok", "i"]);
  });

  it("handles arbitrary leg counts (future combos)", () => {
    // race → bowl → race → bowl: 4 legs, still chains.
    const r = buildChains(
      [
        [cand("12:00", 12, "r1")],
        [cand("12:30", 90, "b1")],
        [cand("14:30", 12, "r2")],
        [cand("15:00", 60, "b2")],
      ],
      15,
    )[0];
    expect(r.chain?.map((c) => c.payload)).toEqual(["r1", "b1", "r2", "b2"]);
  });

  it("empty leg candidates → every anchor infeasible", () => {
    const r = buildChains([[cand("12:00", 12, "s")], []], 15)[0];
    expect(r.chain).toBeNull();
  });
});

describe("buildChains — per-leg max waits (lane within 60 min of race 1)", () => {
  const starters = [cand("13:00", 12, "s1"), cand("14:00", 12, "s2")];
  const ints = [cand("18:00", 12, "i")];

  it("a lane starting past the 60-min window makes the start infeasible", () => {
    // s1 ends 13:12 → window [13:27, 14:12]. Lane at 14:30 is too late for s1
    // but fine for s2 (ends 14:12 → window [14:27, 15:12]).
    const lanes = [cand("14:30", 90, "late-lane")];
    const results = buildChains([starters, lanes, ints], 15, [null, 60, null]);
    expect(results.find((r) => r.anchor.payload === "s1")!.chain).toBeNull();
    expect(results.find((r) => r.anchor.payload === "s2")!.chain?.map((c) => c.payload)).toEqual([
      "s2",
      "late-lane",
      "i",
    ]);
  });

  it("a lane inside the window keeps the start available", () => {
    const lanes = [cand("13:45", 90, "ok-lane")];
    const r = buildChains([starters, lanes, ints], 15, [null, 60, null]).find(
      (x) => x.anchor.payload === "s1",
    )!;
    expect(r.chain?.map((c) => c.payload)).toEqual(["s1", "ok-lane", "i"]);
  });

  it("no max wait → distant legs still chain (legacy behavior)", () => {
    const lanes = [cand("16:00", 90, "far-lane")];
    const r = buildChains([starters, lanes, ints], 15)[0];
    expect(r.chain?.map((c) => c.payload)).toEqual(["s1", "far-lane", "i"]);
  });
});

describe("buildChainFrom — per-leg filters (track choice in the confirm modal)", () => {
  const anchor = cand("13:00", 12, "s");
  const lanes = [cand("13:30", 90, "b")];
  const ints = [cand("15:15", 12, "int-red"), cand("16:00", 12, "int-blue")];

  it("no filter → earliest candidate per leg", () => {
    const chain = buildChainFrom([[anchor], lanes, ints], 15, anchor);
    expect(chain?.map((c) => c.payload)).toEqual(["s", "b", "int-red"]);
  });

  it("a leg filter steers the pick (e.g. Blue track for the second race)", () => {
    const chain = buildChainFrom([[anchor], lanes, ints], 15, anchor, [
      null,
      null,
      (c) => c.payload === "int-blue",
    ]);
    expect(chain?.map((c) => c.payload)).toEqual(["s", "b", "int-blue"]);
  });

  it("returns null when the filtered leg has nothing that fits", () => {
    const chain = buildChainFrom([[anchor], lanes, ints], 15, anchor, [null, null, () => false]);
    expect(chain).toBeNull();
  });
});
