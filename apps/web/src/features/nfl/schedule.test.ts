import { describe, expect, it } from "vitest";
import {
  NFL_LEAD_MINUTES,
  NFL_WINDOW_MINUTES,
  bookedAtFor,
  datesOf,
  gameLabel,
  gameMatchesBookedAt,
  gameWindow,
  sellableGames,
  upcomingFrom,
  windowFitsHours,
  windowStartDateEt,
  windowsOverlap,
  type NflGame,
} from "./schedule";

/**
 * Every kickoff below is a REAL 2026-season kickoff, read off ESPN's schedule on
 * 2026-08-25. Made-up times would have hidden the two cases that actually shape
 * the feature: the 9:30 AM London game the center cannot open for, and a Sunday
 * carrying both a 4:05 and a 4:25 kickoff.
 */
function game(over: Partial<NflGame> & Pick<NflGame, "kickoffIso">): NflGame {
  return {
    id: "evt",
    dateEt: "2026-09-13",
    awayTeam: "Buccaneers",
    homeTeam: "Bengals",
    network: "FOX",
    week: 1,
    season: 2026,
    seasonType: 2,
    ...over,
  };
}

// Week 1 Sunday, all EDT (-04:00).
const SUN_1PM = game({ id: "g1", kickoffIso: "2026-09-13T17:00:00Z" }); // 1:00 PM ET
const SUN_425 = game({ id: "g2", kickoffIso: "2026-09-13T20:25:00Z" }); // 4:25 PM ET
const SUN_820 = game({ id: "g3", kickoffIso: "2026-09-14T00:20:00Z" }); // 8:20 PM ET
const THU_835 = game({ id: "g4", dateEt: "2026-09-10", kickoffIso: "2026-09-11T00:35:00Z" }); // 8:35 PM ET

// November 8 — the Sunday AFTER DST ends (Nov 1), so these are EST (-05:00).
const NOV_930AM = game({ id: "n0", dateEt: "2026-11-08", kickoffIso: "2026-11-08T14:30:00Z" }); // 9:30 AM ET, London
const NOV_1PM = game({ id: "n1", dateEt: "2026-11-08", kickoffIso: "2026-11-08T18:00:00Z" }); // 1:00 PM ET
const NOV_405 = game({ id: "n2", dateEt: "2026-11-08", kickoffIso: "2026-11-08T21:05:00Z" }); // 4:05 PM ET
const NOV_425 = game({ id: "n3", dateEt: "2026-11-08", kickoffIso: "2026-11-08T21:25:00Z" }); // 4:25 PM ET
const NOV_820 = game({ id: "n4", dateEt: "2026-11-08", kickoffIso: "2026-11-09T01:20:00Z" }); // 8:20 PM ET

// HeadPinz: Sun-Thu 11AM-12AM, Fri-Sat 11AM-2AM (0-26 notation).
const WEEKDAY_HOURS = { open: 11, close: 24 };
const WEEKEND_HOURS = { open: 11, close: 26 };

describe("constants", () => {
  it("sells a 3-hour window opening 15 minutes before kickoff", () => {
    expect(NFL_WINDOW_MINUTES).toBe(180);
    expect(NFL_LEAD_MINUTES).toBe(15);
  });
});

describe("bookedAtFor — the string QAMF is handed", () => {
  it("is exactly 15 minutes before kickoff, off-grid minutes and all", () => {
    expect(bookedAtFor(SUN_1PM)).toBe("2026-09-13T12:45:00-04:00");
    expect(bookedAtFor(SUN_425)).toBe("2026-09-13T16:10:00-04:00");
    expect(bookedAtFor(SUN_820)).toBe("2026-09-13T20:05:00-04:00");
    expect(bookedAtFor(THU_835)).toBe("2026-09-10T20:20:00-04:00");
  });

  it("switches to EST after the November DST change", () => {
    // The whole reason the World Cup's hardcoded -04:00 could not be reused.
    expect(bookedAtFor(NOV_1PM)).toBe("2026-11-08T12:45:00-05:00");
    expect(bookedAtFor(NOV_405)).toBe("2026-11-08T15:50:00-05:00");
    expect(bookedAtFor(NOV_820)).toBe("2026-11-08T20:05:00-05:00");
  });

  it("round-trips to the real instant", () => {
    for (const g of [SUN_1PM, SUN_425, NOV_405, NOV_820, THU_835]) {
      expect(Date.parse(bookedAtFor(g))).toBe(gameWindow(g).startMs);
    }
  });
});

