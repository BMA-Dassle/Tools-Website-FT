import { describe, expect, it } from "vitest";
import { currentTakeover, visibleInline } from "./standing";
import type { AlertKind, DriverAlert } from "./types";

const T = Date.parse("2026-09-05T07:30:00.000Z");

function a(kind: AlertKind, offsetMs: number, extra: Partial<DriverAlert> = {}): DriverAlert {
  const takeovers: AlertKind[] = [
    "green",
    "blue",
    "caution",
    "red",
    "crash",
    "blackwhite",
    "disqualified",
    "paused",
    "chequered",
  ];
  return {
    kind,
    level: takeovers.includes(kind) ? "takeover" : "inline",
    atMs: T + offsetMs,
    kart: "15",
    sessionId: "58691643",
    sessionName: "65 - Blue Starter",
    note: null,
    value: null,
    expiresAtMs: null,
    eventId: `${kind}:${offsetMs}`,
    source: "test",
    ...extra,
  };
}

/** The feed is newest first, as Redis returns it. */
const feed = (...alerts: DriverAlert[]) => [...alerts].sort((x, y) => y.atMs - x.atMs);

describe("currentTakeover", () => {
  it("shows nothing when nothing is standing", () => {
    expect(currentTakeover([], T)).toBeNull();
    expect(currentTakeover(feed(a("personalBest", 0)), T + 100)).toBeNull();
  });

  it("shows a blue flag, then lets it clear itself", () => {
    const f = feed(a("blue", 0));
    expect(currentTakeover(f, T + 2_000)?.kind).toBe("blue");
    expect(currentTakeover(f, T + 13_000)).toBeNull();
  });

  it("holds a blue flag across several polls, not one", () => {
    // The screen only learns of a flag when the next 2s poll returns it. The
    // first live blue flag was missed entirely at a 6s window (2026-09-05), so
    // the window has to survive a slow poll and still leave time to look up.
    const f = feed(a("blue", 0));
    for (const at of [2_000, 4_000, 6_000, 8_000, 10_000]) {
      expect(currentTakeover(f, T + at)?.kind, `${at}ms`).toBe("blue");
    }
  });

  it("gives a marshal's warning the longest window of the self-clearing flags", () => {
    // It is the only one carrying words the driver has to read.
    const f = feed(a("blackwhite", 0, { note: "Contact into turn 3" }));
    expect(currentTakeover(f, T + 18_000)?.kind).toBe("blackwhite");
    expect(currentTakeover(f, T + 21_000)).toBeNull();
  });

  it("honours the venue's own expiry on a caution", () => {
    const f = feed(a("caution", 0, { expiresAtMs: T + 20_000 }));
    expect(currentTakeover(f, T + 19_000)?.kind).toBe("caution");
    expect(currentTakeover(f, T + 21_000)).toBeNull();
  });

  it("NEVER lets a red flag time out on its own", () => {
    // A red that expires while the marshal is still walking would put a driver
    // back on track. It ends when race control ends it, and not before.
    const f = feed(a("red", 0));
    expect(currentTakeover(f, T + 10 * 60_000)?.kind).toBe("red");
  });

  it("clears a red flag when race control says so", () => {
    const f = feed(a("red", 0), a("recovered", 30_000));
    expect(currentTakeover(f, T + 31_000)).toBeNull();
  });

  it("lets UnCrash clear a crash before its expiry", () => {
    const f = feed(a("crash", 0, { expiresAtMs: T + 20_000 }), a("recovered", 4_000));
    expect(currentTakeover(f, T + 3_000)?.kind).toBe("crash");
    expect(currentTakeover(f, T + 5_000)).toBeNull();
  });

  it("holds a pause until the session resumes", () => {
    const paused = feed(a("paused", 0));
    expect(currentTakeover(paused, T + 5 * 60_000)?.kind).toBe("paused");
    const resumed = feed(a("paused", 0), a("green", 60_000));
    // The green itself shows briefly, then the board — but the pause is gone.
    expect(currentTakeover(resumed, T + 70_000)).toBeNull();
  });

  it("keeps the red flag up when the pause that follows it lands", () => {
    // The venue's real sequence: EmergencyOn 21:45:41, SessionPaused 21:45:43.
    // The pause is a CONSEQUENCE of the emergency, so a newest-wins rule would
    // replace "stay in your kart" with "paused" two seconds after the karts
    // were cut.
    const f = feed(a("red", 0), a("paused", 2_000));
    expect(currentTakeover(f, T + 5_000)?.kind).toBe("red");
    expect(currentTakeover(f, T + 5 * 60_000)?.kind).toBe("red");
  });

  it("walks the whole emergency the way the venue actually sends it", () => {
    // EmergencyOn 21:45:41 → SessionPaused 21:45:43 → SessionResumed 21:46:41
    // → EmergencyOff 21:46:51. Exactly ONE green in that, from the resume; the
    // release is inline and only clears what is left.
    const red = a("red", 0);
    const paused = a("paused", 2_000);
    const green = a("green", 60_000); // SessionResumed
    const released = a("recovered", 70_000); // EmergencyOff — inline, not a takeover
    const f = feed(red, paused, green, released);

    expect(currentTakeover(f, T + 1_000)?.kind).toBe("red");
    expect(currentTakeover(f, T + 30_000)?.kind).toBe("red"); // pause does not displace it
    expect(currentTakeover(f, T + 62_000)?.kind).toBe("green"); // the one green
    expect(currentTakeover(f, T + 75_000)).toBeNull(); // back to the pit board
  });

  it("lets a newer red flag win over a standing caution", () => {
    const f = feed(a("caution", 0, { expiresAtMs: T + 20_000 }), a("red", 5_000));
    expect(currentTakeover(f, T + 8_000)?.kind).toBe("red");
  });

  it("keeps a disqualification on screen — nothing times it out", () => {
    const f = feed(a("disqualified", 0));
    expect(currentTakeover(f, T + 30 * 60_000)?.kind).toBe("disqualified");
  });

  it("does not let an older clear cancel a newer flag", () => {
    // Recovered at +1s, then a fresh crash at +5s: the crash stands.
    const f = feed(a("recovered", 1_000), a("crash", 5_000, { expiresAtMs: T + 25_000 }));
    expect(currentTakeover(f, T + 6_000)?.kind).toBe("crash");
  });

  it("holds the chequered flag until the next heat is announced", () => {
    const held = feed(a("chequered", 0));
    expect(currentTakeover(held, T + 4 * 60_000)?.kind).toBe("chequered");
    const next = feed(a("chequered", 0), a("aboutToStart", 5 * 60_000));
    expect(currentTakeover(next, T + 5 * 60_000 + 1_000)).toBeNull();
  });
});

