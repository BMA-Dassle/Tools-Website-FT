import { describe, it, expect } from "vitest";
import {
  cameraReturnStripAt,
  formatSinceFlag,
  INCOMING_FALLBACK_MS,
  SEEN_SKEW_MS,
  type CameraScan,
  type CameraTrack,
  type SessionFinish,
} from "./camera-return";
import { cameraBarHeight, CAMERA_BAR_H, CAMERA_BAR_CLEAR_H } from "../components/CameraReturnBar";

const T = Date.parse("2026-08-12T23:00:00.000Z");
const m = (n: number) => n * 60_000;

function scan(camera: string, sessionId: string, atMs: number): CameraScan {
  return { camera, sessionId, assignedAtMs: atMs };
}

/** [sessionId, endedAtMs, heatNumber, track?] */
function finishes(
  entries: Array<[string, number, number | null, (CameraTrack | null)?]>,
): Map<string, SessionFinish> {
  return new Map(
    entries.map(([sid, endedAtMs, heatNumber, track]) => [
      sid,
      { endedAtMs, heatNumber, track: track ?? null },
    ]),
  );
}
function called(entries: Array<[CameraTrack, number]>): Map<CameraTrack, number> {
  return new Map(entries);
}
const NONE_CALLED = new Map<CameraTrack, number>();

describe("cameraReturnStripAt", () => {
  it("is empty when nothing has been scanned", () => {
    const r = cameraReturnStripAt({
      scans: [],
      finishes: new Map(),
      seen: new Map(),
      calledHeats: NONE_CALLED,
      nowMs: T,
    });
    expect(r.stillOut).toEqual([]);
    expect(r.incoming).toEqual([]);
    expect(r.outCount).toBe(0);
  });

  it("ignores a camera whose race has not finished — nothing to chase yet", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(20))],
      finishes: new Map(),
      seen: new Map(),
      calledHeats: called([["blue", 60]]),
      nowMs: T,
    });
    expect(r.stillOut).toEqual([]);
    expect(r.incoming).toEqual([]);
  });
});

describe("the incoming section", () => {
  it("puts a just-finished camera in INCOMING as waiting, not still-out", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S58", T - m(20))],
      finishes: finishes([["S58", T - m(2), 58, "blue"]]),
      seen: new Map(),
      // Heat 58 is still the last one called — the next has not gone up.
      calledHeats: called([["blue", 58]]),
      nowMs: T,
    });
    expect(r.stillOut).toEqual([]);
    expect(r.incoming).toHaveLength(1);
    expect(r.incoming[0]).toMatchObject({ camera: "23", state: "waiting", track: "blue" });
    expect(r.outCount).toBe(0);
  });

  it("turns it green once it registers, and keeps it in INCOMING", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S58", T - m(20))],
      finishes: finishes([["S58", T - m(2), 58, "blue"]]),
      seen: new Map([["23", T - m(1)]]),
      calledHeats: called([["blue", 58]]),
      nowMs: T,
    });
    expect(r.incoming[0].state).toBe("back");
    expect(r.stillOut).toEqual([]);
  });

  it("green persists past any old timer — it waits for the next call", () => {
    // The 90-second green hold is gone. A camera that came back stays green for
    // as long as its group is the one that just came off track.
    const r = cameraReturnStripAt({
      scans: [scan("23", "S58", T - m(40))],
      finishes: finishes([["S58", T - m(25), 58, "blue"]]),
      seen: new Map([["23", T - m(24)]]),
      calledHeats: called([["blue", 58]]),
      nowMs: T,
    });
    expect(r.incoming[0].state).toBe("back");
  });

  it("a sighting BEFORE the flag does not count — a previous heat's late upload", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S58", T - m(20))],
      finishes: finishes([["S58", T - m(3), 58, "blue"]]),
      seen: new Map([["23", T - m(5)]]),
      calledHeats: called([["blue", 58]]),
      nowMs: T,
    });
    expect(r.incoming[0].state).toBe("waiting");
  });

  it("tolerates clock skew between the venue stamp and VT3", () => {
    const flag = T - m(3);
    const stateFor = (seenAt: number) =>
      cameraReturnStripAt({
        scans: [scan("23", "S58", T - m(20))],
        finishes: finishes([["S58", flag, 58, "blue"]]),
        seen: new Map([["23", seenAt]]),
        calledHeats: called([["blue", 58]]),
        nowMs: T,
      }).incoming[0].state;
    expect(stateFor(flag - (SEEN_SKEW_MS - 1_000))).toBe("back");
    expect(stateFor(flag - (SEEN_SKEW_MS + 1_000))).toBe("waiting");
  });
});

