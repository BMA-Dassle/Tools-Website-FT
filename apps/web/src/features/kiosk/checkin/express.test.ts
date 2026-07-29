import { describe, expect, it } from "vitest";
import { isExpressBooking, isExpressRoster } from "./express";

describe("isExpressBooking (browse list, booking-time flag)", () => {
  const allReturning = [{ personId: "12345" }, { personId: "67890" }];

  it("is express when fastLane is set and every racer is resolved", () => {
    expect(
      isExpressBooking({ record: { fastLane: true, racers: allReturning }, racingOnly: true }),
    ).toBe(true);
  });

  it("is NOT express when a racer has no personId (the 2026-06-13 ops bug)", () => {
    // W40849 shape: racer #1 returning with a waiver, racer #2 typed in by hand.
    expect(
      isExpressBooking({
        record: { fastLane: true, racers: [{ personId: "12345" }, { personId: null }] },
        racingOnly: true,
      }),
    ).toBe(false);
    expect(
      isExpressBooking({
        record: { fastLane: true, racers: [{ personId: "12345" }, {}] },
        racingOnly: true,
      }),
    ).toBe(false);
  });

  it("is NOT express without the fastLane flag — the default for every booking", () => {
    // Phone/office bookings and any party with a new racer land here. This is
    // the case the kiosk was wrongly badging as express on every racing row.
    expect(isExpressBooking({ record: { racers: allReturning }, racingOnly: true })).toBe(false);
    expect(
      isExpressBooking({ record: { fastLane: false, racers: allReturning }, racingOnly: true }),
    ).toBe(false);
  });

  it("is NOT express with no record at all (evicted / never written)", () => {
    expect(isExpressBooking({ record: null, racingOnly: true })).toBe(false);
    expect(isExpressBooking({ record: undefined, racingOnly: true })).toBe(false);
  });

  it("is NOT express with an empty racer list", () => {
    expect(isExpressBooking({ record: { fastLane: true, racers: [] }, racingOnly: true })).toBe(
      false,
    );
    expect(isExpressBooking({ record: { fastLane: true }, racingOnly: true })).toBe(false);
  });

  it("is NOT express for a combo — a bowling/attraction leg still needs the kiosk", () => {
    expect(
      isExpressBooking({ record: { fastLane: true, racers: allReturning }, racingOnly: false }),
    ).toBe(false);
  });
});

describe("isExpressRoster (itinerary, live waiver truth)", () => {
  it("is express when every racer is identified with a valid waiver", () => {
    expect(
      isExpressRoster({
        racers: [
          { identified: true, waiverValid: true },
          { identified: true, waiverValid: true },
        ],
        racingOnly: true,
      }),
    ).toBe(true);
  });

  it("is NOT express when any waiver lapsed — booking-time fastLane can be stale", () => {
    expect(
      isExpressRoster({
        racers: [
          { identified: true, waiverValid: true },
          { identified: true, waiverValid: false },
        ],
        racingOnly: true,
      }),
    ).toBe(false);
  });

  it("is NOT express when any racer is unidentified", () => {
    expect(
      isExpressRoster({
        racers: [
          { identified: true, waiverValid: true },
          { identified: false, waiverValid: false },
        ],
        racingOnly: true,
      }),
    ).toBe(false);
  });

  it("is NOT express with no racers, or for a combo", () => {
    expect(isExpressRoster({ racers: [], racingOnly: true })).toBe(false);
    expect(
      isExpressRoster({ racers: [{ identified: true, waiverValid: true }], racingOnly: false }),
    ).toBe(false);
  });
});
