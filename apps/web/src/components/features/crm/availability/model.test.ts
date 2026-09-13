import { describe, expect, it } from "vitest";
import { EVENING_CLOSE_MIN, EVENING_OPEN_MIN } from "~/features/crm/availability/service/engine";
import type { LaneOccupancy } from "~/features/crm/availability/contracts";
import {
  contiguousLabel,
  durationLabel,
  freshnessLabel,
  holdHref,
  runLabel,
  sectionChipKind,
  sectionRangeLabel,
  sectionView,
  startOptions,
  subtitleFor,
  windowBand,
  windowLabel,
} from "./model";

const BOUNDS = { openMin: EVENING_OPEN_MIN, closeMin: EVENING_CLOSE_MIN };

describe("labels", () => {
  it("names the four lengths the request bar offers", () => {
    expect(durationLabel(60)).toBe("1 hour");
    expect(durationLabel(90)).toBe("1.5 hours");
    expect(durationLabel(120)).toBe("2 hours");
    expect(durationLabel(180)).toBe("3 hours");
    expect(durationLabel(240)).toBe("4 hours");
    expect(durationLabel(150)).toBe("2.5 hours");
  });

  it("prints a window the way the verdict reads it", () => {
    expect(windowLabel(18 * 60, 120)).toBe("6:00 PM–8:00 PM");
    expect(windowLabel(16 * 60 + 30, 90)).toBe("4:30 PM–6:00 PM");
  });

  it("collapses a run of lanes to its ends", () => {
    expect(runLabel([13, 14, 15])).toBe("13–15");
    expect(runLabel([19])).toBe("19");
    expect(runLabel([])).toBe("");
    expect(contiguousLabel([[13, 14], [19], [21, 22, 23]])).toBe("13–14, 19, 21–23");
  });

  it("names a section's lane range", () => {
    expect(sectionRangeLabel([5, 6, 7, 8])).toBe("lanes 5–8");
    expect(sectionRangeLabel([])).toBe("no lanes");
  });

  it("colours the section chip by whether it can take the party", () => {
    expect(sectionChipKind(10, 10)).toBe("won");
    expect(sectionChipKind(11, 10)).toBe("won");
    expect(sectionChipKind(4, 10)).toBe("warn");
    expect(sectionChipKind(0, 10)).toBe("lost");
  });

  it("writes the prototype's sub-line", () => {
    expect(
      subtitleFor({ dateLabel: "Sat, Oct 17", title: "Lee Health", guests: 60, need: 10 }),
    ).toBe("Sat, Oct 17 · Lee Health · 60 guests → 10 lanes");
    expect(subtitleFor({ dateLabel: "Sat, Oct 17", title: null, guests: 12, need: 2 })).toBe(
      "Sat, Oct 17 · 12 guests → 2 lanes",
    );
  });
});

describe("freshnessLabel", () => {
  const now = new Date("2026-09-13T18:30:00Z");

  it("reports the REAL age, not the mockup's hard-coded 60 s", () => {
    expect(freshnessLabel("2026-09-13T18:29:48Z", now)).toBe("refreshed 12 s ago");
    expect(freshnessLabel("2026-09-13T18:30:00Z", now)).toBe("refreshed just now");
    expect(freshnessLabel("2026-09-13T18:25:00Z", now)).toBe("refreshed 5 min ago");
  });

  it("never claims a read from the future is stale", () => {
    expect(freshnessLabel("2026-09-13T18:31:00Z", now)).toBe("refreshed just now");
    expect(freshnessLabel("not a date", now)).toBe("refreshed just now");
  });
});

describe("startOptions", () => {
  it("offers every half hour inside the drawn day", () => {
    const opts = startOptions(BOUNDS);
    expect(opts).toHaveLength(12);
    expect(opts[0]).toEqual({ value: 960, label: "4:00 PM" });
    expect(opts.at(-1)).toEqual({ value: 1290, label: "9:30 PM" });
  });
});

describe("windowBand", () => {
  it("places the requested block across the track as percentages", () => {
    // 6-10 PM window drawn 4-10 PM: starts a third in, two thirds wide
    expect(windowBand(18 * 60, 120, BOUNDS)).toEqual({
      left: (120 / 360) * 100,
      width: (120 / 360) * 100,
    });
  });
});