describe("the next race being called", () => {
  it("moves an unregistered camera left into STILL OUT", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S58", T - m(20))],
      finishes: finishes([["S58", T - m(6), 58, "blue"]]),
      seen: new Map(),
      // Heat 59 is up — 58's cameras should have been handed back by now.
      calledHeats: called([["blue", 59]]),
      nowMs: T,
    });
    expect(r.incoming).toEqual([]);
    expect(r.stillOut).toHaveLength(1);
    expect(r.stillOut[0]).toMatchObject({ camera: "23", state: "still-out" });
    expect(r.outCount).toBe(1);
  });

  it("clears a registered camera off the strip entirely", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S58", T - m(20))],
      finishes: finishes([["S58", T - m(6), 58, "blue"]]),
      seen: new Map([["23", T - m(4)]]),
      calledHeats: called([["blue", 59]]),
      nowMs: T,
    });
    expect(r.stillOut).toEqual([]);
    expect(r.incoming).toEqual([]);
  });

  it("only the SAME track's call settles a camera", () => {
    // Red heat 70 being called says nothing about a Blue heat 58's cameras.
    const r = cameraReturnStripAt({
      scans: [scan("23", "S58", T - m(20))],
      finishes: finishes([["S58", T - m(2), 58, "blue"]]),
      seen: new Map(),
      calledHeats: called([["red", 70]]),
      nowMs: T,
    });
    expect(r.incoming).toHaveLength(1);
    expect(r.stillOut).toEqual([]);
  });

  it("an EARLIER call does not settle it — heat numbers only go up", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S58", T - m(20))],
      finishes: finishes([["S58", T - m(2), 58, "blue"]]),
      seen: new Map(),
      calledHeats: called([["blue", 57]]),
      nowMs: T,
    });
    expect(r.incoming).toHaveLength(1);
  });

  it("falls back to a time bound when the heat has no number", () => {
    // A group event or custom race: nothing to compare a call against, so a
    // camera must not be pinned in incoming for the rest of the night.
    const build = (sinceFlag: number) =>
      cameraReturnStripAt({
        scans: [scan("23", "S58", T - m(60))],
        finishes: finishes([["S58", T - sinceFlag, null, "blue"]]),
        seen: new Map(),
        calledHeats: called([["blue", 59]]),
        nowMs: T,
      });
    expect(build(INCOMING_FALLBACK_MS - m(1)).incoming).toHaveLength(1);
    expect(build(INCOMING_FALLBACK_MS + m(1)).stillOut).toHaveLength(1);
  });

  it("falls back to the time bound when nothing has been called on that track", () => {
    const build = (sinceFlag: number) =>
      cameraReturnStripAt({
        scans: [scan("23", "S58", T - m(60))],
        finishes: finishes([["S58", T - sinceFlag, 58, "blue"]]),
        seen: new Map(),
        calledHeats: NONE_CALLED,
        nowMs: T,
      });
    expect(build(m(2)).incoming).toHaveLength(1);
    expect(build(INCOMING_FALLBACK_MS + m(1)).stillOut).toHaveLength(1);
  });
});

