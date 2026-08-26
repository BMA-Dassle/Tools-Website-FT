import { describe, expect, it } from "vitest";
import {
  mergePitRoster,
  orderPitRoster,
  pitCardName,
  pitRailState,
  pitArrivalNoticeVisible,
  PIT_ARRIVAL_NOTICE_MS,
  type FastPitRow,
  type PitParticipantRow,
  type PitRosterEntry,
} from "./pit-board";

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

describe("pitCardName", () => {
  it("names the locked place, from the row Pandora actually sends", () => {
    expect(pitCardName({ personId: null, firstName: null, lastName: null })).toBe("Locked Place");
  });

  it("a racer with a name keeps it", () => {
    expect(pitCardName({ personId: "1707260", firstName: "Adam", lastName: "ray" })).toBe(
      "Adam ray",
    );
  });

  it("a racer with NO name on file is still a Racer, not a locked place", () => {
    // Their card exists because a real participation does — blanking it would
    // hide somebody standing at the fence.
    expect(pitCardName({ personId: "19272377", firstName: null, lastName: null })).toBe("Racer");
  });
});

describe("mergePitRoster", () => {
  const fastRow = (over: Partial<FastPitRow> & { personId: string }): FastPitRow => ({
    participantId: over.personId,
    name: "Racer X",
    checkedIn: null,
    startPosition: null,
    ...over,
  });
  const slowEntry = (over: Partial<PitRosterEntry> & { personId: string }): PitRosterEntry => ({
    spot: 1,
    name: "Slow Name",
    participantId: over.personId,
    checkedIn: false,
    camera: null,
    cameraDue: false,
    birthday: false,
    vip: false,
    locked: false,
    backToBack: null,
    ...over,
  });

  it("the fast rows ARE the roster — a racer added at the desk appears before the 15s build", () => {
    const merged = mergePitRoster(
      [fastRow({ personId: "1", name: "Ava Chen" }), fastRow({ personId: "2", name: "New Guy" })],
      [slowEntry({ personId: "1", name: "Ava Chen", camera: "12" })],
    );
    expect(merged.map((e) => e.name)).toEqual(["Ava Chen", "New Guy"]);
    // The known racer keeps her slow joins; the new one carries no badges yet.
    expect(merged[0].camera).toBe("12");
    expect(merged[1].camera).toBeNull();
  });

  it("flips a ring the moment the fast roster says checked in", () => {
    const merged = mergePitRoster(
      [fastRow({ personId: "1", checkedIn: "2026-08-13T22:00:00.000Z" })],
      [slowEntry({ personId: "1", checkedIn: false })],
    );
    expect(merged[0].checkedIn).toBe(true);
  });

  it("applies a BMI re-grid from the fast rows", () => {
    const merged = mergePitRoster(
      [fastRow({ personId: "1", startPosition: 2 }), fastRow({ personId: "2", startPosition: 1 })],
      [slowEntry({ personId: "1", spot: 1 }), slowEntry({ personId: "2", spot: 2 })],
    );
    expect(merged.map((e) => [e.personId, e.spot])).toEqual([
      ["2", 1],
      ["1", 2],
    ]);
  });

  /**
   * LOCKED PLACES — a place staff held in BMI, which Pandora reports as a
   * participation with no person on it (see isLockedPlace). The board used to
   * name these "Racer" and hand them a silhouette, so three on a Mega grid read
   * as three blank spots (owner 2026-08-25).
   */
  it("names a locked place, instead of calling it a Racer", () => {
    const merged = mergePitRoster(
      [fastRow({ personId: "", name: "Locked Place", participantId: "59595194" })],
      [],
    );
    expect(merged[0]).toMatchObject({ name: "Locked Place", locked: true, personId: "" });
  });

  it("a locked place never inherits another one's badges through the empty id", () => {
    // Both carry personId "" — a plain Map lookup would hand the second card
    // the first's birthday, VIP and camera.
    const merged = mergePitRoster(
      [
        fastRow({ personId: "", participantId: "1", name: "Locked Place" }),
        fastRow({ personId: "", participantId: "2", name: "Locked Place" }),
      ],
      [slowEntry({ personId: "", birthday: true, vip: true, camera: "12" })],
    );
    expect(merged.every((e) => e.locked)).toBe(true);
    expect(merged.every((e) => !e.birthday && !e.vip && e.camera === null)).toBe(true);
  });

  it("a real racer is never marked locked", () => {
    const merged = mergePitRoster(
      [fastRow({ personId: "63000000003415010", name: "Eddie Corona" })],
      [],
    );
    expect(merged[0].locked).toBe(false);
  });

  it("keeps birthday and VIP joins from the slow build", () => {
    const merged = mergePitRoster(
      [fastRow({ personId: "9" })],
      [slowEntry({ personId: "9", birthday: true, vip: true, cameraDue: true })],
    );
    expect(merged[0]).toMatchObject({ birthday: true, vip: true, cameraDue: true });
  });

  /**
   * The back-to-back badge is a SLOW join like birthday and VIP — it costs three
   * schedule reads and cannot ride the 2s pulse. A racer the fast rows have never
   * seen carries no badge rather than a stale one.
   */
  it("carries the back-to-back badge through, and leaves a brand-new racer unbadged", () => {
    const merged = mergePitRoster(
      [fastRow({ personId: "1" }), fastRow({ personId: "2" })],
      [
        slowEntry({
          personId: "1",
          backToBack: { state: "arriving", session: 31, track: "red" },
        }),
      ],
    );
    expect(merged[0].backToBack).toEqual({ state: "arriving", session: 31, track: "red" });
    expect(merged[1].backToBack).toBeNull();
  });
});