describe("gameWindow", () => {
  it("runs 3 hours from lane-open, i.e. kickoff + 2h45", () => {
    const w = gameWindow(SUN_1PM);
    expect(new Date(w.startMs).toISOString()).toBe("2026-09-13T16:45:00.000Z"); // 12:45 ET
    expect(new Date(w.endMs).toISOString()).toBe("2026-09-13T19:45:00.000Z"); // 3:45 ET
  });

  it("an 8:20 PM kickoff ends 11:05 PM, inside the midnight close", () => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(gameWindow(NOV_820).endMs));
    expect(parts).toBe("11:05 PM");
  });
});

describe("windowsOverlap — the reason 180 minutes was chosen", () => {
  it("the Sunday early and late slates do NOT overlap, so a block turns over", () => {
    // 12:45-15:45 then 15:50-18:50. Five minutes of clearance.
    expect(windowsOverlap(NOV_1PM, NOV_405)).toBe(false);
    expect(windowsOverlap(SUN_1PM, SUN_425)).toBe(false);
  });

  it("4:05 and 4:25 DO overlap — two late games take both blocks", () => {
    expect(windowsOverlap(NOV_405, NOV_425)).toBe(true);
  });

  it("the night game is clear of the late slate", () => {
    expect(windowsOverlap(NOV_425, NOV_820)).toBe(false);
  });

  it("is symmetric, and a game overlaps itself", () => {
    expect(windowsOverlap(NOV_425, NOV_405)).toBe(windowsOverlap(NOV_405, NOV_425));
    expect(windowsOverlap(SUN_1PM, SUN_1PM)).toBe(true);
  });

  it("windows that merely touch end-to-start do not overlap", () => {
    const a = game({ id: "a", kickoffIso: "2026-09-13T17:00:00Z" }); // opens 12:45, ends 15:45
    const b = game({ id: "b", kickoffIso: "2026-09-13T20:00:00Z" }); // opens 15:45
    expect(gameWindow(a).endMs).toBe(gameWindow(b).startMs);
    expect(windowsOverlap(a, b)).toBe(false);
  });
});

describe("windowFitsHours", () => {
  it("rejects the 9:30 AM London game — lanes would open before the doors", () => {
    // ~5 of these a season. They must never render as bookable.
    expect(windowFitsHours(NOV_930AM, WEEKDAY_HOURS)).toBe("before-open");
  });

  it("accepts every ordinary Sunday slot", () => {
    for (const g of [NOV_1PM, NOV_405, NOV_425, NOV_820]) {
      expect(windowFitsHours(g, WEEKDAY_HOURS)).toBeNull();
    }
  });

  it("accepts Thursday Night Football at 8:35", () => {
    expect(windowFitsHours(THU_835, WEEKDAY_HOURS)).toBeNull();
  });

  it("rejects a window running past close, and the weekend 2 AM close saves it", () => {
    const lateSat = game({ id: "sat", dateEt: "2026-11-07", kickoffIso: "2026-11-08T04:15:00Z" });
    // 11:15 PM ET Saturday → opens 11:00 PM, ends 2:00 AM.
    expect(windowFitsHours(lateSat, WEEKEND_HOURS)).toBeNull();
    expect(windowFitsHours(lateSat, WEEKDAY_HOURS)).toBe("after-close");
  });
});