describe("one box per camera, oldest debt first", () => {
  it("reports the OLDEST unresolved heat when a camera went out twice", () => {
    const r = cameraReturnStripAt({
      scans: [scan("8", "S56", T - m(40)), scan("8", "S58", T - m(12))],
      finishes: finishes([
        ["S56", T - m(30), 56, "blue"],
        ["S58", T - m(2), 58, "blue"],
      ]),
      seen: new Map(),
      calledHeats: called([["blue", 58]]),
      nowMs: T,
    });
    // 58 has been called, so heat 56's debt is settled-by-call and reads red. One
    // box for camera 8, and it reports the older debt rather than the newer scan.
    expect(r.stillOut).toHaveLength(1);
    expect(r.stillOut[0]).toMatchObject({ camera: "8", heatNumber: 56 });
    expect(r.incoming).toEqual([]);
  });

  it("an open debt outranks a settled one on the same camera", () => {
    const r = cameraReturnStripAt({
      scans: [scan("8", "S56", T - m(40)), scan("8", "S58", T - m(12))],
      finishes: finishes([["S56", T - m(30), 56, "blue"]]),
      seen: new Map(),
      calledHeats: called([["blue", 58]]),
      nowMs: T,
    });
    expect(r.stillOut).toHaveLength(1);
    expect(r.stillOut[0].heatNumber).toBe(56);
  });

  it("a sighting after a later flag settles the earlier heat too", () => {
    // Physically true and worth pinning: at a base station after heat 58 ended
    // means the camera is in the building, which retires 56's debt as well.
    const r = cameraReturnStripAt({
      scans: [scan("8", "S56", T - m(40)), scan("8", "S58", T - m(12))],
      finishes: finishes([
        ["S56", T - m(30), 56, "blue"],
        ["S58", T - m(2), 58, "blue"],
      ]),
      seen: new Map([["8", T - m(1)]]),
      calledHeats: called([["blue", 58]]),
      nowMs: T,
    });
    expect(r.stillOut).toEqual([]);
    expect(r.incoming).toHaveLength(1);
    expect(r.incoming[0]).toMatchObject({ camera: "8", state: "back", heatNumber: 58 });
  });

  it("orders each section oldest-first, ties broken by camera number", () => {
    const at = T - m(10);
    const r = cameraReturnStripAt({
      scans: [scan("94", "S1", at), scan("12", "S1", at), scan("54", "S1", at)],
      finishes: finishes([["S1", T - m(4), 26, "red"]]),
      seen: new Map(),
      calledHeats: called([["red", 27]]),
      nowMs: T,
    });
    expect(r.stillOut.map((b) => b.camera)).toEqual(["12", "54", "94"]);
  });
});

describe("track identity", () => {
  it("carries the circuit on both sections", () => {
    const r = cameraReturnStripAt({
      scans: [scan("10", "SOLD", T - m(40)), scan("20", "SNEW", T - m(10))],
      finishes: finishes([
        ["SOLD", T - m(30), 40, "red"],
        ["SNEW", T - m(2), 41, "mega"],
      ]),
      seen: new Map(),
      calledHeats: called([
        ["red", 41],
        ["mega", 41],
      ]),
      nowMs: T,
    });
    expect(r.stillOut[0]).toMatchObject({ camera: "10", track: "red" });
    expect(r.incoming[0]).toMatchObject({ camera: "20", track: "mega" });
  });

  it("is null when the finish record never named a track", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(20))],
      finishes: finishes([["S1", T - m(2), 58]]),
      seen: new Map(),
      calledHeats: called([["blue", 58]]),
      nowMs: T,
    });
    expect(r.incoming[0].track).toBeNull();
  });
});

