import { describe, expect, it } from "vitest";
import { nyWallClockKey } from "@/lib/bmi-sync-barriers";

/**
 * A GATE THAT CANNOT YET OPEN MUST NOT READ LIKE A FAULT.
 *
 * `partySeatedBarrier` itself needs Pandora (sessions + participants per heat),
 * so the branch worth pinning without a live vendor is the DECISION: given the
 * heats a row is waiting on and the current wall clock, is this row early or is
 * it late? That comparison is pure string work on naive ET keys, and getting it
 * wrong is what made row #5460 read as a stuck queue on 2026-09-05 while its
 * heat was still half an hour away.
 */

/** Mirrors the branch in partySeatedBarrier. */
function isEarly(heatKeys: string[], nowKey: string): boolean {
  const earliest = [...heatKeys].sort((a, b) => a.localeCompare(b))[0];
  return !!earliest && earliest > nowKey;
}

function minutesOut(earliest: string, nowKey: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${earliest}:00Z`) - Date.parse(`${nowKey}:00Z`)) / 60000),
  );
}

describe("early vs late, on naive ET keys", () => {
  // The live row: checked in 14:15, heat 15:12, observed 14:41.
  const HEAT = "2026-09-05T15:12";

  it("is EARLY while the heat is still ahead — the #5460 case", () => {
    expect(isEarly([HEAT], "2026-09-05T14:41")).toBe(true);
    expect(minutesOut(HEAT, "2026-09-05T14:41")).toBe(31);
  });

  it("is LATE once the heat has passed — then it really is the fault", () => {
    expect(isEarly([HEAT], "2026-09-05T15:20")).toBe(false);
  });

  it("is LATE exactly on the minute, never early", () => {
    // `>` not `>=`: at the heat's own minute the racers should be on the grid.
    expect(isEarly([HEAT], HEAT)).toBe(false);
  });

  it("judges by the EARLIEST heat, so a later one cannot mask an overdue first", () => {
    const starter = "2026-09-05T14:00";
    const intermediate = "2026-09-05T17:00";
    // 14:30 — the starter is overdue even though the intermediate is hours out.
    expect(isEarly([intermediate, starter], "2026-09-05T14:30")).toBe(false);
    // 13:30 — both still ahead.
    expect(isEarly([intermediate, starter], "2026-09-05T13:30")).toBe(true);
  });

  it("string comparison is safe across midnight and month ends", () => {
    // Zero-padded ISO-ish keys sort lexicographically the same as they do in time,
    // which is the only reason `>` is legitimate here.
    expect(isEarly(["2026-10-01T09:00"], "2026-09-30T23:50")).toBe(true);
    expect(isEarly(["2026-09-30T23:50"], "2026-10-01T09:00")).toBe(false);
    expect(isEarly(["2026-09-06T00:05"], "2026-09-05T23:55")).toBe(true);
  });
});

describe("nyWallClockKey", () => {
  it("renders a UTC instant as the naive ET key the seat side speaks", () => {
    // 2026-09-05 18:41Z is 14:41 ET (EDT, UTC-4) — the moment #5460 was read.
    expect(nyWallClockKey("2026-09-05T18:41:00.000Z")).toBe("2026-09-05T14:41");
  });

  it("handles EST (UTC-5) as well as EDT", () => {
    expect(nyWallClockKey("2026-01-15T18:41:00.000Z")).toBe("2026-01-15T13:41");
  });

  it("produces keys that compare correctly against heat keys", () => {
    const now = nyWallClockKey("2026-09-05T18:41:00.000Z");
    expect(isEarly(["2026-09-05T15:12"], now)).toBe(true);
    expect(isEarly(["2026-09-05T14:00"], now)).toBe(false);
  });
});
