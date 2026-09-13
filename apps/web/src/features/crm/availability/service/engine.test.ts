import { describe, expect, it } from "vitest";
import {
  PROTO_SLOTS,
  protoLanes,
  protoOccupancy,
  protoOccupancyMap,
  type ProtoKey,
} from "../test-support";
import {
  EVENING_CLOSE_MIN,
  EVENING_OPEN_MIN,
  LANE_SECTIONS,
  MAX_ALTERNATES,
  VIP_SECTION_NAME,
  alternateWindows,
  bestRun,
  boundsFor,
  clampBlocks,
  evaluate,
  fmtMin,
  laneFreeIn,
  lanesNeeded,
  mergeAdjacent,
  parseClockMinutes,
  sectionRuns,
  ticksBetween,
  type LaneBlock,
  type LaneSection,
  type RequestWindow,
} from "./engine";

/**
 * The expectations here are DERIVED from the prototype's own seeded occupancy
 * generator (`test-support.ts`), never copied from the brief or the mockup.
 * `derive()` below is a second, deliberately naive implementation that asks the
 * generator slot by slot — exactly the way the prototype did — so a bug in the
 * engine's interval arithmetic shows up as a disagreement rather than as two
 * copies of the same mistake.
 */

const BOUNDS = { openMin: EVENING_OPEN_MIN, closeMin: EVENING_CLOSE_MIN };

