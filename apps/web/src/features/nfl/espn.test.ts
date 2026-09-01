import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: () => {
    throw new Error("no DB in this test");
  },
  isDbConfigured: () => false,
}));

import { parseEspnEvent } from "./espn.server";
import { bookedAtFor, gameLabel } from "./schedule";

/**
 * Payload shapes are trimmed from a REAL response captured on 2026-08-25
 * (`?dates=20260913`). Invented shapes would not have caught that ESPN gives
 * kickoff in UTC while every other field the picker needs is ET-relative.
 */
const WEEK1_SUNDAY = {
  id: "401872925",
  date: "2026-09-13T17:00Z",
  week: { number: 1 },
  season: { year: 2026, type: 2 },
  competitions: [
    {
      competitors: [
        {
          homeAway: "away",
          team: {
            displayName: "Tampa Bay Buccaneers",
            shortDisplayName: "Buccaneers",
            abbreviation: "TB",
          },
        },
        {
          homeAway: "home",
          team: {
            displayName: "Cincinnati Bengals",
            shortDisplayName: "Bengals",
            abbreviation: "CIN",
          },
        },
      ],
      broadcasts: [{ names: ["FOX"] }],
    },
  ],
};

afterEach(() => {
  delete process.env.NFL_INCLUDE_PRESEASON;
});

describe("parseEspnEvent", () => {
  it("reads a real Week 1 Sunday event", () => {
    const g = parseEspnEvent(WEEK1_SUNDAY)!;
    expect(g.id).toBe("401872925");
    expect(g.kickoffIso).toBe("2026-09-13T17:00:00.000Z");
    expect(g.awayTeam).toBe("Buccaneers");
    expect(g.homeTeam).toBe("Bengals");
    expect(g.network).toBe("FOX");
    expect(g.week).toBe(1);
    expect(g.season).toBe(2026);
    expect(g.seasonType).toBe(2);
  });

  it("derives the ET date, not the UTC one", () => {
    // 2026-09-14T00:20Z is 8:20 PM ET on the 13th — a Sunday-night game must
    // group under Sunday, or the picker files it on the wrong day.
    const night = parseEspnEvent({ ...WEEK1_SUNDAY, id: "n", date: "2026-09-14T00:20Z" })!;
    expect(night.dateEt).toBe("2026-09-13");
    expect(parseEspnEvent(WEEK1_SUNDAY)!.dateEt).toBe("2026-09-13");
  });

  it("prefers the nickname — two full names do not fit a tile", () => {
    expect(gameLabel(parseEspnEvent(WEEK1_SUNDAY)!)).toBe("Buccaneers at Bengals");
  });

  it("falls back through displayName then abbreviation rather than dropping a game", () => {
    // Square-bracket delete so TS does not require the key to be optional on a
    // literal type — these payloads are untrusted upstream JSON either way.
    type Loose = { competitions: Array<{ competitors: Array<{ team: Record<string, unknown> }> }> };
    const noShort = structuredClone(WEEK1_SUNDAY) as unknown as Loose;
    delete noShort.competitions[0].competitors[0].team["shortDisplayName"];
    expect(parseEspnEvent(noShort)!.awayTeam).toBe("Tampa Bay Buccaneers");

    const abbrOnly = structuredClone(WEEK1_SUNDAY) as unknown as Loose;
    delete abbrOnly.competitions[0].competitors[0].team["shortDisplayName"];
    delete abbrOnly.competitions[0].competitors[0].team["displayName"];
    expect(parseEspnEvent(abbrOnly)!.awayTeam).toBe("TB");
  });

  it("handles a multi-network broadcast", () => {
    const g = parseEspnEvent({
      ...WEEK1_SUNDAY,
      competitions: [
        { ...WEEK1_SUNDAY.competitions[0], broadcasts: [{ names: ["NBC", "Peacock"] }] },
      ],
    })!;
    expect(g.network).toBe("NBC/Peacock");
  });

  it("tolerates a missing broadcast and a missing week", () => {
    const g = parseEspnEvent({
      ...WEEK1_SUNDAY,
      week: {},
      competitions: [{ ...WEEK1_SUNDAY.competitions[0], broadcasts: [] }],
    })!;
    expect(g.network).toBeNull();
    expect(g.week).toBeNull();
  });

  it("rejects junk instead of storing a half-game", () => {
    expect(parseEspnEvent({})).toBeNull();
    expect(parseEspnEvent({ id: "x" })).toBeNull();
    expect(parseEspnEvent({ id: "x", date: "not-a-date" })).toBeNull();
    // No competitors → no matchup to show.
    expect(parseEspnEvent({ id: "x", date: "2026-09-13T17:00Z", competitions: [{}] })).toBeNull();
    // Only one side.
    expect(
      parseEspnEvent({
        id: "x",
        date: "2026-09-13T17:00Z",
        competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "CIN" } }] }],
      }),
    ).toBeNull();
  });

  it("the parsed game feeds bookedAtFor cleanly — 15 min before, EDT", () => {
    expect(bookedAtFor(parseEspnEvent(WEEK1_SUNDAY)!)).toBe("2026-09-13T12:45:00-04:00");
  });

  it("carries seasonType through so preseason can be filtered", () => {
    const pre = parseEspnEvent({ ...WEEK1_SUNDAY, season: { year: 2026, type: 1 } })!;
    expect(pre.seasonType).toBe(1);
  });
});
