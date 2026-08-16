import { describe, expect, it } from "vitest";
import { dataSaysMega, megaLadder, pickCurrentSession } from "./mega-mode";

const at = (iso: string) => ({ calledAt: iso });

describe("dataSaysMega", () => {
  it("is false when the mega row is absent — the normal-day short-circuit", () => {
    expect(dataSaysMega({ blue: at("2026-08-16T18:00:00Z"), red: null, mega: null })).toBe(false);
    expect(dataSaysMega({ blue: null, red: null, mega: null })).toBe(false);
    expect(dataSaysMega({ blue: null, red: null, mega: undefined })).toBe(false);
  });

  it("is true when mega is the only row — clean keys", () => {
    expect(dataSaysMega({ blue: null, red: null, mega: at("2026-08-16T21:00:00Z") })).toBe(true);
  });

  it("is true when mega is strictly newer than every present sibling — the transition window", () => {
    expect(
      dataSaysMega({
        blue: at("2026-08-16T17:40:00Z"),
        red: at("2026-08-16T17:52:00Z"),
        mega: at("2026-08-16T21:05:00Z"),
      }),
    ).toBe(true);
    // Only one stale sibling present — mega still wins.
    expect(
      dataSaysMega({
        blue: at("2026-08-16T17:40:00Z"),
        red: null,
        mega: at("2026-08-16T21:05:00Z"),
      }),
    ).toBe(true);
  });

  it("is false when a live split-track heat is newer than the mega row", () => {
    expect(
      dataSaysMega({
        blue: at("2026-08-16T21:10:00Z"),
        red: null,
        mega: at("2026-08-16T21:05:00Z"),
      }),
    ).toBe(false);
  });

  it("resolves ties to normal mode", () => {
    expect(
      dataSaysMega({
        blue: at("2026-08-16T21:00:00Z"),
        red: null,
        mega: at("2026-08-16T21:00:00Z"),
      }),
    ).toBe(false);
  });

  it("treats an unparseable mega stamp as no claim", () => {
    expect(
      dataSaysMega({ blue: at("2026-08-16T17:40:00Z"), red: null, mega: at("not a date") }),
    ).toBe(false);
    expect(dataSaysMega({ blue: at("2026-08-16T17:40:00Z"), red: null, mega: {} })).toBe(false);
  });

  it("an unparseable sibling stamp defeats the mega claim — conservative direction", () => {
    expect(dataSaysMega({ blue: at("garbage"), red: null, mega: at("2026-08-16T21:05:00Z") })).toBe(
      false,
    );
  });
});

describe("pickCurrentSession", () => {
  const exact = { calledAt: "2026-08-16T17:40:00Z", sessionId: 59 };
  const mega = { calledAt: "2026-08-16T21:05:00Z", sessionId: 62 };

  it("returns the exact record when there is no mega record — normal day", () => {
    expect(pickCurrentSession(exact, null)).toBe(exact);
  });

  it("returns the mega record when the exact track has none — the original fallback", () => {
    expect(pickCurrentSession(null, mega)).toBe(mega);
  });

  it("prefers a strictly newer mega record — the stale-carry night", () => {
    expect(pickCurrentSession(exact, mega)).toBe(mega);
  });

  it("keeps the exact record when it is newer than mega", () => {
    const liveExact = { calledAt: "2026-08-16T21:30:00Z", sessionId: 63 };
    expect(pickCurrentSession(liveExact, mega)).toBe(liveExact);
  });

  it("keeps the exact record on a tie", () => {
    const tied = { calledAt: mega.calledAt, sessionId: 60 };
    expect(pickCurrentSession(tied, mega)).toBe(tied);
  });

  it("keeps the exact record when either stamp is missing or unparseable", () => {
    const undated: { calledAt?: string | null; sessionId: number } = { sessionId: 59 };
    expect(pickCurrentSession(undated, mega)).toBe(undated);
    expect(pickCurrentSession(exact, { calledAt: "garbage", sessionId: 62 })).toBe(exact);
  });

  it("returns null when both are null", () => {
    expect(pickCurrentSession(null, null)).toBeNull();
  });
});

describe("megaLadder — the resilience order", () => {
  const base = { flag: null, dataMega: false, dayPlannerMega: null, calendarMega: false } as const;

  it("a fresh flag is authoritative either way", () => {
    expect(megaLadder({ ...base, flag: true })).toBe(true);
    // Fresh false wins over dayplanner AND calendar — ops can run split
    // tracks on a Tuesday and the boards obey.
    expect(
      megaLadder({ flag: false, dataMega: false, dayPlannerMega: true, calendarMega: true }),
    ).toBe(false);
  });

  it("the data signal still overrides a fresh false flag — a called heat cannot lie", () => {
    expect(megaLadder({ ...base, flag: false, dataMega: true })).toBe(true);
  });

  it("flag unavailable: the data signal decides alone when it says mega", () => {
    expect(megaLadder({ ...base, dataMega: true })).toBe(true);
  });

  it("blind: a definite dayplanner verdict is trusted over the calendar, both ways", () => {
    expect(megaLadder({ ...base, dayPlannerMega: true })).toBe(true);
    expect(megaLadder({ ...base, dayPlannerMega: false, calendarMega: true })).toBe(false);
  });

  it("everything dark: the Tuesday calendar is the last resort", () => {
    expect(megaLadder({ ...base, calendarMega: true })).toBe(true);
    expect(megaLadder({ ...base, calendarMega: false })).toBe(false);
  });
});
