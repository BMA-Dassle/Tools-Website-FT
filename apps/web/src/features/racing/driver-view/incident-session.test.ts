import { describe, expect, it } from "vitest";
import {
  clearKart,
  INCIDENT_IDLE_MS,
  isStale,
  joinIncident,
  type IncidentState,
} from "./incident-session";

const T = Date.parse("2026-09-05T04:00:00.000Z");
const S = "59315640";

const open = (kart: string, atMs = T, eventId = "e1") =>
  joinIncident(null, { sessionId: S, kart, atMs, eventId });

describe("joinIncident", () => {
  it("opens on the first crash, and that one is the yellow", () => {
    const r = open("6");
    expect(r.isNew).toBe(true);
    expect(r.state.id).toBe("e1");
    expect(r.state.open).toEqual(["6"]);
  });

  it("a SECOND kart joins the same incident and raises nothing", () => {
    // This is the bug: nine karts in a heat produced nine yellows.
    const first = open("6");
    const second = joinIncident(first.state, {
      sessionId: S,
      kart: "28",
      atMs: T + 328,
      eventId: "e2",
    });
    expect(second.isNew).toBe(false);
    expect(second.isNewKart).toBe(true);
    expect(second.state.id).toBe("e1"); // still the first crash's id
    expect(second.state.open).toEqual(["6", "28"]);
  });

  it("the SAME kart re-firing joins and raises nothing", () => {
    // The venue re-announces crash detect every second or two while a kart
    // sits stopped. 2,239 rows in one session came from this.
    let state: IncidentState | null = open("6").state;
    for (let i = 1; i <= 20; i++) {
      const r = joinIncident(state, {
        sessionId: S,
        kart: "6",
        atMs: T + i * 1500,
        eventId: `re${i}`,
      });
      expect(r.isNew, `re-fire ${i}`).toBe(false);
      expect(r.isNewKart, `re-fire ${i}`).toBe(false);
      state = r.state;
    }
    expect(state!.karts).toEqual(["6"]);
    expect(state!.open).toEqual(["6"]);
  });

  it("starts a new incident once everyone has cleared", () => {
    const first = open("6");
    const cleared = clearKart(first.state, { sessionId: S, kart: "6", atMs: T + 20_000 });
    expect(cleared.closed).toBe(true);
    const next = joinIncident(cleared.state, {
      sessionId: S,
      kart: "9",
      atMs: T + 25_000,
      eventId: "e9",
    });
    expect(next.isNew).toBe(true);
    expect(next.state.id).toBe("e9");
  });

  it("starts a new incident after a long silence, even with a kart still open", () => {
    const first = open("6");
    const later = joinIncident(first.state, {
      sessionId: S,
      kart: "6",
      atMs: T + INCIDENT_IDLE_MS + 1000,
      eventId: "eLate",
    });
    expect(later.isNew).toBe(true);
  });

  it("never merges across sessions", () => {
    const first = open("6");
    const other = joinIncident(first.state, {
      sessionId: "59315648",
      kart: "6",
      atMs: T + 1000,
      eventId: "eOther",
    });
    expect(other.isNew).toBe(true);
    expect(other.state.sessionId).toBe("59315648");
  });
});

describe("clearKart", () => {
  it("keeps the incident open until the LAST kart clears", () => {
    const a = open("6");
    const b = joinIncident(a.state, { sessionId: S, kart: "28", atMs: T + 300, eventId: "e2" });

    const one = clearKart(b.state, { sessionId: S, kart: "6", atMs: T + 10_000 });
    expect(one.closed).toBe(false);
    expect(one.state?.open).toEqual(["28"]);

    const two = clearKart(one.state, { sessionId: S, kart: "28", atMs: T + 14_000 });
    expect(two.closed).toBe(true);
    expect(two.state?.open).toEqual([]);
  });

  it("ignores a clear for a kart that was not in it", () => {
    const a = open("6");
    const r = clearKart(a.state, { sessionId: S, kart: "31", atMs: T + 5_000 });
    expect(r.closed).toBe(false);
    expect(r.state?.open).toEqual(["6"]);
  });

  it("does not close twice on a repeated clear", () => {
    const a = open("6");
    const first = clearKart(a.state, { sessionId: S, kart: "6", atMs: T + 9_000 });
    expect(first.closed).toBe(true);
    const again = clearKart(first.state, { sessionId: S, kart: "6", atMs: T + 9_500 });
    expect(again.closed).toBe(false);
  });
});

describe("isStale", () => {
  it("gives up on an incident whose clear never came", () => {
    // A kart towed off, or a missed UnCrash, must not leave a yellow standing
    // over a clean track all night.
    const a = open("6");
    expect(isStale(a.state, T + 30_000)).toBe(false);
    expect(isStale(a.state, T + INCIDENT_IDLE_MS + 1)).toBe(true);
    expect(isStale(null, T)).toBe(false);
  });
});
