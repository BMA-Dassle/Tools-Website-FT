import { describe, it, expect } from "vitest";
import {
  derivePackagePicks,
  packageComponentsCovered,
  rosterSyncPlan,
  FALLBACK_HEAT_MINUTES,
  type PackageProposalLite,
} from "./package-picks";
import { getPackage } from "./packages";
import type { RaceHeatAssignment } from "../state/types";

// Real registry: UQ weekday adult — Starter (Red 24960859 + Blue 24960393),
// Intermediate (package-only SKUs 45810802 Red / 45811366 Blue).
const UQ = getPackage("ultimate-qualifier-weekday")!;
const STARTER = UQ.races.find((c) => c.ref === "starter")!;
const INTERMEDIATE = UQ.races.find((c) => c.ref !== "starter")!;
const STARTER_BLUE = STARTER.tracks.find((t) => t.track === "Blue")!.productId;
const INT_BLUE = INTERMEDIATE.tracks.find((t) => t.track === "Blue")!.productId;

function heat(over: Partial<RaceHeatAssignment>): RaceHeatAssignment {
  return {
    productId: STARTER_BLUE,
    track: "Blue",
    tier: "starter",
    category: "adult",
    heatId: "2026-07-01T15:00:00",
    bmiLineId: "L1",
    assignedTo: "r1",
    ...over,
  };
}

const proposal = (
  productId: string,
  start: string,
  stop: string,
  track: string | null = "Blue",
): PackageProposalLite => ({ productId, track, start, stop });

describe("derivePackagePicks — heats → per-component picks", () => {
  it("reconstructs both components with proposal-resolved stops", () => {
    const heats = [
      heat({}),
      heat({ productId: INT_BLUE, tier: "intermediate", heatId: "2026-07-01T16:12:00" }),
    ];
    const picks = derivePackagePicks(UQ, heats, "adult", [
      proposal(STARTER_BLUE, "2026-07-01T15:00:00", "2026-07-01T15:10:00"),
      proposal(INT_BLUE, "2026-07-01T16:12:00", "2026-07-01T16:22:00"),
    ]);
    expect(picks.size).toBe(2);
    const starter = picks.get(STARTER.ref)!;
    expect(starter.stop).toBe("2026-07-01T15:10:00");
    expect(starter.synthesized).toBe(false);
    expect(picks.get(INTERMEDIATE.ref)!.start).toBe("2026-07-01T16:12:00");
  });

  it("dedupes shared picks (two racers, one physical heat) to one pick", () => {
    const heats = [heat({ assignedTo: "r1" }), heat({ assignedTo: "r2" })];
    const picks = derivePackagePicks(UQ, heats, "adult", [
      proposal(STARTER_BLUE, "2026-07-01T15:00:00", "2026-07-01T15:10:00"),
    ]);
    expect(picks.size).toBe(1);
  });

  it("falls back to (track, start) then to a synthesized conservative stop", () => {
    const heats = [heat({})];
    // No exact productId match, but a same-track same-start proposal exists.
    const byTrack = derivePackagePicks(UQ, heats, "adult", [
      proposal("some-other-product", "2026-07-01T15:00:00", "2026-07-01T15:11:00", "Blue"),
    ]);
    expect(byTrack.get(STARTER.ref)!.stop).toBe("2026-07-01T15:11:00");
    expect(byTrack.get(STARTER.ref)!.synthesized).toBe(false);
    // Nothing matches → estimated stop, flagged synthesized.
    const synth = derivePackagePicks(UQ, heats, "adult", []);
    const pick = synth.get(STARTER.ref)!;
    expect(pick.synthesized).toBe(true);
    expect(pick.stop).toBe(`2026-07-01T15:${String(FALLBACK_HEAT_MINUTES).padStart(2, "0")}:00`);
  });

  it("scopes by category and package SKUs (mixed party + single-race heats never leak in)", () => {
    const heats = [
      heat({ category: "junior", assignedTo: "j1" }), // junior heat on an adult grid
      heat({ productId: "24960859-not-in-pkg" as string, heatId: "2026-07-01T15:12:00" }),
    ];
    // Junior heat excluded by category; unknown product excluded by SKU scope.
    const picks = derivePackagePicks(UQ, heats, "adult", []);
    expect(picks.size).toBe(0);
  });

  it("normalizes ISO variants when matching proposals", () => {
    const heats = [heat({ heatId: "2026-07-01T15:00:00" })];
    const picks = derivePackagePicks(UQ, heats, "adult", [
      proposal(STARTER_BLUE, "2026-07-01T15:00:00.000Z", "2026-07-01T15:10:00"),
    ]);
    expect(picks.get(STARTER.ref)!.synthesized).toBe(false);
  });
});

