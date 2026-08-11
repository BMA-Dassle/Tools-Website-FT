import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_AGE_MS, raceAgeMinutes, raceStillDisplayable } from "./current-race-freshness";

const NOW = Date.parse("2026-08-11T17:32:00Z"); // 1:32 PM ET, a Tuesday
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("raceStillDisplayable", () => {
  it("shows a heat called moments ago", () => {
    expect(raceStillDisplayable({ calledAt: iso(60_000) }, NOW)).toBe(true);
  });

  it("SHOWS A PRE-OPEN HEAT — the whole point of this rule", () => {
    // 1:31 PM ET on a Tuesday. FastTrax does not open to the public until 3 PM,
    // and the old hours gate returned an explicit empty here, so a group event's
    // called heat appeared on no board in the building (owner 2026-08-11).
    const groupEventHeat = { calledAt: "2026-08-11T13:31:41-04:00" };
    expect(raceStillDisplayable(groupEventHeat, NOW)).toBe(true);
  });

  it("shows a heat through the gap between heats", () => {
    // Pandora expires its own copy after ~20 min; the stored one carries it.
    expect(raceStillDisplayable({ calledAt: iso(35 * 60_000) }, NOW)).toBe(true);
  });

  it("hides last night's finale the next morning", () => {
    // 11 PM call, read at 9 AM — the case the old hours gate existed to stop, and
    // this must keep stopping it.
    const lastNight = Date.parse("2026-08-10T23:00:00-04:00");
    const nextMorning = Date.parse("2026-08-11T09:00:00-04:00");
    expect(raceStillDisplayable({ calledAt: new Date(lastNight).toISOString() }, nextMorning)).toBe(
      false,
    );
  });

  it("keeps the old end-of-night reach: an 11 PM heat still shows at 4:30 AM", () => {
    // The previous rule served data until 5 AM. The six-hour window is chosen to
    // match that, so this change only ever ADDS visibility.
    const calledAt = "2026-08-10T23:00:00-04:00";
    const at430am = Date.parse("2026-08-11T04:30:00-04:00");
    expect(raceStillDisplayable({ calledAt }, at430am)).toBe(true);
  });

  it("is exact at the boundary", () => {
    expect(raceStillDisplayable({ calledAt: iso(MAX_DISPLAY_AGE_MS) }, NOW)).toBe(true);
    expect(raceStillDisplayable({ calledAt: iso(MAX_DISPLAY_AGE_MS + 1) }, NOW)).toBe(false);
  });

  it("honours a caller-supplied window", () => {
    expect(raceStillDisplayable({ calledAt: iso(20 * 60_000) }, NOW, 10 * 60_000)).toBe(false);
    expect(raceStillDisplayable({ calledAt: iso(5 * 60_000) }, NOW, 10 * 60_000)).toBe(true);
  });

  it("treats a future-stamped call as fresh (clock skew at the track)", () => {
    expect(raceStillDisplayable({ calledAt: iso(-120_000) }, NOW)).toBe(true);
  });

  it("FAILS OPEN on a missing or unparseable calledAt", () => {
    // Deliberate: this field is the entire input to the rule, so if an upstream
    // stops sending it, failing closed would blank every board at once. One
    // stale line is the cheaper error, and the Redis TTL still clears it.
    expect(raceStillDisplayable({}, NOW)).toBe(true);
    expect(raceStillDisplayable({ calledAt: null }, NOW)).toBe(true);
    expect(raceStillDisplayable({ calledAt: "not a date" }, NOW)).toBe(true);
  });

  it("is false for no race at all", () => {
    expect(raceStillDisplayable(null, NOW)).toBe(false);
    expect(raceStillDisplayable(undefined, NOW)).toBe(false);
  });

  it("does not depend on the hour of day — same age, four different clocks", () => {
    // The regression guard: any reintroduced clock gate breaks this.
    for (const hour of ["01:00", "09:00", "13:30", "22:00"]) {
      const now = Date.parse(`2026-08-11T${hour}:00-04:00`);
      const calledFiveMinsAgo = new Date(now - 5 * 60_000).toISOString();
      expect(raceStillDisplayable({ calledAt: calledFiveMinsAgo }, now)).toBe(true);
    }
  });
});

describe("raceAgeMinutes", () => {
  it("reports whole minutes since the call", () => {
    expect(raceAgeMinutes({ calledAt: iso(7 * 60_000) }, NOW)).toBe(7);
  });

  it("is null when there is nothing to measure", () => {
    expect(raceAgeMinutes(null, NOW)).toBeNull();
    expect(raceAgeMinutes({ calledAt: "nonsense" }, NOW)).toBeNull();
  });
});
