import { describe, expect, it } from "vitest";
import { heatNumberFromName, parseRaceStateFrame, raceStateTransition } from "./race-state";

/** The real wire shape, from the frame captured off a live Mega heat on
 *  2026-08-11 and used as results-frame.test.ts's fixture. */
const running = JSON.stringify({ N: "[HEAT] 66 - Mega Pro", S: 1, C: 0, D: [] });
const paused = JSON.stringify({ N: "[HEAT] 66 - Mega Pro", S: 2, C: 0, D: [] });
const finished = JSON.stringify({ N: "[HEAT] 66 - Mega Pro", S: 4, C: 0, D: [] });

describe("parseRaceStateFrame", () => {
  it("reads the run state and the heat", () => {
    expect(parseRaceStateFrame(running)).toEqual({
      heatNumber: 66,
      heatName: "66 - Mega Pro",
      state: "running",
    });
  });

  it("maps 2 to paused and anything >= 3 to finished", () => {
    expect(parseRaceStateFrame(paused)?.state).toBe("paused");
    expect(parseRaceStateFrame(finished)?.state).toBe("finished");
    expect(parseRaceStateFrame(JSON.stringify({ N: "", S: 9 }))?.state).toBe("finished");
  });

  /**
   * "{}" is a REAL answer — no race loaded — and must be distinguishable from
   * an unreadable frame. The watcher treats the first as a legitimate end of a
   * state history and the second as "change nothing".
   */
  it("treats an empty race as `none`, not as unreadable", () => {
    expect(parseRaceStateFrame("{}")).toEqual({ heatNumber: null, heatName: "", state: "none" });
  });

  it("returns null for anything it cannot read", () => {
    expect(parseRaceStateFrame("")).toBeNull();
    expect(parseRaceStateFrame("not json")).toBeNull();
    expect(parseRaceStateFrame(null)).toBeNull();
    expect(parseRaceStateFrame(undefined)).toBeNull();
  });

  /** Unlike the results parser, a frame with no drivers is still a valid state:
   *  a race can be loaded and paused before anybody is seated. */
  it("keeps a driverless frame, which the results parser deliberately drops", () => {
    expect(parseRaceStateFrame(JSON.stringify({ N: "43 - Blue Starter", S: 1 }))).toEqual({
      heatNumber: 43,
      heatName: "43 - Blue Starter",
      state: "running",
    });
  });
});

describe("heatNumberFromName", () => {
  it("reads both wire spellings", () => {
    expect(heatNumberFromName("[HEAT] 66 - Mega Pro")).toBe(66);
    expect(heatNumberFromName("43 - Blue Starter")).toBe(43);
  });

  it("is null when there is no heat to read", () => {
    expect(heatNumberFromName("")).toBeNull();
    expect(heatNumberFromName("Blue Starter")).toBeNull();
  });
});

describe("raceStateTransition", () => {
  const frame = (state: string, heatNumber: number | null = 66) =>
    ({ heatNumber, heatName: "66 - Mega Pro", state }) as never;

  it("reports a pause and a resume within one heat", () => {
    expect(raceStateTransition({ heatNumber: 66, state: "running" }, frame("paused"))).toBe(
      "paused",
    );
    expect(raceStateTransition({ heatNumber: 66, state: "paused" }, frame("running"))).toBe(
      "resumed",
    );
  });

  it("says nothing when the state has not changed", () => {
    expect(raceStateTransition({ heatNumber: 66, state: "running" }, frame("running"))).toBeNull();
    expect(raceStateTransition({ heatNumber: 66, state: "paused" }, frame("paused"))).toBeNull();
  });

  it("has nothing to compare on the first sample", () => {
    expect(raceStateTransition(null, frame("paused"))).toBeNull();
  });

  /**
   * THE FALSE PAUSE THIS PREVENTS. Heat 42 finishes, heat 43 loads in a paused
   * state — across the heat boundary that is not a pause of anything, and
   * marking it would put a "session paused" bookmark on every camera at the
   * start of a race that never paused.
   */
  it("never reports across a heat change", () => {
    expect(
      raceStateTransition({ heatNumber: 42, state: "running" }, frame("paused", 43)),
    ).toBeNull();
  });

  it("ignores finishing and emptying — those have their own events", () => {
    expect(raceStateTransition({ heatNumber: 66, state: "running" }, frame("finished"))).toBeNull();
    expect(
      raceStateTransition({ heatNumber: 66, state: "running" }, frame("none", null)),
    ).toBeNull();
    expect(raceStateTransition({ heatNumber: 66, state: "finished" }, frame("running"))).toBeNull();
  });
});