describe("packageComponentsCovered — the wizard advance gate", () => {
  const racerIds = new Set(["r1"]);

  it("not covered with only the Starter picked (the incremental-write hazard)", () => {
    const res = packageComponentsCovered(UQ, [heat({})], racerIds);
    expect(res.covered).toBe(false);
    expect(res.missing.map((c) => c.ref)).toEqual([INTERMEDIATE.ref]);
  });

  it("covered when every component has a heat for a category racer", () => {
    const res = packageComponentsCovered(
      UQ,
      [heat({}), heat({ productId: INT_BLUE, heatId: "2026-07-01T16:12:00" })],
      racerIds,
    );
    expect(res.covered).toBe(true);
  });

  it("another category's racers don't count", () => {
    const res = packageComponentsCovered(UQ, [heat({ assignedTo: "junior-kid" })], racerIds);
    expect(res.covered).toBe(false);
    expect(res.missing).toHaveLength(2);
  });
});

describe("rosterSyncPlan — toggling a member after holds", () => {
  const committedHeats = [
    heat({ assignedTo: "r1" }),
    heat({
      assignedTo: "r1",
      productId: INT_BLUE,
      tier: "intermediate",
      heatId: "2026-07-01T16:12:00",
    }),
  ];
  const picks = derivePackagePicks(UQ, committedHeats, "adult", []);

  it("OFF removes only that member's package lines (single-race heats untouched)", () => {
    const heats = [
      ...committedHeats,
      heat({ assignedTo: "r2" }),
      heat({ assignedTo: "r1", productId: "single-race-sku", heatId: "2026-07-01T18:00:00" }),
    ];
    const plan = rosterSyncPlan({
      memberId: "r1",
      nowIncluded: false,
      pkg: UQ,
      category: "adult",
      heats,
      picks,
    });
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(2); // r1's Starter + Intermediate only
    expect(plan.toRemove.every((h) => h.assignedTo === "r1")).toBe(true);
    expect(plan.toRemove.some((h) => h.productId === "single-race-sku")).toBe(false);
  });

  it("ON adds one entry per committed component IN SEQUENCE ORDER (license twin lands on the Starter)", () => {
    const plan = rosterSyncPlan({
      memberId: "r3",
      nowIncluded: true,
      pkg: UQ,
      category: "adult",
      heats: committedHeats,
      picks,
    });
    expect(plan.toRemove).toHaveLength(0);
    expect(plan.toAdd.map((h) => h.tier)).toEqual(["starter", "intermediate"]);
    expect(plan.toAdd.every((h) => h.assignedTo === "r3" && h.bmiLineId === null)).toBe(true);
    expect(plan.toAdd[0].heatId).toBe("2026-07-01T15:00:00");
  });

  it("ON with no committed picks adds nothing (pure local toggle)", () => {
    const plan = rosterSyncPlan({
      memberId: "r3",
      nowIncluded: true,
      pkg: UQ,
      category: "adult",
      heats: [],
      picks: new Map(),
    });
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
  });

  it("ON skips components the member already holds (idempotent re-toggle)", () => {
    const heats = [...committedHeats, heat({ assignedTo: "r3" })]; // r3 already on Starter
    const plan = rosterSyncPlan({
      memberId: "r3",
      nowIncluded: true,
      pkg: UQ,
      category: "adult",
      heats,
      picks,
    });
    expect(plan.toAdd.map((h) => h.tier)).toEqual(["intermediate"]);
  });
});
