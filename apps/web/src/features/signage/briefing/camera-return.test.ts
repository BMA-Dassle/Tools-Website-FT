import { describe, it, expect } from "vitest";
import {
  cameraReturnStripAt,
  formatSinceFlag,
  GREEN_HOLD_MS,
  SEEN_SKEW_MS,
  type CameraScan,
  type SessionFinish,
} from "./camera-return";
import { cameraBarHeight, CAMERA_BAR_H, CAMERA_BAR_CLEAR_H } from "../components/CameraReturnBar";

const T = Date.parse("2026-08-12T23:00:00.000Z");
const m = (n: number) => n * 60_000;

function scan(camera: string, sessionId: string, atMs: number): CameraScan {
  return { camera, sessionId, assignedAtMs: atMs };
}
function finishes(entries: Array<[string, number, number | null]>): Map<string, SessionFinish> {
  return new Map(entries.map(([sid, endedAtMs, heatNumber]) => [sid, { endedAtMs, heatNumber }]));
}

describe("cameraReturnStripAt", () => {
  it("is empty when nothing has been scanned", () => {
    const r = cameraReturnStripAt({ scans: [], finishes: new Map(), seen: new Map(), nowMs: T });
    expect(r.boxes).toEqual([]);
    expect(r.outCount).toBe(0);
  });

  it("ignores a camera whose race has not finished — nothing to chase yet", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(20))],
      finishes: new Map(),
      seen: new Map(),
      nowMs: T,
    });
    expect(r.boxes).toEqual([]);
  });

  it("shows a camera red once its race has finished with no sighting", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(20))],
      finishes: finishes([["S1", T - m(3), 58]]),
      seen: new Map(),
      nowMs: T,
    });
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]).toMatchObject({ camera: "23", state: "out", heatNumber: 58 });
    expect(r.boxes[0].sinceFlagMs).toBe(m(3));
    expect(r.outCount).toBe(1);
  });

  it("a sighting BEFORE the flag does not count — a previous heat's late upload", () => {
    // The camera's earlier clip registered two minutes before this heat even
    // ended. That says nothing about whether it came back from THIS heat.
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(20))],
      finishes: finishes([["S1", T - m(3), 58]]),
      seen: new Map([["23", T - m(5)]]),
      nowMs: T,
    });
    expect(r.boxes[0].state).toBe("out");
    expect(r.outCount).toBe(1);
  });

  it("a sighting AFTER the flag turns it green", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(20))],
      finishes: finishes([["S1", T - m(3), 58]]),
      seen: new Map([["23", T - m(1)]]),
      nowMs: T,
    });
    expect(r.boxes[0].state).toBe("back");
    expect(r.outCount).toBe(0);
  });

  it("tolerates clock skew between the venue stamp and VT3", () => {
    // A minute of disagreement between the venue's clock and VT3's must not
    // strand a camera that plainly came back. Asserted on outCount rather than
    // on a green box: a sighting this old is already past the green hold, so
    // "accounted for" correctly shows nothing at all.
    const flag = T - m(3);
    const outCountFor = (seenAt: number) =>
      cameraReturnStripAt({
        scans: [scan("23", "S1", T - m(20))],
        finishes: finishes([["S1", flag, 58]]),
        seen: new Map([["23", seenAt]]),
        nowMs: T,
      }).outCount;
    expect(outCountFor(flag - (SEEN_SKEW_MS - 1_000))).toBe(0);
    expect(outCountFor(flag - (SEEN_SKEW_MS + 1_000))).toBe(1);
  });

  it("drops the green box once the hold expires", () => {
    const seenAt = T - GREEN_HOLD_MS - 1_000;
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(20))],
      finishes: finishes([["S1", T - m(10), 58]]),
      seen: new Map([["23", seenAt]]),
      nowMs: T,
    });
    expect(r.boxes).toEqual([]);
  });

  it("keeps the green box while the hold is still running", () => {
    const seenAt = T - GREEN_HOLD_MS + 5_000;
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(20))],
      finishes: finishes([["S1", T - m(10), 58]]),
      seen: new Map([["23", seenAt]]),
      nowMs: T,
    });
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0].state).toBe("back");
  });

  it("reports the OLDEST unresolved heat when a camera went out twice", () => {
    // Camera 8 never came back from heat 56, then got scanned onto heat 58.
    // It must keep reporting 56 — a newer scan cannot reset the debt.
    const r = cameraReturnStripAt({
      scans: [scan("8", "S56", T - m(40)), scan("8", "S58", T - m(12))],
      finishes: finishes([
        ["S56", T - m(30), 56],
        ["S58", T - m(2), 58],
      ]),
      seen: new Map(),
      nowMs: T,
    });
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]).toMatchObject({ camera: "8", state: "out", heatNumber: 56 });
    expect(r.boxes[0].sinceFlagMs).toBe(m(30));
  });

  it("an old debt survives a later scan whose race is still running", () => {
    // Camera 8 never came back from heat 56 and has since been scanned onto
    // heat 58, which has not finished. 58 contributes nothing (rule 1) and the
    // camera must keep reporting the debt it actually owes.
    const r = cameraReturnStripAt({
      scans: [scan("8", "S56", T - m(40)), scan("8", "S58", T - m(12))],
      finishes: finishes([["S56", T - m(30), 56]]),
      seen: new Map(),
      nowMs: T,
    });
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]).toMatchObject({ state: "out", heatNumber: 56 });
    expect(r.boxes[0].sinceFlagMs).toBe(m(30));
  });

  it("a sighting after a later flag settles the earlier heat too", () => {
    // Physical truth, and worth pinning: being at a base station after heat 58
    // ended means the camera is in the building, which retires heat 56's debt
    // as well. Anything else would leave a permanent red box for a camera
    // sitting on the shelf.
    const r = cameraReturnStripAt({
      scans: [scan("8", "S56", T - m(40)), scan("8", "S58", T - m(12))],
      finishes: finishes([
        ["S56", T - m(30), 56],
        ["S58", T - m(2), 58],
      ]),
      seen: new Map([["8", T - m(1)]]),
      nowMs: T,
    });
    expect(r.outCount).toBe(0);
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0]).toMatchObject({ camera: "8", state: "back", heatNumber: 58 });
  });

  it("orders by when the camera went out, so a box does not move when it turns green", () => {
    const scans = [
      scan("44", "S58", T - m(12)),
      scan("8", "S56", T - m(40)),
      scan("17", "S58", T - m(13)),
    ];
    const fin = finishes([
      ["S56", T - m(30), 56],
      ["S58", T - m(2), 58],
    ]);
    const before = cameraReturnStripAt({ scans, finishes: fin, seen: new Map(), nowMs: T });
    expect(before.boxes.map((b) => b.camera)).toEqual(["8", "17", "44"]);

    // 17 checks in. Its position must be identical, only its colour changes.
    const after = cameraReturnStripAt({
      scans,
      finishes: fin,
      seen: new Map([["17", T - m(1)]]),
      nowMs: T,
    });
    expect(after.boxes.map((b) => b.camera)).toEqual(["8", "17", "44"]);
    expect(after.boxes.map((b) => b.state)).toEqual(["out", "back", "out"]);
    expect(after.outCount).toBe(2);
  });

  it("breaks an exact assignedAt tie by camera number, not insertion order", () => {
    const at = T - m(10);
    const r = cameraReturnStripAt({
      scans: [scan("94", "S1", at), scan("12", "S1", at), scan("54", "S1", at)],
      finishes: finishes([["S1", T - m(2), 26]]),
      seen: new Map(),
      nowMs: T,
    });
    expect(r.boxes.map((b) => b.camera)).toEqual(["12", "54", "94"]);
  });

  it("survives junk without throwing or emitting a box", () => {
    const r = cameraReturnStripAt({
      scans: [scan("", "S1", T), scan("23", "S1", Number.NaN)],
      finishes: finishes([["S1", T - m(2), 26]]),
      seen: new Map(),
      nowMs: T,
    });
    expect(r.boxes).toEqual([]);
  });

  it("ignores a finish with an unusable end stamp", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(10))],
      finishes: new Map([["S1", { endedAtMs: Number.NaN, heatNumber: 26 }]]),
      seen: new Map(),
      nowMs: T,
    });
    expect(r.boxes).toEqual([]);
  });

  it("never reports negative time for an end stamp in the future", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(10))],
      finishes: finishes([["S1", T + m(1), 26]]),
      seen: new Map(),
      nowMs: T,
    });
    expect(r.boxes[0].sinceFlagMs).toBe(0);
  });

  it("handles a real heat: five cameras out, three back", () => {
    const flag = T - m(3);
    const scans = ["12", "15", "23", "54", "94"].map((c, i) =>
      scan(c, "S26", T - m(12) + i * 1_000),
    );
    const r = cameraReturnStripAt({
      scans,
      finishes: finishes([["S26", flag, 26]]),
      seen: new Map([
        ["12", flag + m(2)],
        ["15", flag + m(2)],
        ["23", flag + m(2)],
      ]),
      nowMs: T,
    });
    expect(r.boxes.map((b) => b.camera)).toEqual(["12", "15", "23", "54", "94"]);
    expect(r.outCount).toBe(2);
    expect(r.boxes.filter((b) => b.state === "out").map((b) => b.camera)).toEqual(["54", "94"]);
  });
});