describe("robustness", () => {
  it("survives junk without throwing or emitting a box", () => {
    const r = cameraReturnStripAt({
      scans: [scan("", "S1", T), scan("23", "S1", Number.NaN)],
      finishes: finishes([["S1", T - m(2), 26, "red"]]),
      seen: new Map(),
      calledHeats: NONE_CALLED,
      nowMs: T,
    });
    expect(r.stillOut).toEqual([]);
    expect(r.incoming).toEqual([]);
  });

  it("ignores a finish with an unusable end stamp", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(10))],
      finishes: new Map([["S1", { endedAtMs: Number.NaN, heatNumber: 26, track: null }]]),
      seen: new Map(),
      calledHeats: NONE_CALLED,
      nowMs: T,
    });
    expect(r.incoming).toEqual([]);
  });

  it("never reports negative time for an end stamp in the future", () => {
    const r = cameraReturnStripAt({
      scans: [scan("23", "S1", T - m(10))],
      finishes: finishes([["S1", T + m(1), 26, "red"]]),
      seen: new Map(),
      calledHeats: called([["red", 26]]),
      nowMs: T,
    });
    expect(r.incoming[0].sinceFlagMs).toBe(0);
  });

  it("handles a real heat: five out, three back, next race not yet called", () => {
    const flag = T - m(3);
    const scans = ["12", "15", "23", "54", "94"].map((c, i) =>
      scan(c, "S26", T - m(12) + i * 1_000),
    );
    const r = cameraReturnStripAt({
      scans,
      finishes: finishes([["S26", flag, 26, "red"]]),
      seen: new Map([
        ["12", flag + m(2)],
        ["15", flag + m(2)],
        ["23", flag + m(2)],
      ]),
      calledHeats: called([["red", 26]]),
      nowMs: T,
    });
    expect(r.stillOut).toEqual([]);
    expect(r.incoming.map((b) => b.camera)).toEqual(["12", "15", "23", "54", "94"]);
    expect(r.incoming.filter((b) => b.state === "back").map((b) => b.camera)).toEqual([
      "12",
      "15",
      "23",
    ]);
    expect(r.incoming.filter((b) => b.state === "waiting").map((b) => b.camera)).toEqual([
      "54",
      "94",
    ]);
    expect(r.outCount).toBe(0);
  });

  it("that same heat settles the moment heat 27 is called", () => {
    const flag = T - m(3);
    const scans = ["12", "15", "23", "54", "94"].map((c, i) =>
      scan(c, "S26", T - m(12) + i * 1_000),
    );
    const r = cameraReturnStripAt({
      scans,
      finishes: finishes([["S26", flag, 26, "red"]]),
      seen: new Map([
        ["12", flag + m(2)],
        ["15", flag + m(2)],
        ["23", flag + m(2)],
      ]),
      calledHeats: called([["red", 27]]),
      nowMs: T,
    });
    // The three that registered are gone; the two that never did are now red.
    expect(r.incoming).toEqual([]);
    expect(r.stillOut.map((b) => b.camera)).toEqual(["54", "94"]);
    expect(r.outCount).toBe(2);
  });
});

describe("the maintenance bench", () => {
  // The filter itself lives in the resolver (it needs Neon), but the contract it
  // relies on is here: a camera simply absent from `scans` must leave no trace in
  // any count, order or section. That is why the resolver filters at the scan
  // level rather than stripping boxes afterwards.
  it("a filtered-out camera leaves no trace anywhere", () => {
    const all = [
      scan("3", "S58", T - m(20)),
      scan("6", "S58", T - m(19)),
      scan("23", "S58", T - m(18)),
    ];
    const fin = finishes([["S58", T - m(6), 58, "blue"]]);
    const args = {
      finishes: fin,
      seen: new Map<string, number>(),
      calledHeats: called([["blue", 59]]),
      nowMs: T,
    };

    const withBench = cameraReturnStripAt({ scans: all, ...args });
    expect(withBench.stillOut.map((b) => b.camera)).toEqual(["3", "6", "23"]);
    expect(withBench.outCount).toBe(3);

    // Same night with 3 and 6 on the bench.
    const filtered = cameraReturnStripAt({
      scans: all.filter((s) => s.camera !== "3" && s.camera !== "6"),
      ...args,
    });
    expect(filtered.stillOut.map((b) => b.camera)).toEqual(["23"]);
    expect(filtered.outCount).toBe(1);
  });

  it("benching every scanned camera reads as a genuine all-clear", () => {
    const r = cameraReturnStripAt({
      scans: [],
      finishes: finishes([["S58", T - m(6), 58, "blue"]]),
      seen: new Map(),
      calledHeats: called([["blue", 59]]),
      nowMs: T,
    });
    expect(r.stillOut).toEqual([]);
    expect(r.incoming).toEqual([]);
    expect(r.outCount).toBe(0);
  });
});

describe("cameraBarHeight", () => {
  it("reserves nothing when the strip is off the rail", () => {
    expect(cameraBarHeight(null)).toBe(0);
    expect(cameraBarHeight(undefined)).toBe(0);
  });

  it("collapses to a whisper when there is nothing in either section", () => {
    expect(cameraBarHeight({ stillOut: [], incoming: [] })).toBe(CAMERA_BAR_CLEAR_H);
    expect(CAMERA_BAR_CLEAR_H).toBeLessThan(CAMERA_BAR_H / 2);
  });

  it("takes the full band for either section having content", () => {
    expect(cameraBarHeight({ stillOut: [{}], incoming: [] })).toBe(CAMERA_BAR_H);
    expect(cameraBarHeight({ stillOut: [], incoming: [{}] })).toBe(CAMERA_BAR_H);
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
