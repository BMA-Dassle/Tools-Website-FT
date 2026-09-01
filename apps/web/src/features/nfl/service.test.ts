import { describe, expect, it, afterEach } from "vitest";
import {
  NflReservationError,
  buildNflLineItems,
  gameStaffLabel,
  isNflBowlingItem,
  nflQamfBanner,
  nflQamfTitle,
  validateNflBooking,
  type NflExperienceItemLike,
} from "./service";
import { NFL_SLUGS, nflBandForDate, nflSlugForGame, type NflGame } from "./schedule";

const FM = 9172;
const NAPLES = 3148;
const HOURS = { open: 11, close: 24 }; // Sun-Thu
const WEEKEND_HOURS = { open: 11, close: 26 }; // Fri-Sat

function game(over: Partial<NflGame> & Pick<NflGame, "kickoffIso">): NflGame {
  return {
    id: "g1",
    dateEt: "2026-09-13",
    awayTeam: "Chiefs",
    homeTeam: "Bills",
    network: "CBS",
    week: 1,
    season: 2026,
    seasonType: 2,
    ...over,
  };
}

const SUN_1PM = game({ kickoffIso: "2026-09-13T17:00:00Z" }); // 1:00 PM ET, opens 12:45
const OPEN_MS = Date.parse("2026-09-13T16:45:00Z");
const WELL_BEFORE = OPEN_MS - 3 * 24 * 3600_000;
const LONDON = game({ id: "lon", kickoffIso: "2026-11-08T14:30:00Z" }); // 9:30 AM ET

afterEach(() => {
  delete process.env.NEXT_PUBLIC_NFL_VIP_ENABLED;
});

describe("validateNflBooking — the pre-charge guard", () => {
  const ok = {
    game: SUN_1PM,
    centerId: FM,
    bookedAt: "2026-09-13T12:45:00-04:00",
    hours: HOURS,
    nowMs: WELL_BEFORE,
  };

  it("accepts a real game at the exact lane-open instant", () => {
    expect(validateNflBooking(ok).id).toBe("g1");
  });

  it("accepts the same instant written as UTC — instants, not strings", () => {
    expect(validateNflBooking({ ...ok, bookedAt: "2026-09-13T16:45:00.000Z" }).id).toBe("g1");
  });

  it("refuses a center we do not sell, before complaining about anything else", () => {
    // Ordering matters: a stale session pointed at Naples should be told the
    // location is wrong, not handed a confusing time error.
    expect(() => validateNflBooking({ ...ok, centerId: NAPLES })).toThrow(NflReservationError);
    expect(() => validateNflBooking({ ...ok, centerId: NAPLES, bookedAt: "nonsense" })).toThrow(
      /location/i,
    );
  });

  it("refuses when the kill switch is thrown", () => {
    process.env.NEXT_PUBLIC_NFL_VIP_ENABLED = "false";
    expect(() => validateNflBooking(ok)).toThrow(/available at this location/i);
  });

  it("refuses a game that no longer resolves", () => {
    expect(() => validateNflBooking({ ...ok, game: null })).toThrow(/no longer on the schedule/i);
  });

  it("refuses a missing bookedAt", () => {
    expect(() => validateNflBooking({ ...ok, bookedAt: null })).toThrow(/needs a game/i);
  });

  it("refuses a time one minute off, and kickoff itself", () => {
    expect(() => validateNflBooking({ ...ok, bookedAt: "2026-09-13T12:46:00-04:00" })).toThrow(
      /15 minutes before kickoff/i,
    );
    expect(() => validateNflBooking({ ...ok, bookedAt: SUN_1PM.kickoffIso })).toThrow(
      /15 minutes before kickoff/i,
    );
  });

  it("refuses an EDT-shaped time for a November game — the DST spoof", () => {
    const nov = game({ id: "n", dateEt: "2026-11-08", kickoffIso: "2026-11-09T01:20:00Z" });
    const args = { ...ok, game: nov, nowMs: Date.parse("2026-11-01T12:00:00Z") };
    expect(() => validateNflBooking({ ...args, bookedAt: "2026-11-08T20:05:00-04:00" })).toThrow();
    expect(validateNflBooking({ ...args, bookedAt: "2026-11-08T20:05:00-05:00" }).id).toBe("n");
  });

  it("refuses the 9:30 AM London game — lanes would open before the doors", () => {
    expect(() =>
      validateNflBooking({
        ...ok,
        game: LONDON,
        bookedAt: "2026-11-08T09:15:00-05:00",
        nowMs: Date.parse("2026-11-01T12:00:00Z"),
      }),
    ).toThrow(/before we open/i);
  });

  it("refuses a window running past close, and the weekend close rescues it", () => {
    const lateSat = game({ id: "s", dateEt: "2026-11-07", kickoffIso: "2026-11-08T04:15:00Z" });
    const args = {
      ...ok,
      game: lateSat,
      bookedAt: "2026-11-07T23:00:00-05:00",
      nowMs: Date.parse("2026-11-01T12:00:00Z"),
    };
    expect(() => validateNflBooking({ ...args, hours: HOURS })).toThrow(/past closing/i);
    expect(validateNflBooking({ ...args, hours: WEEKEND_HOURS }).id).toBe("s");
  });

  it("refuses lanes that have already opened", () => {
    expect(() => validateNflBooking({ ...ok, nowMs: OPEN_MS + 1 })).toThrow(/already opened/i);
    expect(() => validateNflBooking({ ...ok, nowMs: OPEN_MS })).toThrow(/already opened/i);
  });

  it("caps a booking at one block, and says how many that is", () => {
    expect(validateNflBooking({ ...ok, laneCount: 4 }).id).toBe("g1");
    expect(() => validateNflBooking({ ...ok, laneCount: 5 })).toThrow(/up to 4 lanes/i);
  });

  it("does not care about laneCount when the caller omits it", () => {
    expect(validateNflBooking({ ...ok, laneCount: undefined }).id).toBe("g1");
  });
});

