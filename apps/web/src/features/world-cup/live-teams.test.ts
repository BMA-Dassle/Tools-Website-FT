import { describe, expect, it } from "vitest";
import { applyMatchup, mapEspnEvents, type EspnScoreboardEvent } from "./live-teams";
import { WORLD_CUP_FIXTURES } from "./fixtures";

// qf-1 = 2026-07-09 4 PM ET = 2026-07-09T20:00Z (committed teams: null)
const QF1_UTC = "2026-07-09T20:00Z";
const FLAG = (c: string) => `https://a.espncdn.com/i/teamlogos/countries/500/${c}.png`;

function event(
  date: string,
  home: string | undefined,
  away: string | undefined,
  opts: { order?: "home-first" | "away-first"; homeLogo?: string; awayLogo?: string } = {},
): EspnScoreboardEvent {
  const h = { homeAway: "home", team: { displayName: home, logo: opts.homeLogo } };
  const a = { homeAway: "away", team: { displayName: away, logo: opts.awayLogo } };
  return {
    date,
    competitions: [{ competitors: opts.order === "away-first" ? [a, h] : [h, a] }],
  };
}

describe("mapEspnEvents", () => {
  it("maps a fixture by exact kickoff instant with label + flags, home first", () => {
    const out = mapEspnEvents([
      event(QF1_UTC, "France", "Brazil", { homeLogo: FLAG("fra"), awayLogo: FLAG("bra") }),
    ]);
    expect(out["qf-1"]).toEqual({
      label: "France vs Brazil",
      home: { name: "France", logo: FLAG("fra") },
      away: { name: "Brazil", logo: FLAG("bra") },
    });
    // Competitor array order doesn't matter — homeAway does.
    expect(
      mapEspnEvents([event(QF1_UTC, "France", "Brazil", { order: "away-first" })])["qf-1"],
    ).toMatchObject({ label: "France vs Brazil" });
  });

  it("drops flag URLs not served by ESPN's CDN", () => {
    const out = mapEspnEvents([
      event(QF1_UTC, "France", "Brazil", {
        homeLogo: "https://evil.example.com/x.png",
        awayLogo: FLAG("bra"),
      }),
    ]);
    expect(out["qf-1"].home.logo).toBeNull();
    expect(out["qf-1"].away.logo).toBe(FLAG("bra"));
  });

  it("matches committed-teams fixtures too (flags attach; label handled by applyMatchup)", () => {
    // r16-6 (USA vs Belgium, committed) kickoff = 2026-07-07T00:00Z.
    const out = mapEspnEvents([
      event("2026-07-07T00:00Z", "United States", "Belgium", { homeLogo: FLAG("usa") }),
    ]);
    expect(out["r16-6"]).toMatchObject({ home: { name: "United States", logo: FLAG("usa") } });
  });

  it("skips unresolved bracket placeholders", () => {
    for (const [h, a] of [
      ["TBD", "Brazil"],
      ["France", "TBD"],
      ["Winner Match 89", "Brazil"],
      ["To Be Determined", "Brazil"],
    ]) {
      expect(mapEspnEvents([event(QF1_UTC, h, a)])).toEqual({});
    }
  });

  it("ignores events that don't land exactly on a kickoff", () => {
    expect(mapEspnEvents([event("2026-07-09T20:15Z", "France", "Brazil")])).toEqual({});
    expect(mapEspnEvents([event("2026-07-08T20:00Z", "France", "Brazil")])).toEqual({});
  });

  it("survives malformed feed shapes", () => {
    const junk: EspnScoreboardEvent[] = [
      {},
      { date: "not-a-date" },
      { date: QF1_UTC }, // no competitions
      { date: QF1_UTC, competitions: [{ competitors: [{ team: { displayName: "Solo" } }] }] },
      event(QF1_UTC, "", "Brazil"),
      event(QF1_UTC, "Brazil", "Brazil"), // degenerate duplicate
    ];
    expect(mapEspnEvents(junk)).toEqual({});
  });
});

describe("applyMatchup", () => {
  const matchup = {
    label: "Wrong vs Label",
    home: { name: "United States", logo: FLAG("usa") },
    away: { name: "Belgium", logo: FLAG("bel") },
  };

  it("never overrides a committed teams string, but attaches flags", () => {
    const committed = WORLD_CUP_FIXTURES.find((f) => f.id === "r16-6")!;
    const out = applyMatchup(committed, matchup);
    expect(out.teams).toBe(committed.teams); // owner-controlled label wins
    expect(out.home).toEqual(matchup.home);
    expect(out.away).toEqual(matchup.away);
  });

  it("fills a null teams label and attaches flags", () => {
    const tbd = WORLD_CUP_FIXTURES.find((f) => f.id === "qf-1")!;
    const out = applyMatchup(tbd, matchup);
    expect(out.teams).toBe("Wrong vs Label");
    expect(out.away).toEqual(matchup.away);
  });

  it("is a no-op without a matchup", () => {
    const tbd = WORLD_CUP_FIXTURES.find((f) => f.id === "qf-1")!;
    expect(applyMatchup(tbd, undefined)).toBe(tbd);
  });
});
