import { describe, expect, it } from "vitest";
import { departedSeats, isNewerFrame, seatSnapshots } from "./roster-seats";

/**
 * RACE 58599144, verbatim from `kart:events:queue` (2026-08-16 21:51-21:53 ET).
 * Its roster read 7→6→3→7→3→7→3 inside ninety seconds. The four drivers that
 * came and went have NO `Product`; the three that stayed all carry
 * `Product: "Intermediate Race Red"`. This fixture is the whole reason the
 * signal filters on Product.
 */
const SOLD = [
  {
    $type: "BcDriver",
    DriverId: 58973637,
    Product: "Intermediate Race Red",
    ProductId: 11937032,
    PersonId: 11775736,
    Alias: "Zach Adebayo",
  },
  {
    $type: "BcDriver",
    DriverId: 58973645,
    Product: "Intermediate Race Red",
    ProductId: 11937032,
    PersonId: 3468270,
    Alias: "Noah miller",
  },
  {
    $type: "BcDriver",
    DriverId: 58973646,
    Product: "Intermediate Race Red",
    ProductId: 11937032,
    PersonId: 63000000000307650,
    Alias: "Chris ferguson",
  },
];
/** The four provisional seats — no Product, no ProductId. */
const PROVISIONAL = [
  { $type: "BcDriver", DriverId: 58973656, PersonId: 58945848, Alias: "jamil velez" },
  { $type: "BcDriver", DriverId: 58973657, PersonId: 58945874, Alias: "alexander corchado" },
  { $type: "BcDriver", DriverId: 58973658, PersonId: 63000000002550360, Alias: "Miguel Espinal" },
  { $type: "BcDriver", DriverId: 58973659, PersonId: 63000000008616990, Alias: "Roberto Vera" },
];

const frame = (drivers: unknown[], recordVersion: number | string | null = 13431524620678000) => ({
  $type: "RaceAdvice",
  RaceId: 58599144,
  ResourceId: 11208660,
  ResourceName: "Red Track",
  Name: "57 - Red Intermediate",
  ...(recordVersion === null ? {} : { RecordVersion: recordVersion }),
  Drivers: drivers,
});

describe("seatSnapshots", () => {
  it("counts only the seats that carry a Product", () => {
    const [snap] = seatSnapshots(frame([...SOLD, ...PROVISIONAL]));
    expect(snap.sessionId).toBe("58599144");
    expect(snap.seatIds).toEqual(["58973637", "58973645", "58973646"]);
  });

  it("keeps RecordVersion as a STRING — 17 digits must never be parsed", () => {
    const [snap] = seatSnapshots(frame(SOLD, "13431524620678000"));
    expect(snap.recordVersion).toBe("13431524620678000");
    expect(typeof snap.recordVersion).toBe("string");
  });

  it("reads RaceStop as well as RaceAdvice", () => {
    const stop = { ...frame(SOLD), $type: "RaceStop", State: "Paused" };
    expect(seatSnapshots(stop)).toHaveLength(1);
  });

  it("ignores frames with no Drivers array at all", () => {
    const noDrivers = { $type: "RaceAdvice", RaceId: 58599144, RecordVersion: 1 };
    expect(seatSnapshots(noDrivers)).toEqual([]);
  });

  it("ignores everything that is not roster-bearing", () => {
    expect(seatSnapshots({ $type: "SpeedChange" })).toEqual([]);
    expect(seatSnapshots({ $type: "EnterTapNotification", SessionId: 1 })).toEqual([]);
    expect(seatSnapshots(null)).toEqual([]);
  });

  it("handles an array frame carrying several races", () => {
    const other = { ...frame(SOLD.slice(0, 1)), RaceId: 58599019 };
    const snaps = seatSnapshots([frame(SOLD), other]);
    expect(snaps.map((s) => s.sessionId)).toEqual(["58599144", "58599019"]);
  });
});

describe("departedSeats", () => {
  it("THE REAL CASE: the provisional four coming and going is NOT a departure", () => {
    // 7 drivers → 3 drivers, but the four that vanished had no Product. This
    // exact sequence is 58599144's flap, and it must produce nothing.
    const before = seatSnapshots(frame([...SOLD, ...PROVISIONAL]))[0];
    const after = seatSnapshots(frame(SOLD))[0];
    expect(departedSeats(before.seatIds, after.seatIds)).toEqual([]);
  });

  it("reports a sold seat that really left", () => {
    const before = seatSnapshots(frame(SOLD))[0];
    const after = seatSnapshots(frame(SOLD.slice(0, 2)))[0];
    expect(departedSeats(before.seatIds, after.seatIds)).toEqual(["58973646"]);
  });

  it("reports nothing for a heat that is only filling up", () => {
    const before = seatSnapshots(frame(SOLD.slice(0, 1)))[0];
    const after = seatSnapshots(frame(SOLD))[0];
    expect(departedSeats(before.seatIds, after.seatIds)).toEqual([]);
  });

  it("reports nothing when we had no previous set — a first sighting is not a loss", () => {
    expect(departedSeats([], ["58973637"])).toEqual([]);
  });
});

describe("isNewerFrame", () => {
  it("orders 17-digit versions correctly as strings", () => {
    expect(isNewerFrame("13431524620678000", "13431524620679000")).toBe(true);
    expect(isNewerFrame("13431524620679000", "13431524620678000")).toBe(false);
  });

  it("rejects a replay of the same version", () => {
    // A reconnect catch-up dump re-sends records verbatim, version and all.
    // Re-applying an older roster would invent a departure on the next frame.
    expect(isNewerFrame("13431524620678000", "13431524620678000")).toBe(false);
  });

  it("falls back to length for unequal-length decimals", () => {
    expect(isNewerFrame("999", "1000")).toBe(true);
    expect(isNewerFrame("1000", "999")).toBe(false);
  });

  it("treats a missing version as new rather than dropping the frame", () => {
    // Losing a real departure is worse than processing one twice, and
    // reprocessing is idempotent — the set is rewritten to the same value.
    expect(isNewerFrame(null, "1")).toBe(true);
    expect(isNewerFrame("1", null)).toBe(true);
  });
});
