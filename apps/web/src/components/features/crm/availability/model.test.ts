import { describe, expect, it } from "vitest";
import { EVENING_CLOSE_MIN, EVENING_OPEN_MIN } from "~/features/crm/availability/pure";
import type { LaneOccupancy } from "~/features/crm/availability/contracts";
import {
  contiguousLabel,
  durationLabel,
  freshnessLabel,
  heatsPanelState,
  heatsSubtitleFor,
  holdHref,
  miniSectionRows,
  runLabel,
  screenHeadFor,
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
  it("hands the builder MACHINE-READABLE values, not a display string", () => {
    const href = holdHref(
      "/admin/crm",
      "L-1042",
      { section: "Regular", lanes: [13, 14, 15], run: [13, 14, 15, 16], startsOdd: true },
      18 * 60,
    );
    expect(href).toBe("/admin/crm/builder/L-1042?firstLane=13&count=3&start=1080&section=Regular");
    // The en dash belongs on screen, never in a query C5 has to parse.
    expect(href).not.toContain("–");
    const p = new URL(href, "http://x").searchParams;
    expect(Number(p.get("firstLane"))).toBe(13);
    expect(Number(p.get("count"))).toBe(3);
    expect(Number(p.get("start"))).toBe(1080);
  });
});

describe("screenHeadFor", () => {
  const base = {
    centreShort: "HP Fort Myers",
    dateLabel: "Sat, Oct 17",
    title: "Lee Health",
    guests: 60,
    need: 10,
    heats: 0,
  };

  it("names the lane screen the way the prototype does", () => {
    expect(screenHeadFor({ ...base, source: "lanes" })).toEqual({
      title: "Lane availability · HP Fort Myers",
      sub: "Sat, Oct 17 · Lee Health · 60 guests → 10 lanes",
    });
  });

  it("never says LANES over a karting grid", () => {
    // FastTrax has no lanes at all; the prototype dodged this by mapping FT to
    // HPFM (`crm-shared.js:511`). "30 guests → 5 lanes" for a centre with no
    // lanes is the one thing this screen must not print.
    const head = screenHeadFor({
      ...base,
      source: "heats",
      centreShort: "FastTrax",
      guests: 30,
      need: 0,
      heats: 3,
    });
    expect(head).toEqual({
      title: "Heat availability · FastTrax",
      sub: "Sat, Oct 17 · Lee Health · 30 racers → 3 heats",
    });
    expect(head.sub).not.toMatch(/lane/i);
  });

  it("drops the arrow until the heats read lands", () => {
    expect(heatsSubtitleFor({ dateLabel: "Sat, Oct 17", title: null, racers: 30, heats: 0 })).toBe(
      "Sat, Oct 17 · 30 racers",
    );
  });

  it("falls back to the lane head before either read answers", () => {
    expect(screenHeadFor({ ...base, source: null }).title).toBe(
      "Lane availability · HP Fort Myers",
    );
  });
});

describe("heatsPanelState", () => {
  const resource = { resourceId: "63000000001234567", blocks: [{}, {}] };

  it("calls an outage an outage, not an unpublished day planner", () => {
    expect(
      heatsPanelState({ source: "unavailable", selectedResourceId: null, resources: [] }),
    ).toBe("unavailable");
  });

  it("shows the grid when a resource actually has heats", () => {
    expect(
      heatsPanelState({
        source: "heats",
        selectedResourceId: "63000000001234567",
        resources: [resource],
      }),
    ).toBe("grid");
  });

  it("keeps the empty state for a successful read with nothing in it", () => {
    expect(
      heatsPanelState({
        source: "heats",
        selectedResourceId: "63000000001234567",
        resources: [{ ...resource, blocks: [] }],
      }),
    ).toBe("empty");
    expect(heatsPanelState({ source: "heats", selectedResourceId: null, resources: [] })).toBe(
      "empty",
    );
  });
});

describe("miniSectionRows", () => {
  it("is the prototype's meter list, one row per section", () => {
    expect(
      miniSectionRows([
        { name: "Old Time Lanes", lanes: [1, 2, 3, 4], free: 3, runs: [[1, 2, 3]] },
        { name: "VIP", lanes: [5, 6, 7, 8], free: 2, runs: [[7, 8]] },
        { name: "Regular", lanes: [13, 14, 15, 16], free: 0, runs: [] },
      ]),
    ).toEqual([
      { name: "Old Time Lanes", free: 3, total: 4, pct: 75, tone: "good", n: "3 of 4 free" },
      { name: "VIP", free: 2, total: 4, pct: 50, tone: "warn", n: "2 of 4 free" },
      { name: "Regular", free: 0, total: 4, pct: 0, tone: "crit", n: "0 of 4 free" },
    ]);
  });
});
