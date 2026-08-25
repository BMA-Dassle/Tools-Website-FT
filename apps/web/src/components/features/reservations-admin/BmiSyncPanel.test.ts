import { describe, expect, it } from "vitest";
import { isSettled, stateLabel, toneFor } from "./BmiSyncPanel";
import type { AdminSyncRow } from "~/features/reservations-admin/bmi-sync-view";

/**
 * WHAT THE BOARD IS ALLOWED TO CLAIM about a row's state.
 *
 * These three functions are the whole vocabulary of the panel: the colour, the
 * word in the pill, and which filter tab a row falls into. They are tested
 * together because the bug they exist to prevent is a DISAGREEMENT between them
 * — a row that is grey but says "late", or that is counted as cleared but shown
 * under Waiting.
 */
const row = (over: Partial<AdminSyncRow>): AdminSyncRow => ({
  id: 1,
  source: "queue",
  kind: "stamp-confirmation-state",
  status: "pending",
  barrier: "party-ready",
  barrierRef: null,
  reservationRef: null,
  attempts: 0,
  lastError: null,
  createdAt: "2026-08-24T12:00:00.000Z",
  nextAttemptAt: "2026-08-24T12:00:30.000Z",
  giveUpAt: null,
  resolvedAt: null,
  ageMin: 0,
  who: null,
  transport: null,
  center: "FastTrax",
  ...over,
});

describe("the state a row is shown in", () => {
  it("says what is happening for the three states that always existed", () => {
    expect(stateLabel(row({ status: "pending", ageMin: 2 }))).toBe("waiting");
    expect(stateLabel(row({ status: "pending", ageMin: 40 }))).toBe("late");
    expect(stateLabel(row({ status: "parked" }))).toBe("gave up");
    expect(stateLabel(row({ status: "done" }))).toBe("landed");
    expect(toneFor(row({ status: "pending", ageMin: 2 }))).toBe("pending");
    expect(toneFor(row({ status: "pending", ageMin: 40 }))).toBe("late");
    expect(toneFor(row({ status: "parked" }))).toBe("parked");
    expect(toneFor(row({ status: "done" }))).toBe("done");
  });

  /**
   * THE TRAP THIS FILE EXISTS FOR. Both functions used to end in an AGE test, so
   * any status they did not name fell through to it. `cancelled` has been a legal
   * status the whole time, and a cancelled row — hours old by definition — painted
   * amber and read "late", i.e. it looked like outstanding work that nobody was
   * doing. A closed row must never do that, however old it is.
   */
  it("never lets a CLOSED row read as outstanding, however old it is", () => {
    for (const status of ["dismissed", "cancelled"]) {
      const old = row({ status, ageMin: 60 * 24 * 30 });
      expect(stateLabel(old)).not.toBe("late");
      expect(stateLabel(old)).not.toBe("waiting");
      expect(stateLabel(old)).not.toBe("gave up");
      expect(toneFor(old)).toBe("dismissed");
    }
    expect(stateLabel(row({ status: "dismissed", ageMin: 99_999 }))).toBe("set aside");
  });

  /** "Set aside" is not "landed" — nothing synced, a person just closed it. The
   *  colour has to agree: grey, never the green that means the work is done. */
  it("does not dress a dismissed row up as a success", () => {
    expect(toneFor(row({ status: "dismissed" }))).not.toBe("done");
    expect(stateLabel(row({ status: "dismissed" }))).not.toBe("landed");
  });

  it("sorts every closed row into Cleared, and nothing else there", () => {
    expect(isSettled(row({ status: "done" }))).toBe(true);
    expect(isSettled(row({ status: "dismissed" }))).toBe(true);
    expect(isSettled(row({ status: "cancelled" }))).toBe(true);
    expect(isSettled(row({ status: "parked" }))).toBe(false);
    expect(isSettled(row({ status: "pending", ageMin: 90 }))).toBe(false);
  });

  /** A row still on the Attention tab is exactly a row a person has not dealt
   *  with — that is what makes the badge mean something. */
  it("keeps a dismissed row off the Attention tab", () => {
    const parked = row({ status: "parked" });
    const dismissed = row({ status: "dismissed" });
    expect(toneFor(parked)).toBe("parked");
    expect(toneFor(dismissed)).not.toBe("parked");
  });

  /** An unknown status from a NEWER deploy (preview and production share the
   *  table) must degrade to the honest "still owed" reading rather than being
   *  silently treated as finished. */
  it("treats a status it has never heard of as outstanding, not as done", () => {
    const future = row({ status: "quarantined", ageMin: 45 });
    expect(isSettled(future)).toBe(false);
    expect(toneFor(future)).toBe("late");
  });
});
