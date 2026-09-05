import { describe, expect, it } from "vitest";
import { clusterCrashes, leadConfidence, type CrashTrigger } from "./incidents";

/**
 * A REAL CASCADE from `kart:events:queue`, 2026-09-03 20:23:11 ET — six karts
 * over sixteen seconds. Reproduced with the measured offsets, because the shape
 * of this one is the argument for why "first" is a lead and not a verdict.
 */
const T0 = Date.parse("2026-09-04T00:23:11.000Z");
const CASCADE: CrashTrigger[] = [
  { kart: "6", atMs: T0 + 0, eventId: "e1", sessionId: "s1" },
  { kart: "28", atMs: T0 + 328, eventId: "e2", sessionId: "s1" },
  { kart: "10", atMs: T0 + 1375, eventId: "e3", sessionId: "s1" },
  { kart: "1", atMs: T0 + 7656, eventId: "e4", sessionId: "s1" },
  { kart: "11", atMs: T0 + 8736, eventId: "e5", sessionId: "s1" },
  { kart: "33", atMs: T0 + 16412, eventId: "e6", sessionId: "s1" },
];

/** Two karts, 172ms apart — 2026-09-03 20:32:11. This one really is contact. */
const T1 = Date.parse("2026-09-04T00:32:11.000Z");
const CONTACT: CrashTrigger[] = [
  { kart: "28", atMs: T1 + 0, eventId: "c1", sessionId: "s1" },
  { kart: "11", atMs: T1 + 172, eventId: "c2", sessionId: "s1" },
];

describe("clusterCrashes", () => {
  it("names the kart that tripped first, in order", () => {
    // A window wide enough to hold the whole cascade, to show the ordering.
    // The default gap deliberately splits it — see the next test.
    const [incident] = clusterCrashes(CASCADE, 20_000);
    expect(incident.firstKart).toBe("6");
    expect(incident.karts).toEqual(["6", "28", "10", "1", "11", "33"]);
    expect(incident.leadMs).toBe(328);
  });

  it("splits the cascade where the gap exceeds the window", () => {
    // At 4s the +7656 arrival starts a new incident: by then it is another
    // driver reaching a corner that is already blocked, not the same impact.
    const incidents = clusterCrashes(CASCADE, 4000);
    expect(incidents).toHaveLength(3);
    expect(incidents[0].karts).toEqual(["6", "28", "10"]);
    expect(incidents[1].karts).toEqual(["1", "11"]);
    expect(incidents[2].karts).toEqual(["33"]);
  });

  it("counts one kart re-triggering as one kart, not several", () => {
    // The venue re-fires crash detect while a kart sits stopped — kart 15's own
    // log alternates Crash/UnCrash every second or two.
    const repeated: CrashTrigger[] = [
      { kart: "15", atMs: T1, eventId: "r1", sessionId: "s1" },
      { kart: "15", atMs: T1 + 900, eventId: "r2", sessionId: "s1" },
      { kart: "15", atMs: T1 + 1800, eventId: "r3", sessionId: "s1" },
    ];
    const [incident] = clusterCrashes(repeated);
    expect(incident.karts).toEqual(["15"]);
    expect(incident.leadMs).toBeNull();
    expect(incident.triggers).toHaveLength(3);
  });

  it("orders deterministically when two triggers share a millisecond", () => {
    const tied: CrashTrigger[] = [
      { kart: "9", atMs: T1, eventId: "zz", sessionId: null },
      { kart: "8", atMs: T1, eventId: "aa", sessionId: null },
    ];
    expect(clusterCrashes(tied)[0].firstKart).toBe("8");
  });

  it("returns nothing for nothing", () => {
    expect(clusterCrashes([])).toEqual([]);
  });
});

describe("leadConfidence", () => {
  it("calls a sub-400ms lead simultaneous — the order says little", () => {
    expect(leadConfidence(clusterCrashes(CONTACT)[0])).toBe("simultaneous");
  });

  it("calls a longer lead sequential", () => {
    const [incident] = clusterCrashes(CASCADE.slice(0, 3));
    // 6 -> 28 at 328ms is still simultaneous; widen to the 1375ms arrival.
    expect(incident.leadMs).toBe(328);
    const later = clusterCrashes([CASCADE[0], CASCADE[2]])[0];
    expect(leadConfidence(later)).toBe("sequential");
  });

  it("says alone when only one kart was involved", () => {
    const solo = clusterCrashes([{ kart: "15", atMs: T1, eventId: "s", sessionId: null }])[0];
    expect(leadConfidence(solo)).toBe("alone");
  });
});