/**
 * THE HOLD IS A SLOT NOW, NOT A COMPARISON (2026-08-15).
 *
 * These cases used to feed a finish stamp and a pitted stamp and assert how the
 * rail compared them. That comparison moved server-side into resolveLane, where
 * it belongs: a group sits in `pitIn` from their chequered flag until their post
 * announcement clears them, so the rail is handed one fact — is the pit occupied
 * — and cannot get the comparison wrong. The stamp-ordering rules those cases
 * pinned are now pinned in lane.server.test.ts, against the thing that actually
 * does the ordering.
 */
describe("pitRailState", () => {
  const base = {
    stagedInHolding: false,
    stagedStartedAtMs: null,
    pitInOccupied: false,
  };

  it("reports (info) while the group has not reached the seats", () => {
    expect(pitRailState(base)).toBe("info");
  });

  it("seats a holding group while the track is out racing", () => {
    expect(pitRailState({ ...base, stagedInHolding: true })).toBe("seat");
  });

  it("holds while a race is in the pit, even for a fully staged group", () => {
    expect(pitRailState({ ...base, stagedInHolding: true, pitInOccupied: true })).toBe("hold");
  });

  it("returns to seat once the pit empties", () => {
    expect(pitRailState({ ...base, stagedInHolding: true, pitInOccupied: false })).toBe("seat");
  });

  it("holds even for a group still in briefing — karts in the lane outrank everything", () => {
    expect(pitRailState({ ...base, pitInOccupied: true })).toBe("hold");
  });

  it("says racing once the staged session's own green flag is seen", () => {
    expect(
      pitRailState({
        ...base,
        stagedInHolding: true,
        stagedStartedAtMs: 9_000,
        // Even a live hold cannot outrank the flag: this group is GONE from the
        // seats, and the board is about to roll.
        pitInOccupied: true,
      }),
    ).toBe("racing");
  });
});

/* ── the arrival call ─────────────────────────────────────────────────── */

describe("pit arrival notice", () => {
  const at = 1_000_000;
  const show = (over: Partial<Parameters<typeof pitArrivalNoticeVisible>[0]> = {}) =>
    pitArrivalNoticeVisible({ holdingAtMs: at, nowMs: at, rail: "seat", ...over });

  it("fires the instant staff send a group to holding", () => {
    expect(show({ nowMs: at })).toBe(true);
  });

  it("stays up while they are still walking in, then ages out on its own", () => {
    expect(show({ nowMs: at + PIT_ARRIVAL_NOTICE_MS - 1 })).toBe(true);
    expect(show({ nowMs: at + PIT_ARRIVAL_NOTICE_MS })).toBe(false);
    expect(show({ nowMs: at + 10 * 60_000 })).toBe(false);
  });

  it("closes the window on a beat, so no flash is cut in half", () => {
    expect(PIT_ARRIVAL_NOTICE_MS % 1400).toBe(0);
  });

  it("SURVIVES the hold rail — the squares are where they wait for it to clear", () => {
    expect(show({ rail: "hold" })).toBe(true);
  });

  it("stops at the green flag, when they are in the karts", () => {
    expect(show({ rail: "racing" })).toBe(false);
  });

  it("never shows before they have been sent", () => {
    expect(show({ holdingAtMs: null })).toBe(false);
    expect(show({ rail: "info" })).toBe(false);
  });

  it("ignores a send stamp from the screen's future — that is clock skew", () => {
    // Otherwise a board whose clock is behind flashes for the whole skew.
    expect(show({ nowMs: at - 5_000 })).toBe(false);
  });
});