describe("gameMatchesBookedAt — the server's anti-spoof check", () => {
  it("accepts the exact lane-open instant", () => {
    expect(gameMatchesBookedAt(SUN_1PM, bookedAtFor(SUN_1PM))).toBe(true);
  });

  it("accepts the same instant written with a different offset", () => {
    // Compared as instants, not strings — a UTC-rendered bookedAt is still valid.
    expect(gameMatchesBookedAt(SUN_1PM, "2026-09-13T16:45:00.000Z")).toBe(true);
  });

  it("rejects one minute either side", () => {
    expect(gameMatchesBookedAt(SUN_1PM, "2026-09-13T12:44:00-04:00")).toBe(false);
    expect(gameMatchesBookedAt(SUN_1PM, "2026-09-13T12:46:00-04:00")).toBe(false);
  });

  it("rejects kickoff itself — the booking starts 15 minutes earlier", () => {
    expect(gameMatchesBookedAt(SUN_1PM, SUN_1PM.kickoffIso)).toBe(false);
  });

  it("rejects another game's window and unparseable junk", () => {
    expect(gameMatchesBookedAt(SUN_1PM, bookedAtFor(SUN_425))).toBe(false);
    expect(gameMatchesBookedAt(SUN_1PM, "not-a-date")).toBe(false);
    expect(gameMatchesBookedAt(SUN_1PM, "")).toBe(false);
  });

  it("rejects an EDT-shaped string for a November game (the DST trap)", () => {
    // 20:05-04:00 is an hour earlier than 20:05-05:00. A month-approximated
    // client would send exactly this.
    expect(gameMatchesBookedAt(NOV_820, "2026-11-08T20:05:00-04:00")).toBe(false);
    expect(gameMatchesBookedAt(NOV_820, "2026-11-08T20:05:00-05:00")).toBe(true);
  });
});

describe("upcomingFrom", () => {
  const OPEN = gameWindow(SUN_1PM).startMs;

  it("keeps a game comfortably ahead of lane-open", () => {
    expect(upcomingFrom([SUN_1PM], OPEN - 60 * 60_000).map((g) => g.id)).toEqual(["g1"]);
  });

  it("drops it inside the 15-minute cutoff and after lane-open", () => {
    expect(upcomingFrom([SUN_1PM], OPEN - 10 * 60_000)).toEqual([]);
    expect(upcomingFrom([SUN_1PM], OPEN + 1)).toEqual([]);
  });

  it("drops it exactly ON the cutoff — the boundary is not bookable", () => {
    expect(upcomingFrom([SUN_1PM], OPEN - 15 * 60_000)).toEqual([]);
  });
});

describe("sellableGames", () => {
  it("filters the London game out while keeping the rest of the slate", () => {
    const all = [NOV_930AM, NOV_1PM, NOV_405, NOV_425, NOV_820];
    const out = sellableGames({
      games: all,
      nowMs: Date.parse("2026-11-01T12:00:00Z"),
      hoursForDate: () => WEEKDAY_HOURS,
    });
    expect(out.map((g) => g.id)).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("asks for hours using the date the LANES open, not the kickoff date", () => {
    // The 8:20 PM game kicks off on Nov 9 UTC but its lanes open Nov 8 ET.
    const seen: string[] = [];
    sellableGames({
      games: [NOV_820],
      nowMs: Date.parse("2026-11-01T12:00:00Z"),
      hoursForDate: (d) => {
        seen.push(d);
        return WEEKDAY_HOURS;
      },
    });
    expect(seen).toEqual(["2026-11-08"]);
    expect(windowStartDateEt(NOV_820)).toBe("2026-11-08");
  });
});

describe("labels and grouping", () => {
  it("reads away at home, text only", () => {
    expect(gameLabel({ awayTeam: "Chiefs", homeTeam: "Bills" })).toBe("Chiefs at Bills");
  });

  it("dates come back unique and sorted", () => {
    expect(datesOf([NOV_820, SUN_1PM, NOV_1PM, SUN_425])).toEqual(["2026-09-13", "2026-11-08"]);
  });
});
