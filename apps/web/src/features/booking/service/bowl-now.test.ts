import { describe, it, expect } from "vitest";
import type { Lane } from "@/lib/qamf-bowling";
import {
  openLanesFrom,
  laneIsFree,
  fittingDurations,
  nowRounded5EtIso,
  type DurationOption,
} from "./bowl-now";

const lane = (LaneNumber: number, Status: Lane["Status"]): Lane => ({ LaneNumber, Status });

const DUCKPIN: DurationOption[] = [
  { minutes: 30, optionId: 33 },
  { minutes: 60, optionId: 34 },
  { minutes: 90, optionId: 35 },
];

describe("openLanesFrom", () => {
  it("returns only Closed lanes, ascending", () => {
    const lanes: Lane[] = [
      lane(3, "Open"),
      lane(1, "Closed"),
      lane(5, "Closed"),
      lane(2, "Error"),
      lane(4, "None"),
    ];
    expect(openLanesFrom(lanes)).toEqual([1, 5]);
  });

  it("returns [] when every lane is busy", () => {
    expect(openLanesFrom([lane(1, "Open"), lane(2, "Running" as Lane["Status"])])).toEqual([]);
  });
});

describe("laneIsFree", () => {
  const lanes: Lane[] = [lane(4, "Closed"), lane(5, "Open")];
  it("true only for a Closed lane", () => {
    expect(laneIsFree(lanes, 4)).toBe(true);
    expect(laneIsFree(lanes, 5)).toBe(false);
  });
  it("false for an unknown lane", () => {
    expect(laneIsFree(lanes, 9)).toBe(false);
  });
});

describe("fittingDurations", () => {
  it("offers all three, longest-first, well before close", () => {
    // 9:30 PM ET start, midnight close → 90/60/30 all fit.
    const out = fittingDurations(DUCKPIN, "2026-07-22T21:30:00-04:00", 24);
    expect(out.map((d) => d.minutes)).toEqual([90, 60, 30]);
  });

  it("drops durations that run past close (only 30 fits at 11:30 PM before midnight)", () => {
    const out = fittingDurations(DUCKPIN, "2026-07-22T23:30:00-04:00", 24);
    expect(out.map((d) => d.minutes)).toEqual([30]);
  });

  it("allows a slot that ends exactly at close", () => {
    // 11:00 PM + 60 == midnight == close → allowed; 90 would overrun.
    const out = fittingDurations(DUCKPIN, "2026-07-22T23:00:00-04:00", 24);
    expect(out.map((d) => d.minutes)).toEqual([60, 30]);
  });

  it("handles a 2 AM weekend close with a post-midnight start", () => {
    // 1:00 AM start, 2 AM (=26) close → 60 ends at 2 AM (fits), 90 overruns.
    const out = fittingDurations(DUCKPIN, "2026-07-25T01:00:00-04:00", 26);
    expect(out.map((d) => d.minutes)).toEqual([60, 30]);
  });

  it("returns [] when nothing fits", () => {
    expect(fittingDurations(DUCKPIN, "2026-07-22T23:50:00-04:00", 24)).toEqual([]);
  });
});

describe("nowRounded5EtIso", () => {
  it("floors to a 5-minute multiple with the EDT offset", () => {
    expect(nowRounded5EtIso(new Date("2026-07-22T20:07:33-04:00"))).toBe(
      "2026-07-22T20:05:00-04:00",
    );
  });

  it("keeps an already-aligned minute and zeroes seconds", () => {
    expect(nowRounded5EtIso(new Date("2026-07-22T20:15:00-04:00"))).toBe(
      "2026-07-22T20:15:00-04:00",
    );
  });

  it("uses the EST offset in winter", () => {
    expect(nowRounded5EtIso(new Date("2026-01-15T14:22:00-05:00"))).toBe(
      "2026-01-15T14:20:00-05:00",
    );
  });
});
