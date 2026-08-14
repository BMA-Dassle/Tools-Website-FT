import { describe, expect, it } from "vitest";
import { orderPitRoster, pitRailState, type PitParticipantRow } from "./pit-board";

const row = (
  participantId: string,
  checkedIn: string | null,
  firstName = "R",
): PitParticipantRow => ({
  participantId,
  personId: `9${participantId}`,
  firstName,
  checkedIn,
});

const gridRow = (
  participantId: string,
  startPosition: number,
  checkedIn: string | null = null,
): PitParticipantRow => ({ ...row(participantId, checkedIn), raceInfo: { startPosition } });

const ids = (ordered: ReturnType<typeof orderPitRoster>) => ordered.map((r) => r.row.participantId);
const spots = (ordered: ReturnType<typeof orderPitRoster>) => ordered.map((r) => r.spot);

describe("orderPitRoster", () => {
  it("BMI's startPosition IS the spot — verbatim, whatever the check-in order says", () => {
    const roster = [
      gridRow("10", 3, "2026-08-13T22:00:00.000Z"), // checked in first, but BMI says 3
      gridRow("20", 1, null), // a no-show BMI has at the front — the board mirrors, never reinterprets
      gridRow("30", 2, "2026-08-13T22:05:00.000Z"),
    ];
    const ordered = orderPitRoster(roster);
    expect(ids(ordered)).toEqual(["20", "30", "10"]);
    expect(spots(ordered)).toEqual([1, 2, 3]);
  });

  it("keeps BMI's numbers even with gaps — a spot label is BMI's, not an index", () => {
    const roster = [gridRow("1", 5), gridRow("2", 2)];
    expect(spots(orderPitRoster(roster))).toEqual([2, 5]);
  });

  it("numbers ungridded rows past the highest real spot, never reusing one", () => {
    const roster = [
      gridRow("1", 2),
      gridRow("2", 4),
      row("3", "2026-08-13T22:00:00.000Z"), // BMI has not placed these two yet
      row("4", null),
    ];
    const ordered = orderPitRoster(roster);
    expect(ids(ordered)).toEqual(["1", "2", "3", "4"]);
    expect(spots(ordered)).toEqual([2, 4, 5, 6]);
  });

  it("falls back to check-in order with no-shows at the tail when no grid exists", () => {
    const roster = [
      row("30", null),
      row("10", "2026-08-13T22:05:00.000Z"),
      row("20", null),
      row("40", "2026-08-13T22:01:00.000Z"),
    ];
    const ordered = orderPitRoster(roster);
    expect(ids(ordered)).toEqual(["40", "10", "20", "30"]);
    expect(spots(ordered)).toEqual([1, 2, 3, 4]);
  });

  it("breaks a group check-in's identical stamps by participantId, so spots never reshuffle", () => {
    // Staff checking a party in as one action stamps every racer the same
    // millisecond (observed live 2026-08-12).
    const stamp = "2026-08-13T22:00:00.000Z";
    const roster = [row("7", stamp), row("2", stamp), row("11", stamp)];
    expect(ids(orderPitRoster(roster))).toEqual(["2", "7", "11"]);
  });

  it("is deterministic whatever order the payload arrives in", () => {
    const a = [row("3", null), row("1", "2026-08-13T22:00:01.000Z"), row("2", null)];
    const b = [a[2], a[0], a[1]];
    expect(ids(orderPitRoster(a))).toEqual(ids(orderPitRoster(b)));
  });

  it("orders participantId numerically, not lexically", () => {
    const roster = [row("10", null), row("9", null)];
    expect(ids(orderPitRoster(roster))).toEqual(["9", "10"]);
  });

  it("ignores a malformed startPosition rather than gridding on garbage", () => {
    const roster: PitParticipantRow[] = [
      { ...row("1", null), raceInfo: { startPosition: 0 } },
      { ...row("2", "2026-08-13T22:00:00.000Z"), raceInfo: null },
    ];
    const ordered = orderPitRoster(roster);
    // Neither row is gridded — the checked-in racer takes the front slot.
    expect(ids(ordered)).toEqual(["2", "1"]);
    expect(spots(ordered)).toEqual([1, 2]);
  });

  it("treats a bare `true` check-in flag as checked in, with no stamp to order by", () => {
    const roster: PitParticipantRow[] = [
      { participantId: "5", checkedIn: true },
      row("1", "2026-08-13T22:00:00.000Z"),
      row("9", null),
    ];
    const ordered = orderPitRoster(roster);
    // The stamped racer sorts ahead of the stampless flag; the no-show stays last.
    expect(ids(ordered)).toEqual(["1", "5", "9"]);
  });
});

describe("pitRailState", () => {
  const base = {
    stagedInHolding: false,
    stagedStartedAtMs: null,
    racingFinishedAtMs: null,
    pittedAtMs: null,
  };

  it("reports (info) while the group has not reached the seats", () => {
    expect(pitRailState(base)).toBe("info");
  });

  it("seats a holding group while the track is out racing", () => {
    expect(pitRailState({ ...base, stagedInHolding: true })).toBe("seat");
  });

  it("holds the moment a race finishes, even for a fully staged group", () => {
    expect(pitRailState({ ...base, stagedInHolding: true, racingFinishedAtMs: 1_000 })).toBe(
      "hold",
    );
  });

  it("keeps holding until the staff 'race returned' press — never a timer", () => {
    expect(
      pitRailState({
        ...base,
        stagedInHolding: true,
        racingFinishedAtMs: 5_000,
        // A pitted stamp OLDER than the finish is last cycle's — it must not
        // release this hold.
        pittedAtMs: 4_000,
      }),
    ).toBe("hold");
  });

  it("returns to seat once the lane is marked pitted", () => {
    expect(
      pitRailState({
        ...base,
        stagedInHolding: true,
        racingFinishedAtMs: 5_000,
        pittedAtMs: 6_000,
      }),
    ).toBe("seat");
  });

  it("holds even for a group still in briefing — karts in the lane outrank everything", () => {
    expect(pitRailState({ ...base, racingFinishedAtMs: 1_000 })).toBe("hold");
  });

  it("says racing once the staged session's own green flag is seen", () => {
    expect(
      pitRailState({
        ...base,
        stagedInHolding: true,
        stagedStartedAtMs: 9_000,
        // Even a live hold cannot outrank the flag: this group is GONE from the
        // seats, and the board is about to roll.
        racingFinishedAtMs: 5_000,
      }),
    ).toBe("racing");
  });
});
