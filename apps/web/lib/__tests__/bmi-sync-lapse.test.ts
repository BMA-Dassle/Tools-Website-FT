import { describe, expect, it } from "vitest";
import { lapseVerdict, lastHeatMs, STAMP_LAPSE_GRACE_MIN } from "@/lib/bmi-sync-lapse";
import type { SyncQueueRow } from "@/lib/bmi-sync-queue";

/**
 * WHEN A FOLLOWUP STOPS BEING WORTH DOING.
 *
 * The fixture is the ugly real case, not a tidy one: reservation 63000000009253076,
 * checked in at 19:17 ET on 2026-08-23 with four racers bound to the 19:12 heat.
 * They all raced — at 19:36, because staff moved them — so the stamp's gate never
 * opened and the row parked at its 8-hour deadline as a work order nobody needed.
 */
const row = (over: Partial<SyncQueueRow> = {}): SyncQueueRow =>
  ({
    id: 3271,
    kind: "stamp-confirmation-state",
    idempotencyKey: "state-stamp:63000000009253076:2026-08-23",
    barrier: "party-seated",
    barrierRef: "63000000009253076",
    locationId: "LAB52GY480CJF",
    reservationRef: "63000000009253076",
    payload: {
      officeProjectId: "63000000009253076",
      personIds: ["63000000009253080", "63000000009262505"],
      seats: [
        { personId: "63000000009253080", heatStart: "2026-08-23T19:12:00" },
        { personId: "63000000009262505", heatStart: "2026-08-23T19:12:00" },
      ],
    },
    attempts: 0,
    nextAttemptAt: "2026-08-23T23:20:00.000Z",
    giveUpAt: "2026-08-24T07:17:00.000Z",
    status: "pending",
    lastError: null,
    createdAt: "2026-08-23T23:17:00.000Z",
    updatedAt: "2026-08-23T23:17:00.000Z",
    resolvedAt: null,
    pushTransport: "vercel-queue",
    ...over,
  }) as SyncQueueRow;

/** 19:12 ET on 2026-08-23 is 23:12 UTC — EDT, so UTC-4. */
const HEAT_MS = Date.parse("2026-08-23T23:12:00.000Z");

describe("lastHeatMs", () => {
  it("reads a naive center-local heat time as the real instant it names", () => {
    expect(lastHeatMs(row())).toBe(HEAT_MS);
  });

  it("takes the LAST heat when a party holds several", () => {
    const r = row({
      payload: {
        seats: [
          { personId: "a", heatStart: "2026-08-23T19:12:00" },
          { personId: "a", heatStart: "2026-08-23T21:36:00" },
          { personId: "b", heatStart: "2026-08-23T20:00:00" },
        ],
      },
    });
    expect(lastHeatMs(r)).toBe(Date.parse("2026-08-24T01:36:00.000Z"));
  });

  /** ET is not a fixed offset. A January heat is UTC-5, an August one UTC-4;
   *  a hardcoded offset would silently move every winter row by an hour. */
  it("uses the offset in force on the DAY, not a fixed one", () => {
    const winter = row({
      payload: { seats: [{ personId: "a", heatStart: "2026-01-15T19:12:00" }] },
    });
    expect(lastHeatMs(winter)).toBe(Date.parse("2026-01-16T00:12:00.000Z"));
  });

  it("has no opinion when the row names no heats", () => {
    expect(lastHeatMs(row({ payload: { personIds: ["a"] } }))).toBeNull();
    expect(lastHeatMs(row({ payload: { seats: [] } }))).toBeNull();
    expect(lastHeatMs(row({ payload: { seats: [{ personId: "a" }] } }))).toBeNull();
  });
});

describe("lapseVerdict", () => {
  it("keeps waiting while the heat is still ahead", () => {
    expect(lapseVerdict(row(), HEAT_MS - 30 * 60_000)).toBeNull();
  });

  /** The grace exists so a racer seated late still gets the stamp — the whole
   *  point is that the gate is generous, not that it is punctual. */
  it("keeps waiting through the grace period after the heat", () => {
    expect(lapseVerdict(row(), HEAT_MS + 1)).toBeNull();
    expect(lapseVerdict(row(), HEAT_MS + (STAMP_LAPSE_GRACE_MIN - 1) * 60_000)).toBeNull();
  });

  it("writes the row off once the grace has passed, and says why", () => {
    const verdict = lapseVerdict(row(), HEAT_MS + 4 * 3_600_000);
    expect(verdict).toBeTruthy();
    expect(verdict).toContain("4h ago");
    // The message has to read as "no longer worth doing", never as a fault.
    expect(verdict).toContain("nothing left to say");
  });

  /**
   * ONLY THE STAMP LAPSES. A waiver, a licence and a repaired birthdate are all
   * exactly as valuable tomorrow as today — writing one off because the day
   * ended would quietly discard real guest work.
   */
  it("never writes off work that is still worth landing later", () => {
    const late = HEAT_MS + 24 * 3_600_000;
    for (const kind of [
      "push-waiver-signature",
      "add-membership",
      "repair-person-details",
      "attach-project-person",
    ] as const) {
      expect(lapseVerdict(row({ kind }), late)).toBeNull();
    }
  });

  /** A parked row has already been raised with a human. Relabelling it behind
   *  their back takes a job off someone's list without telling them. */
  it("leaves a row alone once it is no longer pending", () => {
    const late = HEAT_MS + 24 * 3_600_000;
    for (const status of ["parked", "done", "dismissed", "lapsed"] as const) {
      expect(lapseVerdict(row({ status }), late)).toBeNull();
    }
  });

  /** A stamp with no heats is gated on the party being ready, not on a moment —
   *  it has no deadline to miss, so it must run its normal course. */
  it("does not write off a row that names no heat at all", () => {
    const noSeats = row({ payload: { personIds: ["a"], seats: [] } });
    expect(lapseVerdict(noSeats, HEAT_MS + 48 * 3_600_000)).toBeNull();
  });
});
