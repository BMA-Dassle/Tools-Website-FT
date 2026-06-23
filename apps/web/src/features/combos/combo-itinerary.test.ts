import { describe, expect, it } from "vitest";

import { buildChainFrom, buildChains, wallClockMs, type LegCandidate } from "./combo-itinerary";
import { candidatesForOrdering } from "./combo-booking";
import { getComboSpecial } from "./combo-specials";

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

describe("buildChainFrom — per-leg min waits (reorder: ≥1 session between races)", () => {
  const anchor = cand("20:48", 7, "s8"); // 8:48 Starter, ends 8:55
  const ints = [cand("21:12", 7, "i912"), cand("21:24", 7, "i924")];

  it("minWait skips the too-close heat (≥20 min → 9:12 out, 9:24 in)", () => {
    // floor = 8:55 + max(15, 20) = 9:15; max 45 → latest 9:40.
    const chain = buildChainFrom([[anchor], ints], 15, anchor, undefined, [null, 45], [null, 20]);
    expect(chain?.map((c) => c.payload)).toEqual(["s8", "i924"]);
  });

  it("min + max together can leave nothing (≥20 but ≤25 → 9:24 too late)", () => {
    // floor 9:15, latest = 8:55 + 25 = 9:20 → 9:24 excluded.
    const chain = buildChainFrom([[anchor], ints], 15, anchor, undefined, [null, 25], [null, 20]);
    expect(chain).toBeNull();
  });
});

describe("candidatesForOrdering — reindex onto the fallback order", () => {
  const combo = getComboSpecial("race-bowl")!;

  it("maps primary [starter, bowl, inter] arrays onto fallback [starter, inter, bowl]", () => {
    const primary = combo.components.map((_, i) => [cand("12:00", 1, `leg${i}`)]);
    const reindexed = candidatesForOrdering(combo.components, primary, combo.fallbackComponents!);
    expect(reindexed[0]).toBe(primary[0]); // starter
    expect(reindexed[1]).toBe(primary[2]); // intermediate
    expect(reindexed[2]).toBe(primary[1]); // bowling — reused, never refetched
  });
});

describe("reorder fallback — 6/23 Mega scenario (real registry config)", () => {
  const combo = getComboSpecial("race-bowl")!;
  // Live 6/23 shape: races all day; VIP lanes free 1:00–3:30 PM and 9:00–10:30 PM
  // (Have-A-Ball owns 4–8:30 PM); Mega Intermediate heats sparse 6–8 PM.
  const starters = [cand("14:00", 7, "S2pm"), cand("18:00", 7, "S6pm"), cand("20:48", 7, "S8pm")];
  const vip = [
    "13:00",
    "13:30",
    "14:00",
    "14:30",
    "15:00",
    "15:30",
    "21:00",
    "21:30",
    "22:00",
    "22:30",
  ].map((t) => cand(t, 90, `V${t}`));
  const inter = [
    cand("16:36", 7, "I436"),
    cand("20:12", 7, "I812"),
    cand("21:24", 7, "I924"),
    cand("22:00", 7, "I10"),
  ];

  const normalLegs = [starters, vip, inter];
  const fallbackLegs = candidatesForOrdering(
    combo.components,
    normalLegs,
    combo.fallbackComponents!,
  );
  const normalChains = buildChains(
    normalLegs,
    combo.transitionMinutes,
    combo.components.map((l) => l.maxWaitMinutes ?? null),
    combo.components.map((l) => l.minWaitMinutes ?? null),
  );
  const fbChains = buildChains(
    fallbackLegs,
    combo.transitionMinutes,
    combo.fallbackComponents!.map((l) => l.maxWaitMinutes ?? null),
    combo.fallbackComponents!.map((l) => l.minWaitMinutes ?? null),
  );
  const by = (chains: typeof normalChains, tag: string) =>
    chains.find((c) => c.anchor.payload === tag)?.chain ?? null;

  it("2 PM works in the NORMAL order (afternoon VIP window)", () => {
    expect(by(normalChains, "S2pm")).not.toBeNull();
  });

  it("8 PM fails NORMAL but the reorder rescues it: race → race → lane 10 PM", () => {
    expect(by(normalChains, "S8pm")).toBeNull();
    expect(by(fbChains, "S8pm")?.map((c) => c.payload)).toEqual(["S8pm", "I924", "V22:00"]);
  });

  it("6 PM stays dead even with the reorder (no Intermediate within the 45-min cap)", () => {
    expect(by(normalChains, "S6pm")).toBeNull();
    expect(by(fbChains, "S6pm")).toBeNull();
  });
});
