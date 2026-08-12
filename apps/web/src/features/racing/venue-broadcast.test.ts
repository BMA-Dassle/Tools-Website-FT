import { describe, expect, it } from "vitest";
import {
  extractRaceFinishes,
  isActionableFinish,
  parseVenueHeatNumber,
  parseVenueLocalMs,
} from "./venue-broadcast";

/**
 * REAL WIRE RECORDS, verbatim from `kart:events:queue` (2026-08-12 survey) —
 * heat 67, the very race the welcome-back board showed that night, plus the
 * surrounding record types the extractor must ignore.
 */
const FINISH_67 = {
  $type: "RaceFinish",
  ActualEnd: "2026-08-11T23:05:35.4579",
  ActualStart: "2026-08-11T22:52:44.3747",
  DurationTime: "00:07:00",
  PendingFinishDurationTime: "00:05:00",
  RaceId: 57886016,
  ScheduledEnd: "2026-08-11T22:50:00",
  ScheduledStart: "2026-08-11T22:40:00",
  State: "Finished",
  RecordVersion: 13431092680947000,
  ResourceId: -1,
  ResourceName: "Mega Track",
  Name: "67 - Mega Starter",
};

/** Heat 65's unstamped push — State Finished, ActualEnd not yet written. This
 *  arrived 42 seconds BEFORE Pandora stamped the end; it is the fastest end
 *  signal the venue emits. */
const FINISH_65_UNSTAMPED = {
  $type: "RaceFinish",
  ActualStart: "2026-08-11T22:30:31.0734",
  RaceId: 57886014,
  State: "Finished",
  ResourceId: -1,
  ResourceName: "Mega Track",
  Name: "65 - Mega Starter",
};

const ADVICE_67 = {
  $type: "RaceAdvice",
  ActualStart: "2026-08-11T22:52:44.3747",
  RaceId: 57886016,
  State: "Started",
  ResourceId: -1,
  ResourceName: "Mega Track",
  Name: "67 - Mega Starter",
  Drivers: [{ $type: "BcDriver", PersonId: 52094165, Alias: "Franco bertochi" }],
};

// 8/11 was EDT: 23:05:35 ET = 03:05:35 UTC next day.
const HEAT_67_END_UTC = Date.parse("2026-08-12T03:05:35.457Z");

describe("extractRaceFinishes — against real broadcast records", () => {
  it("pulls RaceFinish out of a race-list array, ignoring advice/starts", () => {
    const finishes = extractRaceFinishes([ADVICE_67, FINISH_67, FINISH_65_UNSTAMPED]);
    expect(finishes).toHaveLength(2);
    const f = finishes[0];
    expect(f.raceId).toBe("57886016"); // STRING — Pandora session id space
    expect(f.heatNumber).toBe(67);
    expect(f.heatName).toBe("67 - Mega Starter");
    expect(f.track).toBe("mega");
    expect(f.state).toBe("Finished");
    // Venue wall-clock is ET without a zone — parsed DST-correctly.
    expect(Math.abs((f.actualEndMs as number) - HEAT_67_END_UTC)).toBeLessThan(1000);
  });

  it("handles the unstamped pending-finish record (no ActualEnd yet)", () => {
    const [f] = extractRaceFinishes([FINISH_65_UNSTAMPED]);
    expect(f.actualEndMs).toBeNull();
    expect(f.actualStartMs).not.toBeNull();
    expect(f.state).toBe("Finished");
  });

  it("survives junk without throwing", () => {
    expect(extractRaceFinishes(null)).toEqual([]);
    expect(extractRaceFinishes("keep-alive")).toEqual([]);
    expect(extractRaceFinishes([{ $type: "SpeedChange" }, null, 42])).toEqual([]);
    expect(extractRaceFinishes({ $type: "RaceFinish" })).toEqual([]); // no RaceId
  });
});

describe("parseVenueLocalMs — the ET wall-clock trap", () => {
  it("parses a summer (EDT, -04:00) stamp", () => {
    expect(parseVenueLocalMs("2026-08-11T23:05:35.457")).toBe(HEAT_67_END_UTC);
  });

  it("parses a winter (EST, -05:00) stamp — the Dec-19 6pm bug class", () => {
    expect(parseVenueLocalMs("2026-01-15T18:00:00")).toBe(Date.parse("2026-01-15T23:00:00Z"));
  });

  it("returns null for garbage", () => {
    expect(parseVenueLocalMs(undefined)).toBeNull();
    expect(parseVenueLocalMs("not a date")).toBeNull();
  });
});

describe("parseVenueHeatNumber", () => {
  it('reads "67 - Mega Starter" → 67 (no [HEAT] prefix on this feed)', () => {
    expect(parseVenueHeatNumber("67 - Mega Starter")).toBe(67);
    expect(parseVenueHeatNumber("13 - Blue Junior Pro")).toBe(13);
  });

  it("group events without a leading number return null — never guess", () => {
    expect(parseVenueHeatNumber("Gartner Party Race")).toBeNull();
  });
});

describe("isActionableFinish — the catch-up-dump gate", () => {
  const fresh = extractRaceFinishes([FINISH_67])[0];

  it("fires for an end stamped moments ago", () => {
    expect(isActionableFinish(fresh, HEAT_67_END_UTC + 5_000)).toBe(true);
  });

  it("stays inert for a reconnect dump replaying the afternoon", () => {
    // The real failure mode: the 8:26pm array carried heats from 5:57pm.
    expect(isActionableFinish(fresh, HEAT_67_END_UTC + 2.5 * 3600_000)).toBe(false);
  });

  it("tolerates small clock skew (venue stamp slightly ahead of us)", () => {
    expect(isActionableFinish(fresh, HEAT_67_END_UTC - 60_000)).toBe(true);
  });

  it("trusts an unstamped Finished only while its race is recent", () => {
    const [f] = extractRaceFinishes([FINISH_65_UNSTAMPED]);
    const startUtc = f.actualStartMs as number;
    expect(isActionableFinish(f, startUtc + 9 * 60_000)).toBe(true); // pending window
    expect(isActionableFinish(f, startUtc + 2 * 3600_000)).toBe(false); // stale replay
  });

  it("ignores races in any non-Finished state", () => {
    const [advice] = extractRaceFinishes([{ ...FINISH_67, State: "Started" }]);
    expect(isActionableFinish(advice, HEAT_67_END_UTC)).toBe(false);
  });
});
