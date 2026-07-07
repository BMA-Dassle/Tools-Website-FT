import { describe, expect, it } from "vitest";

import {
  chipHourOfIso,
  classifyGroupMatch,
  matchGridToGroups,
  type ComboExistingGroup,
  type MatchableCell,
} from "./combo-group-match";

const group = (over: Partial<ComboExistingGroup> = {}): ComboExistingGroup => ({
  anchorHeatIso: "2026-07-10T16:00:00",
  startHour: 16,
  track: "Red",
  bowlingStartIso: "2026-07-10T16:45:00",
  partySize: 4,
  ...over,
});

const cellMs = (iso: string) => new Date(iso).getTime();
const cell = (over: Partial<MatchableCell> = {}): MatchableCell => {
  const anchorStartIso = over.anchorStartIso ?? "2026-07-10T16:00:00";
  return {
    key: `${anchorStartIso}|${over.track ?? "Red"}`,
    anchorStartIso,
    track: "Red",
    hour: 16,
    anchorStartMs: cellMs(anchorStartIso),
    feasible: true,
    ...over,
  };
};

describe("chipHourOfIso", () => {
  it("reads the wall-clock hour, mapping post-midnight hours to 24+", () => {
    expect(chipHourOfIso("2026-07-10T14:00:00")).toBe(14);
    expect(chipHourOfIso("2026-07-10T22:12:00")).toBe(22);
    expect(chipHourOfIso("2026-07-11T01:00:00")).toBe(25);
  });
});

describe("classifyGroupMatch", () => {
  it("exact when the anchor heat and track match (vendor TZ suffixes ignored)", () => {
    const r = classifyGroupMatch(
      { anchorStartIso: "2026-07-10T16:00:00Z", track: "Red", hour: 16 },
      [group()],
    );
    expect(r?.kind).toBe("exact");
  });

  it("same-hour when only the start hour matches (different heat or track)", () => {
    expect(
      classifyGroupMatch({ anchorStartIso: "2026-07-10T16:12:00", track: "Red", hour: 16 }, [
        group(),
      ])?.kind,
    ).toBe("same-hour");
    expect(
      classifyGroupMatch({ anchorStartIso: "2026-07-10T16:00:00", track: "Blue", hour: 16 }, [
        group(),
      ])?.kind,
    ).toBe("same-hour");
  });

  it("exact regardless of track when the group has no recorded track", () => {
    const r = classifyGroupMatch(
      { anchorStartIso: "2026-07-10T16:00:00", track: "Blue", hour: 16 },
      [group({ track: null })],
    );
    expect(r?.kind).toBe("exact");
  });

  it("null when no group shares the hour", () => {
    expect(
      classifyGroupMatch({ anchorStartIso: "2026-07-10T18:00:00", track: "Red", hour: 18 }, [
        group(),
      ]),
    ).toBeNull();
  });

  it("prefers an exact match over a same-hour one across groups", () => {
    const r = classifyGroupMatch(
      { anchorStartIso: "2026-07-10T16:00:00", track: "Red", hour: 16 },
      [group({ anchorHeatIso: "2026-07-10T16:12:00" }), group()],
    );
    expect(r?.kind).toBe("exact");
  });
});

describe("matchGridToGroups", () => {
  it("badges the exact feasible cell", () => {
    const cells = [cell(), cell({ anchorStartIso: "2026-07-10T18:00:00", hour: 18 })];
    const m = matchGridToGroups(cells, [group()]);
    expect(m.get(cells[0].key)?.kind).toBe("exact");
    expect(m.has(cells[1].key)).toBe(false);
  });

  it("never recommends an infeasible cell — falls back to a same-hour feasible one", () => {
    const exactButFull = cell({ feasible: false });
    const nearby = cell({ anchorStartIso: "2026-07-10T16:12:00" });
    const m = matchGridToGroups([exactButFull, nearby], [group()]);
    expect(m.has(exactButFull.key)).toBe(false);
    expect(m.get(nearby.key)?.kind).toBe("same-hour");
  });

  it("same-hour fallback prefers the group's track, then the nearest heat", () => {
    const otherTrack = cell({ anchorStartIso: "2026-07-10T16:12:00", track: "Blue" });
    const sameTrackFar = cell({ anchorStartIso: "2026-07-10T16:48:00" });
    const m = matchGridToGroups([otherTrack, sameTrackFar], [group()]);
    expect(m.get(sameTrackFar.key)?.kind).toBe("same-hour");
    expect(m.has(otherTrack.key)).toBe(false);

    const near = cell({ anchorStartIso: "2026-07-10T16:12:00" });
    const far = cell({ anchorStartIso: "2026-07-10T16:48:00" });
    const m2 = matchGridToGroups([near, far], [group()]);
    expect(m2.get(near.key)?.kind).toBe("same-hour");
  });

  it("badges only ONE same-hour cell per group (steer everyone onto one tile)", () => {
    const a = cell({ anchorStartIso: "2026-07-10T16:12:00" });
    const b = cell({ anchorStartIso: "2026-07-10T16:24:00" });
    const m = matchGridToGroups([a, b], [group()]);
    expect(m.size).toBe(1);
  });

  it("an exact badge is not clobbered by another group's same-hour fallback", () => {
    const exact = cell();
    const m = matchGridToGroups(
      [exact],
      [group({ anchorHeatIso: "2026-07-10T16:12:00" }), group()],
    );
    expect(m.get(exact.key)?.kind).toBe("exact");
  });

  it("returns an empty map with no groups", () => {
    expect(matchGridToGroups([cell()], []).size).toBe(0);
  });
});