describe("sectionView", () => {
  const section = {
    name: "Regular",
    lanes: [13, 14, 15, 16, 17, 18],
    free: 4,
    runs: [
      [13, 14],
      [17, 18],
    ],
  };

  const lanes: LaneOccupancy[] = [
    { lane: 13, blocks: [] },
    { lane: 14, blocks: [] },
    {
      lane: 15,
      blocks: [{ kind: "league", label: "Tues Nite Mixed", start: 18 * 60 + 30, end: 21 * 60 }],
    },
    {
      lane: 16,
      blocks: [{ kind: "league", label: "Tues Nite Mixed", start: 18 * 60 + 30, end: 21 * 60 }],
    },
    { lane: 17, blocks: [] },
    { lane: 18, blocks: [] },
  ];

  it("collapses lanes that are free all evening into one band", () => {
    const view = sectionView({
      section,
      lanes,
      placement: null,
      need: 2,
      bounds: BOUNDS,
      expanded: false,
    });
    expect(view.rows).toEqual([
      { type: "free", lanes: [13, 14], label: "2 lanes free all evening" },
      expect.objectContaining({ type: "lane", lane: 15, picked: false }),
      expect.objectContaining({ type: "lane", lane: 16, picked: false }),
      { type: "free", lanes: [17, 18], label: "2 lanes free all evening" },
    ]);
    expect(view.chipKind).toBe("won");
    expect(view.contiguous).toBe("13–14, 17–18");
    expect(view.rangeLabel).toBe("lanes 13–18");
  });

  it("gives a single free lane the singular line", () => {
    const view = sectionView({
      section: { ...section, lanes: [13, 15], runs: [[13]], free: 1 },
      lanes,
      placement: null,
      need: 2,
      bounds: BOUNDS,
      expanded: false,
    });
    expect(view.rows[0]).toEqual({ type: "free", lanes: [13], label: "free all evening" });
  });

  it("gives the picked lanes their own rows even when they are empty", () => {
    const view = sectionView({
      section,
      lanes,
      placement: { section: "Regular", lanes: [13, 14], run: [13, 14], startsOdd: true },
      need: 2,
      bounds: BOUNDS,
      expanded: false,
    });
    const picked = view.rows.filter((r) => r.type === "lane" && r.picked);
    expect(picked).toHaveLength(2);
    expect(view.rows[0]).toEqual(
      expect.objectContaining({ type: "lane", lane: 13, picked: true, bars: [] }),
    );
  });

  it("shows every lane once the planner asks", () => {
    const view = sectionView({
      section,
      lanes,
      placement: null,
      need: 2,
      bounds: BOUNDS,
      expanded: true,
    });
    expect(view.rows).toHaveLength(6);
    expect(view.rows.every((r) => r.type === "lane")).toBe(true);
  });

  it("positions a bar by its real minutes, with the time in its tooltip", () => {
    const view = sectionView({
      section,
      lanes,
      placement: null,
      need: 2,
      bounds: BOUNDS,
      expanded: true,
    });
    const row = view.rows.find((r) => r.type === "lane" && r.lane === 15);
    const bar = row?.type === "lane" ? row.bars[0] : undefined;
    // 18:30 is 150 minutes into a 360-minute day; 21:00 is 300.
    expect(bar?.left).toBeCloseTo((150 / 360) * 100, 6);
    expect(bar?.width).toBeCloseTo((150 / 360) * 100, 6);
    expect(bar?.title).toBe("Tues Nite Mixed · 6:30 PM–9:00 PM");
  });
});

describe("holdHref", () => {
  it("hands the builder the pick in the URL", () => {
    expect(
      holdHref(
        "/admin/crm",
        "L-1042",
        { section: "Regular", lanes: [13, 14, 15], run: [13, 14, 15, 16], startsOdd: true },
        18 * 60,
      ),
    ).toBe("/admin/crm/builder/L-1042?lanes=13%E2%80%9315&start=1080&section=Regular");
  });
});