describe("isNflBowlingItem", () => {
  it("matches both band slugs and nothing else", () => {
    expect(isNflBowlingItem({ experienceSlug: NFL_SLUGS["fri-sun"] })).toBe(true);
    expect(isNflBowlingItem({ experienceSlug: NFL_SLUGS["mon-thur"] })).toBe(true);
    expect(isNflBowlingItem({ experienceSlug: "vip-fri-sun" })).toBe(false);
    expect(isNflBowlingItem({ experienceSlug: "world-cup-vip-fri-sun" })).toBe(false);
    expect(isNflBowlingItem({ experienceSlug: null })).toBe(false);
    expect(isNflBowlingItem({})).toBe(false);
  });
});

describe("day bands — which Conqueror offer sells the game", () => {
  it("Fri, Sat and Sun ride offer 174; Mon-Thu ride 175", () => {
    expect(nflBandForDate("2026-09-11")).toBe("fri-sun"); // Friday
    expect(nflBandForDate("2026-09-12")).toBe("fri-sun"); // Saturday
    expect(nflBandForDate("2026-09-13")).toBe("fri-sun"); // Sunday
    expect(nflBandForDate("2026-09-14")).toBe("mon-thur"); // Monday
    expect(nflBandForDate("2026-09-10")).toBe("mon-thur"); // Thursday
  });

  it("picks the slug off the day the LANES OPEN", () => {
    expect(nflSlugForGame(SUN_1PM)).toBe("nfl-vip-fri-sun");
    // Thursday Night Football, 8:35 PM ET Sep 10 → Mon-Thu band.
    expect(nflSlugForGame(game({ kickoffIso: "2026-09-11T00:35:00Z" }))).toBe("nfl-vip-mon-thur");
    // Sunday Night Football kicks off Sep 14 in UTC but opens Sunday ET.
    expect(nflSlugForGame(game({ kickoffIso: "2026-09-14T00:20:00Z" }))).toBe("nfl-vip-fri-sun");
  });
});

describe("buildNflLineItems", () => {
  const items: NflExperienceItemLike[] = [
    {
      squareProductId: 1,
      quantity: 1,
      label: "NFL Ticket on NeoVerse",
      priceCents: 11995,
      depositPct: 100,
      sortOrder: 0,
    },
    {
      squareProductId: 2,
      quantity: 1,
      label: "Game Day Pizza",
      priceCents: 0,
      depositPct: 100,
      sortOrder: 1,
    },
    {
      squareProductId: 3,
      quantity: 1,
      label: "Game Day Wings (10)",
      priceCents: 0,
      depositPct: 100,
      sortOrder: 2,
    },
  ];

  it("puts the matchup on the primary line — that string reaches the receipt", () => {
    const out = buildNflLineItems(items, 1, SUN_1PM);
    expect(out[0].label).toBe("NFL Ticket on NeoVerse — Chiefs at Bills");
    expect(out[1].label).toBe("Game Day Pizza");
  });

  it("scales EVERY item per lane — two lanes is two pizzas and two lots of wings", () => {
    const out = buildNflLineItems(items, 2, SUN_1PM);
    expect(out.map((l) => l.quantity)).toEqual([2, 2, 2]);
    // $119.95 a lane, so two lanes bills 2 x 11995.
    expect(out[0].priceCents).toBe(11995);
    expect(out[0].quantity * out[0].priceCents).toBe(23990);
  });

  it("treats 0 and negative lane counts as one lane rather than billing nothing", () => {
    expect(buildNflLineItems(items, 0, SUN_1PM)[0].quantity).toBe(1);
    expect(buildNflLineItems(items, -3, SUN_1PM)[0].quantity).toBe(1);
  });

  it("carries the catalog id through untouched", () => {
    const withCat = [{ ...items[0], squareCatalogObjectId: "CAT_NFL" }];
    expect(buildNflLineItems(withCat, 1, SUN_1PM)[0].squareCatalogObjectId).toBe("CAT_NFL");
  });
});

describe("staff-facing strings", () => {
  it("titles the Conqueror row so an NFL lane is obvious on the grid", () => {
    expect(nflQamfTitle("Eric Osborn", 6)).toBe("NFL Eric Osborn (6p)");
  });

  it("renders kickoff in ET, not UTC", () => {
    expect(gameStaffLabel(SUN_1PM)).toBe("Sun, Sep 13, 1:00 PM");
  });

  it("the notes banner names the game AND the block", () => {
    // The block is the one thing front desk cannot infer from the lane numbers:
    // it tells them which screen has to be showing what.
    expect(nflQamfBanner(SUN_1PM, "VIP A (5-8)")).toBe(
      "*** NFL TICKET: Chiefs at Bills — Sun, Sep 13, 1:00 PM kickoff on VIP A (5-8) (3-hr window, paid online) ***",
    );
  });
});
