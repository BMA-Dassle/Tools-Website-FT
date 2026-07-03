import { describe, expect, it } from "vitest";
import { mapEspnEventsToOverrides, type EspnScoreboardEvent } from "./live-teams";

// qf-1 = 2026-07-09 4 PM ET = 2026-07-09T20:00Z (committed teams: null)
const QF1_UTC = "2026-07-09T20:00Z";

function event(
  date: string,
  home: string | undefined,
  away: string | undefined,
  order: "home-first" | "away-first" = "home-first",
): EspnScoreboardEvent {
  const h = { homeAway: "home", team: { displayName: home } };
  const a = { homeAway: "away", team: { displayName: away } };
  return {
    date,
    competitions: [{ competitors: order === "home-first" ? [h, a] : [a, h] }],
  };
}

describe("mapEspnEventsToOverrides", () => {
  it("fills a TBD fixture matched by exact kickoff instant, home first", () => {
    expect(mapEspnEventsToOverrides([event(QF1_UTC, "France", "Brazil")])).toEqual({
      "qf-1": "France vs Brazil",
    });
    // Competitor array order doesn't matter — homeAway does.
    expect(mapEspnEventsToOverrides([event(QF1_UTC, "France", "Brazil", "away-first")])).toEqual({
      "qf-1": "France vs Brazil",
    });
  });

  it("never touches fixtures with committed team names", () => {
    // r16-6 (USA vs Belgium) kickoff = 2026-07-07T00:00Z — committed, not null.
    expect(mapEspnEventsToOverrides([event("2026-07-07T00:00Z", "Wrong", "Teams")])).toEqual({});
  });

  it("skips unresolved bracket placeholders", () => {
    for (const [h, a] of [
      ["TBD", "Brazil"],
      ["France", "TBD"],
      ["Winner Match 89", "Brazil"],
      ["To Be Determined", "Brazil"],
    ]) {
      expect(mapEspnEventsToOverrides([event(QF1_UTC, h, a)])).toEqual({});
    }
  });

  it("ignores events that don't land exactly on a kickoff", () => {
    expect(mapEspnEventsToOverrides([event("2026-07-09T20:15Z", "France", "Brazil")])).toEqual({});
    expect(mapEspnEventsToOverrides([event("2026-07-08T20:00Z", "France", "Brazil")])).toEqual({});
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
    expect(mapEspnEventsToOverrides(junk)).toEqual({});
  });

  it("maps multiple resolved rounds in one pass", () => {
    const out = mapEspnEventsToOverrides([
      event(QF1_UTC, "France", "Brazil"),
      event("2026-07-10T19:00Z", "Spain", "Norway"), // qf-2: 3 PM ET 7/10
      event("2026-07-19T19:00Z", "TBD", "TBD"), // final unresolved
    ]);
    expect(out).toEqual({ "qf-1": "France vs Brazil", "qf-2": "Spain vs Norway" });
  });
});
