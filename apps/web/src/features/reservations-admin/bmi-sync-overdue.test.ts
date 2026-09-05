import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOverdue,
  toneFor,
  stateLabel,
} from "~/components/features/reservations-admin/BmiSyncPanel";
import type { AdminSyncRow } from "./bmi-sync-view";

/**
 * LATE MUST MEAN OVERDUE, NOT MERELY OLD.
 *
 * The board judged every row by a flat 10-minute age. That is right for a row
 * waiting on a SYNC (those land in seconds) and wrong for one waiting on a
 * SCHEDULED EVENT: a `stamp-confirmation-state` row is created when the party
 * CHECKS IN and cannot land until they race.
 *
 * The fixture is the real 2026-09-05 case, not a tidy one — reservation
 * 63000000009563153, the Gant party of three, checked in 14:15 ET with all three
 * racers seated on the 15:12 heat. At 14:57 the board showed it amber and `late`
 * at 42 minutes old while the heat was still fifteen minutes away, and it was
 * read as a stuck queue.
 */
const gantRow = (over: Partial<AdminSyncRow> = {}): AdminSyncRow =>
  ({
    id: 5460,
    source: "queue",
    kind: "stamp-confirmation-state",
    status: "pending",
    barrier: "party-seated",
    barrierRef: "63000000009563154",
    reservationRef: "63000000009563153",
    attempts: 0,
    lastError: "barrier closed: 3/3 racer(s) not on the grid",
    createdAt: "2026-09-05T18:15:00.000Z",
    nextAttemptAt: "2026-09-05T18:57:00.000Z",
    giveUpAt: "2026-09-06T02:15:00.000Z",
    resolvedAt: null,
    ageMin: 42,
    waitingForAt: "2026-09-05T15:12",
    who: "Michelle Gant",
    center: "FastTrax",
    transport: "vercel-queue",
    ...over,
  }) as AdminSyncRow;

/** Freeze the clock at a real ET instant. 18:57Z = 14:57 ET (EDT). */
function at(utcIso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(utcIso));
}
afterEach(() => vi.useRealTimers());

describe("isOverdue", () => {
  it("is NOT overdue while the heat is still ahead — the live 2026-09-05 case", () => {
    at("2026-09-05T18:57:00.000Z"); // 14:57 ET, heat 15:12
    const r = gantRow();
    expect(r.ageMin).toBeGreaterThanOrEqual(10); // the old rule WOULD have fired
    expect(isOverdue(r)).toBe(false);
    expect(toneFor(r)).toBe("pending");
    expect(stateLabel(r)).toBe("waiting");
  });

  it("is still not overdue inside the grace — heats run 6-20 min behind", () => {
    at("2026-09-05T19:30:00.000Z"); // 15:30 ET, 18 min past a 15:12 heat
    expect(isOverdue(gantRow())).toBe(false);
  });

  it("IS overdue once the heat is well past — then it is the real fault", () => {
    at("2026-09-05T19:45:00.000Z"); // 15:45 ET, 33 min past
    const r = gantRow({ ageMin: 90 });
    expect(isOverdue(r)).toBe(true);
    expect(toneFor(r)).toBe("late");
    expect(stateLabel(r)).toBe("late");
  });

  it("falls back to plain age when the row has no scheduled moment", () => {
    at("2026-09-05T18:57:00.000Z");
    // A sync-barrier row (waiver push, membership) has no seats in its payload.
    const sync = gantRow({ waitingForAt: null, kind: "add-membership", ageMin: 12 });
    expect(isOverdue(sync)).toBe(true);
    expect(isOverdue({ ...sync, ageMin: 4 })).toBe(false);
  });

  it("treats a missing field the same as null, so an older row still works", () => {
    at("2026-09-05T18:57:00.000Z");
    const legacy = gantRow({ ageMin: 30 });
    delete (legacy as { waitingForAt?: string | null }).waitingForAt;
    expect(isOverdue(legacy)).toBe(true);
  });

  it("never calls a settled row late, whatever the clock says", () => {
    at("2026-09-06T12:00:00.000Z"); // long past everything
    for (const status of ["done", "dismissed", "lapsed", "cancelled"] as const) {
      const r = gantRow({ status, ageMin: 9999 });
      expect(toneFor(r)).not.toBe("late");
    }
    expect(toneFor(gantRow({ status: "parked" }))).toBe("parked");
  });
});
