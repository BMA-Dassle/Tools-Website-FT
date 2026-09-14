import { describe, expect, it } from "vitest";
import {
  MIN_SPAN_MINUTES,
  barGeometry,
  boundsForSections,
  coalesceByReservation,
  collapseEmptyRows,
  fmtMinuteOfDay,
  heatMatchIndex,
  heatMatchKeys,
  laneMatchIndex,
  layoutFromParam,
  minutesFromEtMidnight,
  ownerOf,
  pctOf,
  trackKeyOf,
  type GridBar,
  type GridRow,
  type GridSection,
} from "./grid";
import type { Reservation } from "./types";

const DATE = "2026-09-14";

function bar(over: Partial<GridBar> & { start: number; end: number }): GridBar {
  return {
    key: `k-${over.start}-${over.end}`,
    kind: "walkin",
    label: "Reservation",
    ...over,
  };
}

function row(id: string, bars: GridBar[]): GridRow {
  return { id, label: id, bars };
}

function section(name: string, rows: GridRow[]): GridSection {
  return { name, rows };
}

function res(over: Partial<Reservation> & { id: number }): Reservation {
  return {
    centerCode: "TXBSQN0FEKQ11",
    productKind: "open",
    depositCents: 0,
    totalCents: 0,
    refundCents: 0,
    rewardDiscountCents: 0,
    promoSavingsCents: 0,
    status: "confirmed",
    bookedAt: `${DATE}T20:00:00-04:00`,
    insertedAt: `${DATE}T10:00:00.000Z`,
    lines: [],
    ...over,
  } as Reservation;
}

describe("layoutFromParam", () => {
  it("only the exact string opts into the grid", () => {
    expect(layoutFromParam("grid")).toBe("grid");
    expect(layoutFromParam("list")).toBe("list");
    expect(layoutFromParam(null)).toBe("list");
    expect(layoutFromParam("GRID")).toBe("list");
  });
});

describe("fmtMinuteOfDay", () => {
  it("reads as a wall clock, including both ends of the day", () => {
    expect(fmtMinuteOfDay(0)).toBe("12:00 AM");
    expect(fmtMinuteOfDay(12 * 60)).toBe("12:00 PM");
    expect(fmtMinuteOfDay(16 * 60 + 30)).toBe("4:30 PM");
    expect(fmtMinuteOfDay(23 * 60 + 59)).toBe("11:59 PM");
  });
});

describe("minutesFromEtMidnight", () => {
  it("reads a NAIVE race heat id as the wall clock it already is", () => {
    expect(minutesFromEtMidnight(`${DATE}T20:30:00`, DATE)).toBe(20 * 60 + 30);
  });

  it("converts an offset-aware bowling slot to the SAME ET frame", () => {
    // 8:30 PM ET in September is -04:00; both shapes must land on 1230.
    expect(minutesFromEtMidnight(`${DATE}T20:30:00-04:00`, DATE)).toBe(20 * 60 + 30);
    expect(minutesFromEtMidnight(`${DATE}T00:30:00Z`, DATE)).toBe(-(3 * 60 + 30));
  });

  it("agrees between the two shapes — the bug this frame exists to prevent", () => {
    const naive = minutesFromEtMidnight(`${DATE}T18:15:00`, DATE);
    const zoned = minutesFromEtMidnight(`${DATE}T18:15:00-04:00`, DATE);
    expect(naive).toBe(zoned);
  });
});

describe("boundsForSections", () => {
  it("fits the drawn day to the hours actually in use", () => {
    const bounds = boundsForSections([
      section("Regular", [row("1", [bar({ start: 16 * 60 + 10, end: 17 * 60 + 50 })])]),
      section("VIP", [row("25", [bar({ start: 19 * 60, end: 21 * 60 + 20 })])]),
    ]);
    expect(bounds.openMin).toBe(16 * 60);
    expect(bounds.closeMin).toBe(22 * 60);
  });

  it("gives an empty day a real axis instead of collapsing to nothing", () => {
    const bounds = boundsForSections([]);
    expect(bounds.closeMin - bounds.openMin).toBeGreaterThanOrEqual(MIN_SPAN_MINUTES);
    expect(bounds.ticks.length).toBeGreaterThan(1);
  });

  it("widens a single short booking so its bar is not the whole width", () => {
    const bounds = boundsForSections([
      section("Regular", [row("1", [bar({ start: 20 * 60, end: 20 * 60 + 12 })])]),
    ]);
    expect(bounds.closeMin - bounds.openMin).toBeGreaterThanOrEqual(MIN_SPAN_MINUTES);
  });

  it("never runs off either end of the day", () => {
    const early = boundsForSections([section("R", [row("1", [bar({ start: 0, end: 20 })])])]);
    expect(early.openMin).toBeGreaterThanOrEqual(0);
    const late = boundsForSections([
      section("R", [row("1", [bar({ start: 23 * 60 + 30, end: 24 * 60 })])]),
    ]);
    expect(late.closeMin).toBeLessThanOrEqual(24 * 60);
    expect(late.closeMin - late.openMin).toBeGreaterThanOrEqual(MIN_SPAN_MINUTES);
  });
});

