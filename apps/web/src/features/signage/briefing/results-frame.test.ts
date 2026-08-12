import { describe, expect, it } from "vitest";
import { parseHeatNumber, parseResultsFrame, splitByTarget } from "./results-frame";

/**
 * REAL WIRE DATA, verbatim: Mega heat 66, captured off the live SMS-Timing
 * socket on 2026-08-11 AFTER the race finished (S:4) — the exact after-window
 * the end-of-race capture rides. Not a hand-built approximation.
 */
const FINISHED_MEGA_HEAT_66 =
  '{"T":1786487400,"CE":0,"CS":0,"D":[{"LP":0,"A":64644,"B":63360,"K":"13","G":"","D":58509204,"L":6,"T":63360,"R":5,"N":"Kenny rosencrans","P":1,"M":0},{"LP":0,"A":65229,"B":63610,"K":"38","G":"00.250","D":58509190,"L":6,"T":64410,"R":5,"N":"Giovanni bonetti","P":2,"M":0},{"LP":0,"A":67305,"B":66035,"K":"8","G":"02.675","D":58509196,"L":6,"T":66111,"R":5,"N":"john iacob","P":3,"M":0},{"LP":0,"A":69051,"B":66644,"K":"3","G":"03.284","D":58509180,"L":6,"T":67735,"R":5,"N":"jayson mundy","P":4,"M":0},{"LP":0,"A":70800,"B":69226,"K":"35","G":"05.866","D":58509186,"L":6,"T":69226,"R":5,"N":"Sebastian vazquez","P":5,"M":0}],"EM":0,"C":0,"N":"[HEAT] 66 - Mega Pro","E":1,"R":1,"L":0,"S":4}';

describe("parseResultsFrame — against the real finished-heat frame", () => {
  it("reads every driver: name verbatim, best lap, kart, position order", () => {
    const frame = parseResultsFrame(FINISHED_MEGA_HEAT_66);
    expect(frame).not.toBeNull();
    expect(frame!.heatNumber).toBe(66);
    expect(frame!.heatName).toBe("Heat 66 - Mega Pro");
    expect(frame!.state).toBe(4); // finished — and the standings are still served
    expect(frame!.drivers).toHaveLength(5);
    expect(frame!.drivers[0]).toEqual({
      name: "Kenny rosencrans", // AS-IS from the timing system, per the owner
      bestMs: 63360,
      kart: "13",
      laps: 6,
      position: 1,
    });
    expect(frame!.drivers.map((d) => d.position)).toEqual([1, 2, 3, 4, 5]);
    expect(frame!.drivers[4].name).toBe("Sebastian vazquez");
  });

  it('returns null for "{}" (no race), garbage, and driverless frames alike', () => {
    expect(parseResultsFrame("{}")).toBeNull();
    expect(parseResultsFrame("not json")).toBeNull();
    expect(parseResultsFrame('{"N":"[HEAT] 9","S":1,"D":[]}')).toBeNull();
    expect(parseResultsFrame(undefined)).toBeNull();
  });

  it("a driver who never set a lap carries bestMs null, not 0", () => {
    const frame = parseResultsFrame(
      '{"N":"[HEAT] 70 - Blue Starter","S":1,"D":[{"N":"Amy","B":0,"K":"4","L":0,"P":1}]}',
    );
    expect(frame!.drivers[0].bestMs).toBeNull();
  });
});

describe("parseHeatNumber — the heat-match gate", () => {
  it("reads the number out of the standard heat name", () => {
    expect(parseHeatNumber("[HEAT] 66 - Mega Pro")).toBe(66);
    expect(parseHeatNumber("[HEAT] 7 - Blue Starter")).toBe(7);
  });

  it("group events and custom race names return null — never guess", () => {
    expect(parseHeatNumber("Gartner Party Race")).toBeNull();
    expect(parseHeatNumber("")).toBeNull();
  });
});

describe("splitByTarget — who levelled up, who didn't", () => {
  const drivers = parseResultsFrame(FINISHED_MEGA_HEAT_66)!.drivers;

  it("at-or-under the target levels up; over it keeps pushing", () => {
    // Fictional target between P2 and P3 of the real field.
    const split = splitByTarget(drivers, 64000);
    expect(split.levelledUp.map((d) => d.name)).toEqual(["Kenny rosencrans", "Giovanni bonetti"]);
    expect(split.keepPushing).toHaveLength(3);
  });

  it("exactly on the target counts as beating it", () => {
    const split = splitByTarget(drivers, 63360);
    expect(split.levelledUp.map((d) => d.name)).toEqual(["Kenny rosencrans"]);
  });

  it("no target (Pro / Mega — no next level) puts everyone in standings order", () => {
    const split = splitByTarget(drivers, null);
    expect(split.levelledUp).toEqual([]);
    expect(split.keepPushing).toHaveLength(5);
  });

  it("a driver with no lap can never level up", () => {
    const split = splitByTarget(
      [{ name: "Amy", bestMs: null, kart: "4", laps: 0, position: 1 }],
      64000,
    );
    expect(split.levelledUp).toEqual([]);
    expect(split.keepPushing).toHaveLength(1);
  });
});