describe("visibleInline", () => {
  it("shows the newest few, newest first", () => {
    const f = feed(a("personalBest", 0), a("dayRecord", 1_000), a("slowZone", 2_000));
    const v = visibleInline(f, T + 3_000);
    expect(v.map((x) => x.kind)).toEqual(["slowZone", "dayRecord", "personalBest"]);
  });

  it("drops anything past the window", () => {
    const f = feed(a("personalBest", 0));
    expect(visibleInline(f, T + 60_000)).toHaveLength(0);
  });

  it("never stacks duplicates of the same kind", () => {
    // Crash detect re-fires every second or two while a kart sits stopped.
    const f = feed(a("recovered", 0), a("recovered", 1_000), a("recovered", 2_000));
    expect(visibleInline(f, T + 3_000)).toHaveLength(1);
  });

  it("leaves takeovers alone — they have the screen", () => {
    const f = feed(a("red", 0), a("personalBest", 1_000));
    expect(visibleInline(f, T + 2_000).map((x) => x.kind)).toEqual(["personalBest"]);
  });

  it("caps how many can pile up", () => {
    const f = feed(
      a("personalBest", 0),
      a("dayRecord", 100),
      a("slowZone", 200),
      a("restricted", 300),
    );
    expect(visibleInline(f, T + 400)).toHaveLength(3);
  });
});
