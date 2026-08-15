import { describe, expect, it } from "vitest";
import {
  backToBackMap,
  groupJoining,
  nextTwoAfter,
  racesRunningNow,
  type B2BSession,
} from "./back-to-back";

/** Schedule times are the zoned-UTC strings Pandora sends. */
const s = (
  sessionId: string,
  track: string,
  heatNumber: number | null,
  hhmm: string,
  over: Partial<B2BSession> = {},
): B2BSession => ({
  sessionId,
  track,
  heatNumber,
  scheduledStart: `2026-08-14T${hhmm}:00.000Z`,
  ...over,
});

const DAY: B2BSession[] = [
  s("100", "blue", 30, "22:00", { actualStart: "x", actualEnd: "y" }), // done
  s("101", "red", 31, "22:10", { actualStart: "x" }), // RUNNING
  s("102", "blue", 32, "22:20"), // staged
  s("103", "red", 33, "22:30"),
  s("104", "blue", 34, "22:40"),
  s("105", "red", 35, "22:50"),
];

describe("racesRunningNow", () => {
  it("takes started-and-not-ended, on any track", () => {
    expect(racesRunningNow(DAY, "102").map((x) => x.sessionId)).toEqual(["101"]);
  });

  it("never counts the staged heat itself", () => {
    const mid = s("102", "blue", 32, "22:20", { actualStart: "x" });
    expect(racesRunningNow([mid], "102")).toEqual([]);
  });

  it("ignores a finished race", () => {
    expect(racesRunningNow(DAY, "102").some((x) => x.sessionId === "100")).toBe(false);
  });
});

describe("nextTwoAfter", () => {
  it("takes the two soonest after the staged heat, across tracks", () => {
    expect(nextTwoAfter(DAY, "102", DAY[2].scheduledStart).map((x) => x.sessionId)).toEqual([
      "103",
      "104",
    ]);
  });

  /**
   * THE CASE THE LESSON EXISTS FOR (tasks/lessons.md 2026-07-11). Staff insert a
   * session mid-day and Pandora gives it the DAY-MAX heat number. Anything that
   * reasoned "later heat = bigger number" would put heat 99 last; it is actually
   * the very next race.
   */
  it("orders by schedule, not by heat number, when a session is inserted", () => {
    const inserted = s("199", "blue", 99, "22:25"); // day-max number, next by clock
    const withInsert = [...DAY, inserted];
    expect(nextTwoAfter(withInsert, "102", DAY[2].scheduledStart).map((x) => x.sessionId)).toEqual([
      "199",
      "103",
    ]);
  });

  it("returns nothing when the staged heat is the last of the day", () => {
    expect(nextTwoAfter(DAY, "105", DAY[5].scheduledStart)).toEqual([]);
  });

  it("returns nothing for an unparseable anchor rather than guessing", () => {
    expect(nextTwoAfter(DAY, "102", "not-a-date")).toEqual([]);
  });
});

describe("backToBackMap", () => {
  const arriving = [{ session: DAY[1], members: ["p1", "p9"] }];
  const again = [
    { session: DAY[3], members: ["p2", "p1"] },
    { session: DAY[4], members: ["p3"] },
  ];

  it("flags a racer out on track as arriving, with where they came from", () => {
    const m = backToBackMap({ personIds: ["p1", "p2", "p3"], arriving, again });
    expect(m.get("p9")).toBeUndefined(); // not on this grid
    expect(m.get("p2")).toEqual({ state: "again", session: 33, track: "red" });
    expect(m.get("p3")).toEqual({ state: "again", session: 34, track: "blue" });
  });

  /** A racer can be both. Arriving changes what staff do right now, so it wins. */
  it("prefers arriving over again for a racer who is both", () => {
    const m = backToBackMap({ personIds: ["p1"], arriving, again });
    expect(m.get("p1")?.state).toBe("arriving");
  });

  it("keeps the SOONEST destination when a racer is on two later heats", () => {
    const m = backToBackMap({
      personIds: ["p2"],
      arriving: [],
      again: [
        { session: DAY[3], members: ["p2"] },
        { session: DAY[4], members: ["p2"] },
      ],
    });
    expect(m.get("p2")?.session).toBe(33);
  });

  it("is empty for an empty grid rather than doing the work", () => {
    expect(backToBackMap({ personIds: [], arriving, again }).size).toBe(0);
  });
});

describe("groupJoining", () => {
  const t = (session: number, track: string) => ({ state: "again", session, track }) as const;

  /** One returning race, several destinations — the row shape both boards render. */
  it("groups racers by the heat they are joining, in schedule order", () => {
    expect(
      groupJoining([
        { name: "Haley Brouwer", target: t(37, "blue") },
        { name: "Rodney Fort Vega", target: t(36, "red") },
        { name: "Antonia Cano", target: t(36, "red") },
      ]),
    ).toEqual([
      { session: 36, track: "red", names: ["Rodney Fort Vega", "Antonia Cano"] },
      { session: 37, track: "blue", names: ["Haley Brouwer"] },
    ]);
  });

  it("keeps the same heat number on two tracks apart", () => {
    const out = groupJoining([
      { name: "A", target: t(36, "red") },
      { name: "B", target: t(36, "blue") },
    ]);
    expect(out).toHaveLength(2);
  });

  /** `arriving` is not a destination — it never belongs in this list. */
  it("drops arriving racers", () => {
    expect(
      groupJoining([
        { name: "OnTrack", target: { state: "arriving", session: 31, track: "red" } },
        { name: "Later", target: t(36, "red") },
      ]),
    ).toEqual([{ session: 36, track: "red", names: ["Later"] }]);
  });

  it("is empty when nobody races again", () => {
    expect(groupJoining([])).toEqual([]);
  });
});
