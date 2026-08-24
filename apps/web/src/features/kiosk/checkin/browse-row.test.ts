import { describe, expect, it } from "vitest";
import {
  browseRowIsOpen,
  browseRowTime,
  earliestHeatStart,
  isDeadStatus,
  type BrowseLegLike,
} from "./browse-row";
import { fmtTime12, timeKey } from "./itinerary";

const race = (
  heats: string[],
  status = "confirmed",
  bookedAt = "2026-08-07T22:04:00.000Z",
): BrowseLegLike => ({
  productKind: "race",
  status,
  bookedAt,
  bookingMetadata: { heats: heats.map((heatId) => ({ heatId, racer: "Adult 1" })) },
});
const bowling = (status = "confirmed", bookedAt = "2026-08-07T18:00:00.000Z"): BrowseLegLike => ({
  productKind: "bowling",
  status,
  bookedAt,
  bookingMetadata: {},
});

describe("browseRowTime — the race time, not the booking time", () => {
  it("shows the HEAT, not bookedAt (the live defect)", () => {
    // Live row …654823: booked 10:04 PM, races 23:48. The list showed 10:04.
    const out = browseRowTime([
      race(["2026-08-07T23:48:00"], "confirmed", "2026-08-07T22:04:00.000Z"),
    ]);
    expect(out).toEqual({ iso: "2026-08-07T23:48:00", source: "heat" });
  });

  it("uses the EARLIEST heat on a multi-race booking", () => {
    const out = browseRowTime([race(["2026-08-07T21:12:00", "2026-08-07T20:24:00"])]);
    expect(out.iso).toBe("2026-08-07T20:24:00");
  });

  it("uses the earliest heat ACROSS legs of one reservation", () => {
    const out = browseRowTime([race(["2026-08-07T22:48:00"]), race(["2026-08-07T20:00:00"])]);
    expect(out.iso).toBe("2026-08-07T20:00:00");
  });

  it("falls back to bookedAt only when NO leg has a heat", () => {
    // 18:00Z on an EDT day is 2:00 PM ET — the fallback must hand back the ET
    // wall-clock, because timeKey/fmtTime12 read it as one.
    const out = browseRowTime([bowling()]);
    expect(out).toEqual({ iso: "2026-08-07T14:00:00", source: "booked" });
  });

  it("does NOT advertise a 9:00 PM lane as 1:00 AM (the live 4h defect)", () => {
    // Mirlanda B., HPFM 2026-08-18 21:00 ET. Neon serializes booked_at as the
    // UTC instant, so the board printed the stripped UTC hour — four hours out,
    // and past midnight, which also sorted it to the bottom of the list.
    const out = browseRowTime([bowling("confirmed", "2026-08-19T01:00:00.000Z")]);
    expect(out).toEqual({ iso: "2026-08-18T21:00:00", source: "booked" });
    expect(fmtTime12(out.iso)).toBe("9:00 PM");
    expect(timeKey(out.iso)).toBe("2026-08-18T21:00");
  });

  it("orders heat-less legs by the CLOCK, not by the zone suffix", () => {
    // A naive-ET leg and a UTC-stamped leg in one group: sorting the raw
    // strings put "2026-08-18T22:30:00" before "2026-08-19T01:00:00.000Z" even
    // though the second is the earlier lane (9:00 PM vs 10:30 PM).
    const out = browseRowTime([
      bowling("confirmed", "2026-08-18T22:30:00"),
      bowling("confirmed", "2026-08-19T01:00:00.000Z"),
    ]);
    expect(out.iso).toBe("2026-08-18T21:00:00");
  });

  it("survives a leg with no bookedAt at all", () => {
    expect(browseRowTime([{ productKind: "bowling" }])).toEqual({ iso: "", source: "booked" });
  });

  it("prefers a race heat over a bowling leg's bookedAt on a combo", () => {
    const out = browseRowTime([
      bowling("confirmed", "2026-08-07T18:00:00.000Z"),
      race(["2026-08-07T22:48:00"]),
    ]);
    expect(out).toEqual({ iso: "2026-08-07T22:48:00", source: "heat" });
  });

  it("ignores malformed heat ids rather than showing them", () => {
    const out = browseRowTime([race(["", "nope", "2026-08-07T22:48:00"])]);
    expect(out.iso).toBe("2026-08-07T22:48:00");
  });

  it("returns empty when there is nothing at all", () => {
    expect(browseRowTime([])).toEqual({ iso: "", source: "booked" });
  });
});

describe("earliestHeatStart", () => {
  it("is empty for a leg with no heats", () => {
    expect(earliestHeatStart(bowling())).toBe("");
  });
  it("survives booking_metadata that isn't shaped as expected", () => {
    expect(earliestHeatStart({ bookingMetadata: { heats: "nope" } })).toBe("");
    expect(earliestHeatStart({ bookingMetadata: null })).toBe("");
    expect(earliestHeatStart({})).toBe("");
  });
});

describe("isDeadStatus", () => {
  it("catches both spellings of cancelled, and the rest", () => {
    for (const s of [
      "cancelled",
      "canceled",
      "no_show",
      "refunded",
      "voided",
      "CANCELLED",
      " Cancelled ",
    ]) {
      expect(isDeadStatus(s)).toBe(true);
    }
  });
  it("leaves live statuses alone", () => {
    for (const s of ["confirmed", "arrived", "pending", "", null, undefined]) {
      expect(isDeadStatus(s)).toBe(false);
    }
  });
});

describe("browseRowIsOpen — a cancelled reservation must not be selectable", () => {
  it("hides a cancelled reservation (the live defect)", () => {
    expect(browseRowIsOpen([race(["2026-08-07T22:48:00"], "cancelled")])).toBe(false);
  });

  it("hides the WHOLE reservation when any leg is cancelled", () => {
    // One dead leg kills the group — better "see the desk" than opening a
    // reservation that no longer exists and finding out three screens later.
    expect(browseRowIsOpen([race(["2026-08-07T22:48:00"]), bowling("cancelled")])).toBe(false);
  });

  it("keeps a fully live reservation", () => {
    expect(browseRowIsOpen([race(["2026-08-07T22:48:00"]), bowling()])).toBe(true);
  });

  it("keeps an arrived reservation — already checked in is not cancelled", () => {
    expect(browseRowIsOpen([race(["2026-08-07T22:48:00"], "arrived")])).toBe(true);
  });

  it("hides a reservation with no legs at all", () => {
    expect(browseRowIsOpen([])).toBe(false);
  });
});