describe("pctOf / barGeometry", () => {
  const bounds = { openMin: 16 * 60, closeMin: 22 * 60 };

  it("places a bar's left edge at its true start", () => {
    const geo = barGeometry({ start: 19 * 60, end: 20 * 60 }, bounds);
    expect(geo.left).toBeCloseTo(50, 5);
    expect(geo.width).toBeCloseTo(100 / 6, 5);
  });

  it("clamps a session that started before the drawn day rather than going negative", () => {
    const geo = barGeometry({ start: 14 * 60, end: 17 * 60 }, bounds);
    expect(geo.left).toBe(0);
    expect(geo.width).toBeCloseTo(100 / 6, 5);
  });

  it("survives a degenerate span without dividing by zero", () => {
    expect(pctOf(600, { openMin: 600, closeMin: 600 })).toBe(0);
  });
});

describe("coalesceByReservation", () => {
  it("fuses the schedule bar and the floor bar of ONE running session", () => {
    // lane-plan emits both: the booked window, and a floor hold from `now` to
    // that window's end + turnaround. Same id, different labels.
    const out = coalesceByReservation([
      bar({ start: 18 * 60, end: 19 * 60, label: "Yepes", reservationId: "R1" }),
      bar({ start: 18 * 60 + 40, end: 19 * 60 + 15, label: "running R1", reservationId: "R1" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(18 * 60);
    expect(out[0].end).toBe(19 * 60 + 15);
  });

  it("prefers the guest's name over the synthetic floor label", () => {
    const out = coalesceByReservation([
      bar({ start: 18 * 60 + 40, end: 19 * 60, label: "running R1", reservationId: "R1" }),
      bar({ start: 18 * 60, end: 19 * 60, label: "Yepes", reservationId: "R1" }),
    ]);
    expect(out[0].label).toBe("Yepes");
  });

  it("NEVER fuses two unidentified walk-ins — they are two different parties", () => {
    const out = coalesceByReservation([
      bar({ start: 18 * 60, end: 19 * 60, label: "Walk-in" }),
      bar({ start: 19 * 60, end: 20 * 60, label: "Walk-in" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps two different bookings on one lane apart", () => {
    const out = coalesceByReservation([
      bar({ start: 18 * 60, end: 19 * 60, label: "Party", reservationId: "R1" }),
      bar({ start: 19 * 60, end: 20 * 60, label: "Party", reservationId: "R2" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("collapseEmptyRows", () => {
  const busy = row("1", [bar({ start: 18 * 60, end: 19 * 60 })]);

  it("folds a run of empty lanes into one band", () => {
    const out = collapseEmptyRows([busy, row("2", []), row("3", []), row("4", [])]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ type: "empty", label: "2–4" });
  });

  it("leaves a lone empty lane as a lane — a band of one is worse", () => {
    const out = collapseEmptyRows([busy, row("2", []), row("3", [bar({ start: 1, end: 2 })])]);
    expect(out.map((d) => d.type)).toEqual(["row", "row", "row"]);
  });

  it("expanded shows every lane, collapsing nothing", () => {
    const out = collapseEmptyRows([busy, row("2", []), row("3", []), row("4", [])], true);
    expect(out).toHaveLength(4);
    expect(out.every((d) => d.type === "row")).toBe(true);
  });
});

describe("laneMatchIndex / ownerOf", () => {
  it("matches a lane bar to our row by QAMF id, case-insensitively", () => {
    const ours = res({ id: 7, qamfReservationId: "AbC123", guestName: "Soto" });
    const byQamf = laneMatchIndex([ours]);
    const hit = ownerOf(bar({ start: 1, end: 2, reservationId: "abc123" }), byQamf, new Map());
    expect(hit?.id).toBe(7);
  });

  it("a league block is nobody's — it stays un-clickable", () => {
    const byQamf = laneMatchIndex([res({ id: 7, qamfReservationId: "R1" })]);
    const hit = ownerOf(bar({ start: 1, end: 2, kind: "league" }), byQamf, new Map());
    expect(hit).toBeNull();
  });

  it("an unknown QAMF id is not ours — front-desk bookings never match", () => {
    const byQamf = laneMatchIndex([res({ id: 7, qamfReservationId: "R1" })]);
    expect(ownerOf(bar({ start: 1, end: 2, reservationId: "R2" }), byQamf, new Map())).toBeNull();
  });
});

describe("trackKeyOf", () => {
  it("reads the track out of both an Office resource and a BMI line name", () => {
    expect(trackKeyOf("Blue Track")).toBe("blue");
    expect(trackKeyOf("Starter Race Blue")).toBe("blue");
    expect(trackKeyOf("Red Track")).toBe("red");
    expect(trackKeyOf("Mega Track")).toBe("mega");
  });

  it("is null for a resource with no track in its name", () => {
    expect(trackKeyOf("Mini Track")).toBeNull();
    expect(trackKeyOf("Duckpin")).toBeNull();
    expect(trackKeyOf(null)).toBeNull();
  });
});

describe("heatMatchKeys", () => {
  it("keys a race leg on track + start minute", () => {
    const leg = res({
      id: 1,
      productKind: "race",
      liveHeats: [
        { start: `${DATE}T17:15:00`, stop: `${DATE}T17:27:00`, name: "Starter Race Blue" },
      ],
    });
    expect(heatMatchKeys(leg, DATE)).toEqual(["blue@1035"]);
  });

  it("PREFERS liveHeats — an office reschedule moved the heat after booking", () => {
    const leg = res({
      id: 1,
      productKind: "race",
      liveHeats: [{ start: `${DATE}T19:00:00`, stop: null, name: "Starter Race Red" }],
      bookingMetadata: { heats: [{ track: "Blue Track", heatId: `${DATE}T17:15:00` }] },
    });
    // The stale booking-time heat must NOT be drawn.
    expect(heatMatchKeys(leg, DATE)).toEqual(["red@1140"]);
  });

  it("falls back to booking metadata when the bill has not been re-read", () => {
    const leg = res({
      id: 1,
      productKind: "race",
      bookingMetadata: { heats: [{ track: "Blue Track", heatId: `${DATE}T17:15:00` }] },
    });
    expect(heatMatchKeys(leg, DATE)).toEqual(["blue@1035"]);
  });

  it("drops a heat with no usable track or time rather than guessing one", () => {
    const leg = res({
      id: 1,
      productKind: "race",
      bookingMetadata: { heats: [{ track: "Mini Track", heatId: `${DATE}T17:15:00` }] },
    });
    expect(heatMatchKeys(leg, DATE)).toEqual([]);
  });
});

describe("heatMatchIndex / ownerOf for heats", () => {
  it("matches a heat bar to the race leg sitting in that block", () => {
    const leg = res({
      id: 42,
      productKind: "race",
      guestName: "McAfee",
      liveHeats: [
        { start: `${DATE}T17:15:00`, stop: `${DATE}T17:27:00`, name: "Starter Race Blue" },
      ],
    });
    const byHeat = heatMatchIndex([leg], DATE);
    const hit = ownerOf(
      bar({ start: 1035, end: 1047, kind: "heat", trackKey: "blue" }),
      new Map(),
      byHeat,
    );
    expect(hit?.id).toBe(42);
  });

  it("does not match the SAME minute on a different track", () => {
    const leg = res({
      id: 42,
      productKind: "race",
      liveHeats: [{ start: `${DATE}T17:15:00`, stop: null, name: "Starter Race Blue" }],
    });
    const byHeat = heatMatchIndex([leg], DATE);
    const hit = ownerOf(
      bar({ start: 1035, end: 1047, kind: "heat", trackKey: "red" }),
      new Map(),
      byHeat,
    );
    expect(hit).toBeNull();
  });

  it("does not match a different minute on the same track", () => {
    const leg = res({
      id: 42,
      productKind: "race",
      liveHeats: [{ start: `${DATE}T17:15:00`, stop: null, name: "Starter Race Blue" }],
    });
    const byHeat = heatMatchIndex([leg], DATE);
    const hit = ownerOf(
      bar({ start: 1050, end: 1062, kind: "heat", trackKey: "blue" }),
      new Map(),
      byHeat,
    );
    expect(hit).toBeNull();
  });
});
