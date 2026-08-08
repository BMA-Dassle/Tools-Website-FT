import { describe, expect, it } from "vitest";
import {
  reconcileHeatTimes,
  usableSchedules,
  type BmiSchedule,
  type HeatLike,
} from "./bmi-schedule-sync";

const sched = (
  start: string,
  persons: number,
  label = "Starter Race Blue - New Web",
): BmiSchedule => ({
  id: "s",
  start,
  stop: start,
  persons,
  productLines: label,
  resourceId: "11208654",
});
const heat = (heatId: string, track = "Blue"): HeatLike & { racer?: string } => ({
  heatId,
  track,
  productId: "24952964",
});

describe("usableSchedules", () => {
  it("drops the placeholder row BMI carries (persons 0, blank productLines)", () => {
    // Live shape from bill …7654581: [{22:00, persons 4}, {22:24, persons 0, ""}].
    const out = usableSchedules([
      sched("2026-08-07T22:00:00", 4, "Starter Race Blue - New Web, Start"),
      { id: "x", start: "2026-08-07T22:24:00", persons: 0, productLines: "" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe("2026-08-07T22:00:00");
  });

  it("sorts by start so pairing is order-independent", () => {
    const out = usableSchedules([sched("2026-08-11T16:10:00", 6), sched("2026-08-11T15:30:00", 6)]);
    expect(out.map((s) => s.start)).toEqual(["2026-08-11T15:30:00", "2026-08-11T16:10:00"]);
  });

  it("drops a schedule with an unusable start", () => {
    expect(usableSchedules([{ start: "", persons: 2, productLines: "Race" }])).toHaveLength(0);
  });
});

describe("reconcileHeatTimes — the live failure (W58723)", () => {
  it("adopts BMI's moved time for every seat on that race", () => {
    // BMI moved the race 22:12 → 23:12; Neon still had the old time, so the
    // assignment targeted a heat that no longer existed.
    const heats = [heat("2026-08-07T22:12:00"), heat("2026-08-07T22:12:00")];
    const r = reconcileHeatTimes(heats, [sched("2026-08-07T23:12:00", 2)]);
    expect(r.reason).toBe("ok");
    expect(r.changed).toBe(2);
    expect(r.heats.map((h) => h.heatId)).toEqual(["2026-08-07T23:12:00", "2026-08-07T23:12:00"]);
  });

  it("does not mutate the input", () => {
    const heats = [heat("2026-08-07T22:12:00"), heat("2026-08-07T22:12:00")];
    reconcileHeatTimes(heats, [sched("2026-08-07T23:12:00", 2)]);
    expect(heats.every((h) => h.heatId === "2026-08-07T22:12:00")).toBe(true);
  });

  it("preserves the other heat fields", () => {
    const heats = [{ ...heat("2026-08-07T22:12:00"), racer: "Adult 1" }];
    const r = reconcileHeatTimes(heats, [sched("2026-08-07T23:12:00", 1)]);
    expect(r.heats[0]).toMatchObject({ racer: "Adult 1", track: "Blue", productId: "24952964" });
  });
});

describe("reconcileHeatTimes — multi-race bookings", () => {
  it("leaves an already-correct two-race booking untouched", () => {
    // Live shape from …7642430: Starter Mega 15:30 (6) + Intermediate Mega 16:10 (6).
    const heats = [
      ...Array.from({ length: 6 }, () => heat("2026-08-11T15:30:00")),
      ...Array.from({ length: 6 }, () => heat("2026-08-11T16:10:00")),
    ];
    const r = reconcileHeatTimes(heats, [
      sched("2026-08-11T15:30:00", 6, "Starter Race Mega Web - New Web"),
      sched("2026-08-11T16:10:00", 6, "Intermediate Race Mega - New Web N"),
    ]);
    expect(r.changed).toBe(0);
    expect(r.reason).toBe("ok");
  });

  it("corrects only the race that moved", () => {
    const heats = [heat("2026-08-07T20:24:00"), heat("2026-08-07T21:12:00")];
    const r = reconcileHeatTimes(heats, [
      sched("2026-08-07T20:24:00", 1, "Intermediate Race Blue - New Web N"),
      sched("2026-08-07T21:30:00", 1, "Intermediate Race Red - New Web NL"),
    ]);
    expect(r.changed).toBe(1);
    expect(r.heats.map((h) => h.heatId)).toEqual(["2026-08-07T20:24:00", "2026-08-07T21:30:00"]);
  });

  it("handles UNEVEN seats per race — 2 on the booking, 1 on the second heat", () => {
    // The owner's constraint: "2 person in reservation doesn't mean there is
    // two people on that heat."
    const heats = [
      heat("2026-08-07T19:00:00"),
      heat("2026-08-07T19:00:00"),
      heat("2026-08-07T20:00:00"),
    ];
    const r = reconcileHeatTimes(heats, [
      sched("2026-08-07T19:00:00", 2),
      sched("2026-08-07T20:30:00", 1),
    ]);
    expect(r.reason).toBe("ok");
    expect(r.changed).toBe(1);
    expect(r.heats.map((h) => h.heatId)).toEqual([
      "2026-08-07T19:00:00",
      "2026-08-07T19:00:00",
      "2026-08-07T20:30:00",
    ]);
  });
});

describe("reconcileHeatTimes — fails closed", () => {
  it("changes nothing when BMI has more races than Neon", () => {
    const heats = [heat("2026-08-07T19:00:00")];
    const r = reconcileHeatTimes(heats, [
      sched("2026-08-07T19:00:00", 1),
      sched("2026-08-07T20:00:00", 1),
    ]);
    expect(r.reason).toBe("race-count-mismatch");
    expect(r.changed).toBe(0);
    expect(r.heats).toBe(heats);
  });

  it("changes nothing when the seat counts disagree", () => {
    // Someone was added or removed in BMI — we cannot know which heat moved.
    const heats = [heat("2026-08-07T22:12:00"), heat("2026-08-07T22:12:00")];
    const r = reconcileHeatTimes(heats, [sched("2026-08-07T23:12:00", 3)]);
    expect(r.reason).toBe("seat-count-mismatch");
    expect(r.changed).toBe(0);
    expect(r.heats.map((h) => h.heatId)).toEqual(["2026-08-07T22:12:00", "2026-08-07T22:12:00"]);
  });

  it("changes nothing when BMI returned no usable schedule", () => {
    const heats = [heat("2026-08-07T22:12:00")];
    const r = reconcileHeatTimes(heats, []);
    expect(r.reason).toBe("no-bmi");
    expect(r.changed).toBe(0);
  });

  it("treats an all-placeholder schedule list as no BMI answer", () => {
    const heats = [heat("2026-08-07T22:12:00")];
    const r = reconcileHeatTimes(heats, [
      { start: "2026-08-07T22:24:00", persons: 0, productLines: "" },
    ]);
    expect(r.reason).toBe("no-bmi");
    expect(r.changed).toBe(0);
  });

  it("handles an empty heat list", () => {
    const r = reconcileHeatTimes([], [sched("2026-08-07T23:12:00", 2)]);
    expect(r.reason).toBe("no-heats");
    expect(r.changed).toBe(0);
  });

  it("reports what it changed, for the server log", () => {
    const r = reconcileHeatTimes([heat("2026-08-07T22:12:00")], [sched("2026-08-07T23:12:00", 1)]);
    expect(r.detail).toContain("2026-08-07T22:12:00→2026-08-07T23:12:00");
  });
});