/** Naive, slot-by-slot free runs per section — the prototype's own semantics. */
function derive(key: ProtoKey, date: string, win: RequestWindow) {
  const inWindow = PROTO_SLOTS.filter((s) => s >= win.start && s < win.start + win.dur);
  const isFree = (lane: number) =>
    inWindow.every((slot) => protoOccupancy(lane, slot, key, date) === null);
  return LANE_SECTIONS[key].map((section) => {
    const runs: number[][] = [];
    let cur: number[] = [];
    for (const lane of section.lanes) {
      if (isFree(lane)) cur.push(lane);
      else {
        if (cur.length) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length) runs.push(cur);
    return { section, runs, free: runs.reduce((a, r) => a + r.length, 0) };
  });
}

/** The documented choice rule applied to the derived runs, nothing else. */
function deriveBest(key: ProtoKey, date: string, win: RequestWindow, need: number) {
  let best: { section: LaneSection; lanes: number[]; run: number[] } | null = null;
  for (const { section, runs } of derive(key, date, win)) {
    for (const run of runs) {
      if (run.length < need) continue;
      const offset = run[0] % 2 === 1 ? 0 : 1;
      const lanes = run.slice(offset, offset + need);
      if (lanes.length !== need) continue;
      const better =
        !best ||
        (section.name !== VIP_SECTION_NAME && best.section.name === VIP_SECTION_NAME) ||
        lanes.length > best.lanes.length;
      if (better) best = { section, lanes, run };
    }
  }
  return best;
}

/** A hand-built grid: every lane free except the ones named busy. */
function gridWith(
  sections: readonly LaneSection[],
  busy: readonly number[],
): Map<number, LaneBlock[]> {
  const map = new Map<number, LaneBlock[]>();
  for (const section of sections) {
    for (const lane of section.lanes) {
      map.set(
        lane,
        busy.includes(lane)
          ? [{ kind: "walkin", label: "Walk-in", start: 16 * 60, end: 22 * 60 }]
          : [],
      );
    }
  }
  return map;
}

describe("lanesNeeded", () => {
  it("is guests over six, rounded up, and never zero", () => {
    expect(lanesNeeded(60)).toBe(10);
    expect(lanesNeeded(1)).toBe(1);
    expect(lanesNeeded(0)).toBe(1);
    expect(lanesNeeded(6)).toBe(1);
    expect(lanesNeeded(7)).toBe(2);
    expect(lanesNeeded(42)).toBe(7);
  });
});

describe("Saturday 17 October 2026 · HP Fort Myers · 60 guests", () => {
  const key: ProtoKey = "HPFM";
  const date = "2026-10-17";
  const win: RequestWindow = { start: 18 * 60, dur: 120 };
  const guests = 60;

  it("the fixture really is a Saturday", () => {
    expect(new Date(`${date}T12:00:00Z`).getUTCDay()).toBe(6);
  });

  it("fits, on the run the seeded grid actually leaves free", () => {
    const occupancy = protoOccupancyMap(key, date);
    const verdict = evaluate({
      sections: LANE_SECTIONS[key],
      occupancy,
      window: win,
      guests,
      bounds: BOUNDS,
    });
    const expected = deriveBest(key, date, win, 10);

    expect(verdict.need).toBe(10);
    expect(expected).not.toBeNull();
    expect(verdict.fits).toBe(true);
    expect(verdict.best?.section.name).toBe(expected?.section.name);
    expect(verdict.best?.lanes).toEqual(expected?.lanes);
    expect(verdict.best?.run).toEqual(expected?.run);
    expect(verdict.best?.lanes).toHaveLength(10);
    expect((verdict.best?.lanes[0] ?? 0) % 2).toBe(1);
    expect(verdict.alternates).toEqual([]);
  });

  it("counts free lanes per section the same way the generator does", () => {
    const occupancy = protoOccupancyMap(key, date);
    const runs = sectionRuns(LANE_SECTIONS[key], occupancy, win);
    const expected = derive(key, date, win);
    expect(runs.map((r) => [r.section.name, r.free])).toEqual(
      expected.map((r) => [r.section.name, r.free]),
    );
    expect(runs.map((r) => r.runs)).toEqual(expected.map((r) => r.runs));
  });

  it("keeps the maintenance lanes out of every run", () => {
    const runs = sectionRuns(LANE_SECTIONS[key], protoOccupancyMap(key, date), win);
    const free = runs.flatMap((r) => r.runs.flat());
    expect(free).not.toContain(27);
    expect(free).not.toContain(28);
  });
});

describe("a Tuesday league night", () => {
  const key: ProtoKey = "HPFM";
  const date = "2026-10-20";
  const win: RequestWindow = { start: 18 * 60 + 30, dur: 120 };
  const guests = 42;
  const need = lanesNeeded(guests);

  it("the fixture really is a Tuesday", () => {
    expect(new Date(`${date}T12:00:00Z`).getUTCDay()).toBe(2);
  });

  it("the league is the reason — lanes 13-20 are taken from 6:30 to 9", () => {
    const occupancy = protoOccupancyMap(key, date);
    for (const lane of [13, 16, 20]) {
      expect(occupancy.get(lane)).toContainEqual({
        kind: "league",
        label: "Tues Nite Mixed",
        start: 18 * 60 + 30,
        end: 21 * 60,
      });
    }
    expect(occupancy.get(21)?.some((b) => b.kind === "league")).toBe(false);
  });

  it("does not fit, and every alternate offered genuinely does", () => {
    const occupancy = protoOccupancyMap(key, date);
    const verdict = evaluate({
      sections: LANE_SECTIONS[key],
      occupancy,
      window: win,
      guests,
      bounds: BOUNDS,
    });

    expect(verdict.need).toBe(need);
    expect(deriveBest(key, date, win, need)).toBeNull();
    expect(verdict.fits).toBe(false);
    expect(verdict.best).toBeNull();
    expect(verdict.alternates.length).toBeGreaterThan(0);
    expect(verdict.alternates.length).toBeLessThanOrEqual(MAX_ALTERNATES);

    for (const alt of verdict.alternates) {
      // inside the day, within ±3 hours, on the half hour
      expect(alt.window.start).toBeGreaterThanOrEqual(BOUNDS.openMin);
      expect(alt.window.start + alt.window.dur).toBeLessThanOrEqual(BOUNDS.closeMin);
      expect(Math.abs(alt.window.start - win.start)).toBeLessThanOrEqual(180);
      expect(alt.window.start % 30).toBe(0);
      expect(alt.window.dur).toBe(win.dur);
      // and it is the placement the generator itself leaves open at that time
      const expected = deriveBest(key, date, alt.window, need);
      expect(expected).not.toBeNull();
      expect(alt.best.lanes).toEqual(expected?.lanes);
      expect(alt.best.lanes[0] % 2).toBe(1);
    }
  });

  it("offers nothing rather than something false when a big party has no room", () => {
    // 60 guests need ten contiguous lanes; with the league on 13-20 and
    // maintenance on 27-28 the seeded Tuesday has none, at any hour within
    // three of the request. The screen says "Try a shorter block or another
    // day" — it must not invent a slot.
    const occupancy = protoOccupancyMap(key, date);
    const verdict = evaluate({
      sections: LANE_SECTIONS[key],
      occupancy,
      window: win,
      guests: 60,
      bounds: BOUNDS,
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.alternates).toEqual([]);
  });

  it("offers the nearest windows first, later before earlier at each step", () => {
    const occupancy = protoOccupancyMap(key, date);
    const alts = alternateWindows(LANE_SECTIONS[key], occupancy, win, need, BOUNDS);
    const offsets = alts.map((a) => a.window.start - win.start);
    const ordered = [...offsets].sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
    expect(offsets).toEqual(ordered);
  });

  it("never proposes a window that runs past closing", () => {
    const occupancy = protoOccupancyMap(key, date);
    const late: RequestWindow = { start: 20 * 60, dur: 120 };
    const alts = alternateWindows(LANE_SECTIONS[key], occupancy, late, need, BOUNDS);
    for (const alt of alts) {
      expect(alt.window.start + alt.window.dur).toBeLessThanOrEqual(EVENING_CLOSE_MIN);
    }
  });
});

describe("the odd-lane rule", () => {
  const sections: LaneSection[] = [{ name: "Regular", lanes: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const win: RequestWindow = { start: 18 * 60, dur: 120 };

  it("refuses a run of exactly the right length that starts on an even lane", () => {
    // lanes 4-7 free, need 4 — long enough, but QAMF would have to split a pair
    const occupancy = gridWith(sections, [1, 2, 3, 8]);
    expect(bestRun(sections, occupancy, win, 4)).toBeNull();
  });

  it("shifts onto the odd lane when the run has one to spare", () => {
    // lanes 4-8 free, need 4 → 5,6,7,8
    const occupancy = gridWith(sections, [1, 2, 3]);
    const best = bestRun(sections, occupancy, win, 4);
    expect(best?.lanes).toEqual([5, 6, 7, 8]);
    expect(best?.run).toEqual([4, 5, 6, 7, 8]);
    expect(best?.startsOdd).toBe(false);
  });

  it("takes an odd-starting run from its first lane", () => {
    const occupancy = gridWith(sections, [1, 2, 8]);
    const best = bestRun(sections, occupancy, win, 4);
    expect(best?.lanes).toEqual([3, 4, 5, 6]);
    expect(best?.startsOdd).toBe(true);
  });
});

describe("section preference", () => {
  const win: RequestWindow = { start: 18 * 60, dur: 120 };

  it("puts a party on Regular rather than VIP when both fit", () => {
    const sections = LANE_SECTIONS.HPFM;
    // Old Time (1-4) taken, so the real choice is VIP 5-12 against Regular
    // 13-28. VIP is searched FIRST in section order, so this only passes
    // because the rule prefers a non-VIP section outright.
    const occupancy = gridWith(sections, sections[0].lanes);
    const best = bestRun(sections, occupancy, win, 4);
    expect(best?.section.name).toBe("Regular");
    expect(best?.lanes).toEqual([13, 14, 15, 16]);
  });

  it("falls back to VIP when nothing else can hold the party", () => {
    const sections = LANE_SECTIONS.HPFM;
    // Old Time and every Regular lane busy; VIP wide open
    const occupancy = gridWith(sections, [...sections[0].lanes, ...sections[2].lanes]);
    const best = bestRun(sections, occupancy, win, 4);
    expect(best?.section.name).toBe(VIP_SECTION_NAME);
    expect(best?.lanes).toEqual([5, 6, 7, 8]);
  });

  it("keeps Old Time ahead of VIP when the party is small enough for it", () => {
    const sections = LANE_SECTIONS.HPFM;
    const best = bestRun(sections, gridWith(sections, []), win, 4);
    expect(best?.section.name).toBe("Old Time Lanes");
    expect(best?.lanes).toEqual([1, 2, 3, 4]);
  });

  it("uses Naples' own sections, where Regular already comes first", () => {
    const sections = LANE_SECTIONS.HPN;
    expect(sections.map((s) => s.name)).toEqual(["Regular", "VIP"]);
    expect(sections[0].lanes[0]).toBe(1);
    expect(sections[0].lanes.at(-1)).toBe(24);
    expect(sections[1].lanes[0]).toBe(25);
    expect(sections[1].lanes.at(-1)).toBe(32);
  });
});

describe("window arithmetic", () => {
  it("treats a block that ends exactly when the window opens as free", () => {
    const blocks: LaneBlock[] = [{ kind: "league", label: "L", start: 16 * 60, end: 18 * 60 }];
    expect(laneFreeIn(blocks, { start: 18 * 60, dur: 60 })).toBe(true);
    expect(laneFreeIn(blocks, { start: 17 * 60 + 30, dur: 60 })).toBe(false);
  });

  it("merges touching blocks that say the same thing", () => {
    const merged = mergeAdjacent([
      { kind: "league", label: "Tues Nite Mixed", start: 1110, end: 1140 },
      { kind: "league", label: "Tues Nite Mixed", start: 1140, end: 1170 },
      { kind: "walkin", label: "Walk-in", start: 1170, end: 1200 },
    ]);
    expect(merged).toEqual([
      { kind: "league", label: "Tues Nite Mixed", start: 1110, end: 1170 },
      { kind: "walkin", label: "Walk-in", start: 1170, end: 1200 },
    ]);
  });

  it("clamps blocks to the drawn day and drops the ones outside it", () => {
    const clamped = clampBlocks(
      [
        { kind: "league", label: "early", start: 10 * 60, end: 17 * 60 },
        { kind: "party", label: "gone", start: 8 * 60, end: 9 * 60 },
      ],
      BOUNDS,
    );
    expect(clamped).toEqual([{ kind: "league", label: "early", start: 16 * 60, end: 17 * 60 }]);
  });

  it("widens the drawn day to contain a lunchtime request", () => {
    expect(boundsFor({ start: 18 * 60, dur: 120 })).toEqual(BOUNDS);
    expect(boundsFor({ start: 11 * 60 + 30, dur: 120 })).toEqual({
      openMin: 11 * 60,
      closeMin: EVENING_CLOSE_MIN,
    });
    expect(boundsFor({ start: 21 * 60, dur: 180 })).toEqual({
      openMin: EVENING_OPEN_MIN,
      closeMin: 24 * 60,
    });
  });

  it("puts a tick on every hour, both ends included", () => {
    expect(ticksBetween(BOUNDS)).toEqual([960, 1020, 1080, 1140, 1200, 1260, 1320]);
  });
});

describe("clock helpers", () => {
  it("formats minutes the way the prototype does", () => {
    expect(fmtMin(16 * 60)).toBe("4:00 PM");
    expect(fmtMin(18 * 60 + 30)).toBe("6:30 PM");
    expect(fmtMin(12 * 60)).toBe("12:00 PM");
    expect(fmtMin(0)).toBe("12:00 AM");
    expect(fmtMin(11 * 60 + 5)).toBe("11:05 AM");
  });

  it("parses an Office / Postgres time of day", () => {
    expect(parseClockMinutes("18:30")).toBe(1110);
    expect(parseClockMinutes("18:30:00")).toBe(1110);
    expect(parseClockMinutes("09:05:00")).toBe(545);
    expect(parseClockMinutes(null)).toBeNull();
    expect(parseClockMinutes("")).toBeNull();
    expect(parseClockMinutes("evening")).toBeNull();
    expect(parseClockMinutes("99:99")).toBeNull();
  });
});

describe("the seeded grid itself", () => {
  it("covers every lane the centre has", () => {
    expect(protoLanes("HPFM")).toHaveLength(28);
    expect(protoLanes("HPN")).toHaveLength(32);
  });
});
