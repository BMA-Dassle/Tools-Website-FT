import { describe, expect, it } from "vitest";
import { isMuted, MUTED_KINDS } from "./muted";
import { currentTakeover, visibleInline } from "./standing";
import { buildReport } from "./report";
import type { AlertKind, DriverAlert } from "./types";

const T = Date.parse("2026-09-05T04:00:00.000Z");

function alert(
  kind: AlertKind,
  offsetMs = 0,
  level: "takeover" | "inline" = "takeover",
): DriverAlert {
  return {
    kind,
    level,
    atMs: T + offsetMs,
    kart: "15",
    sessionId: "s1",
    sessionName: "65 - Blue Starter",
    note: null,
    value: null,
    expiresAtMs: null,
    eventId: `${kind}:${offsetMs}`,
    source: "test",
  };
}

describe("the mute", () => {
  it("currently silences the bystander yellow and nothing else", () => {
    expect(isMuted("caution")).toBe(true);
    expect(MUTED_KINDS.size).toBe(1);
  });

  it("still lets a driver's OWN kart take the screen", () => {
    // The mute drops "someone else spun", never "you have been slowed".
    expect(isMuted("crash")).toBe(false);
    expect(isMuted("red")).toBe(false);
    expect(isMuted("blue")).toBe(false);
  });
});

describe("muted kinds never reach a screen", () => {
  it("is skipped as a takeover even when it is the newest thing standing", () => {
    const f = [alert("caution", 1_000), alert("blue", 0)].sort((a, b) => b.atMs - a.atMs);
    expect(currentTakeover(f, T + 2_000)?.kind).toBe("blue");
  });

  it("shows nothing at all when the caution is the only alert", () => {
    expect(currentTakeover([alert("caution")], T + 1_000)).toBeNull();
  });

  it("is dropped from a feed left over from before the mute", () => {
    // Live feeds carry a six-hour TTL, so entries written before the mute are
    // still arriving at screens.
    const stale = [alert("caution", -60_000)];
    expect(currentTakeover(stale, T)).toBeNull();
  });

  it("does not sneak in as an inline toast either", () => {
    const f = [alert("caution", 0, "inline"), alert("personalBest", 500, "inline")];
    expect(visibleInline(f, T + 1_000).map((a) => a.kind)).toEqual(["personalBest"]);
  });
});

describe("muted kinds never reach the history", () => {
  it("keeps the caution rows already stored out of the timeline", () => {
    const report = buildReport({
      sessionId: "s1",
      sessionName: "65 - Blue Starter",
      track: "blue",
      standings: [],
      crossings: [
        {
          kart: "15",
          participantName: "Eric Osborn",
          passingId: "p1",
          lapTimeMs: 31208,
          atUtc: new Date(T).toISOString(),
        },
      ],
      events: [
        { eventId: "c1", kind: "caution", kart: "22", note: null, value: "22", atMs: T },
        { eventId: "x1", kind: "crash", kart: "15", note: null, value: null, atMs: T + 1_000 },
        { eventId: "b1", kind: "blue", kart: "15", note: null, value: null, atMs: T + 2_000 },
      ],
    });
    const kinds = report.timeline.map((e) => e.kind);
    expect(kinds).not.toContain("caution");
    expect(kinds).toEqual(["crash", "blue"]);
  });
});