describe("cameraBarHeight", () => {
  it("reserves nothing when the strip is off the rail", () => {
    expect(cameraBarHeight(null)).toBe(0);
    expect(cameraBarHeight(undefined)).toBe(0);
  });

  it("collapses to a whisper when everything is accounted for", () => {
    // Owner 2026-08-12: "I want the all cameras in to be very small and less
    // noticeable" — the clear state must not cost the helmet poster 104px.
    expect(cameraBarHeight({ boxes: [] })).toBe(CAMERA_BAR_CLEAR_H);
    expect(CAMERA_BAR_CLEAR_H).toBeLessThan(CAMERA_BAR_H / 2);
  });

  it("takes the full band as soon as there is a box to show", () => {
    expect(cameraBarHeight({ boxes: [{}] })).toBe(CAMERA_BAR_H);
  });
});

describe("formatSinceFlag", () => {
  it("says 'just now' under a minute rather than showing 0", () => {
    expect(formatSinceFlag(0)).toBe("just now");
    expect(formatSinceFlag(59_000)).toBe("just now");
  });

  it("counts whole minutes", () => {
    expect(formatSinceFlag(m(1))).toBe("1 min");
    expect(formatSinceFlag(m(18) + 30_000)).toBe("18 min");
    expect(formatSinceFlag(m(59))).toBe("59 min");
  });

  it("rolls to hours so a camera missing all evening still reads", () => {
    expect(formatSinceFlag(m(60))).toBe("1h 0m");
    expect(formatSinceFlag(m(95))).toBe("1h 35m");
  });

  it("does not throw on junk", () => {
    expect(formatSinceFlag(Number.NaN)).toBe("just now");
  });
});
