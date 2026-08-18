import { describe, it, expect } from "vitest";
import { panelAt, panelTitle, prunePanels, RANGE_LABELS, type TopTimesPanel } from "./top-times";
import { applyDemo, parseDemoMode } from "./demo";
import type { TvFeed } from "./types";

/** A panel, terse. Columns are given as label → how many rows. */
function panel(
  range: TopTimesPanel["range"],
  cls: TopTimesPanel["cls"],
  columns: Array<[string, number]>,
): TopTimesPanel {
  return {
    range,
    cls,
    columns: columns.map(([label, n]) => ({
      label,
      color: "#fff",
      rows: Array.from({ length: n }, (_, i) => ({
        position: i + 1,
        name: `Racer ${i + 1}`,
        score: "28.442s",
      })),
    })),
  };
}

describe("prunePanels", () => {
  it("drops a tier nobody set a lap in", () => {
    const [p] = prunePanels([
      panel("today", "adult", [
        ["Starter", 3],
        ["Intermediate", 0],
        ["Pro", 5],
      ]),
    ]);
    expect(p.columns.map((c) => c.label)).toEqual(["Starter", "Pro"]);
  });

  it("drops a class nobody raced, so the board never rotates to an empty screen", () => {
    // The junior case this exists for: a weekday with no junior racing at all
    // must not buy itself a slot of dashes.
    const out = prunePanels([
      panel("today", "adult", [["Pro", 4]]),
      panel("today", "junior", [
        ["Junior Starter", 0],
        ["Junior Pro", 0],
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].cls).toBe("adult");
  });

  it("keeps nothing when nothing was raced", () => {
    expect(prunePanels([panel("today", "adult", [["Pro", 0]])])).toEqual([]);
  });

  it("does not mutate what it was given", () => {
    const input = [
      panel("today", "adult", [
        ["Starter", 0],
        ["Pro", 2],
      ]),
    ];
    prunePanels(input);
    expect(input[0].columns).toHaveLength(2);
  });
});

describe("panelAt", () => {
  const panels = [
    panel("today", "adult", [["Pro", 1]]),
    panel("week", "adult", [["Pro", 1]]),
    panel("month", "adult", [["Pro", 1]]),
  ];
  const SLOT = 40_000;

  it("advances one panel per slot", () => {
    expect(panelAt(panels, 0, SLOT).range).toBe("today");
    expect(panelAt(panels, SLOT, SLOT).range).toBe("week");
    expect(panelAt(panels, SLOT * 2, SLOT).range).toBe("month");
    expect(panelAt(panels, SLOT * 3, SLOT).range).toBe("today");
  });

  it("holds the same panel for the whole slot", () => {
    expect(panelAt(panels, SLOT + 1, SLOT).range).toBe("week");
    expect(panelAt(panels, SLOT * 2 - 1, SLOT).range).toBe("week");
  });

  it("gives two boards on one clock the same panel — the whole point", () => {
    const t = 1_755_000_000_000;
    expect(panelAt(panels, t, SLOT)).toBe(panelAt(panels, t, SLOT));
  });

  it("never indexes out of the array on a single-panel board", () => {
    const one = [panel("today", "adult", [["Pro", 1]])];
    expect(panelAt(one, 0, SLOT).range).toBe("today");
    expect(panelAt(one, SLOT * 99, SLOT).range).toBe("today");
  });

  it("stays in range on a negative clock", () => {
    // Only reachable from a mocked clock, but an out-of-bounds index here is
    // an undefined panel and a blank wall.
    expect(panelAt(panels, -SLOT, SLOT)).toBeDefined();
    expect(panelAt(panels, -SLOT * 5 - 1, SLOT)).toBeDefined();
  });
});

describe("panelTitle", () => {
  it("names the window, and says junior only when it is", () => {
    expect(panelTitle(panel("today", "adult", [["Pro", 1]]))).toBe("Today · Fastest Laps");
    expect(panelTitle(panel("week", "junior", [["Junior Pro", 1]]))).toBe(
      "This Week · Junior Fastest Laps",
    );
  });

  it("has a label for every window a board can be configured with", () => {
    expect(Object.keys(RANGE_LABELS).sort()).toEqual(["month", "today", "week"]);
  });
});

/** Enough of a feed for the demo decorator; the fixture only reads `screen`. */
function feedFor(track?: "blue" | "red" | "mega"): TvFeed {
  return {
    now: 0,
    screen: {
      screenId: "FT:99",
      venue: "FT",
      center: "fort-myers",
      screenNumber: 99,
      name: "Test",
      config: track ? { resultsBoard: { track } } : {},
      updatedAt: "",
    },
    topTimes: null,
  } as unknown as TvFeed;
}

describe("?demo=top-times", () => {
  it("is a mode the URL parser accepts", () => {
    expect(parseDemoMode("top-times")).toBe("top-times");
  });

  it("fills the board so it can be reviewed without re-pointing a live screen", () => {
    const out = applyDemo(feedFor("blue"), "top-times", 0);
    expect(out?.topTimes?.track).toBe("blue");
    expect(out?.topTimes?.panels.length).toBeGreaterThan(0);
  });

  it("covers all three windows, so the rotation itself gets reviewed", () => {
    const out = applyDemo(feedFor("blue"), "top-times", 0);
    expect(new Set(out?.topTimes?.panels.map((p) => p.range))).toEqual(
      new Set(["today", "week", "month"]),
    );
  });

  it("follows the screen's configured track", () => {
    expect(applyDemo(feedFor("mega"), "top-times", 0)?.topTimes?.track).toBe("mega");
    expect(applyDemo(feedFor("red"), "top-times", 0)?.topTimes?.track).toBe("red");
  });

  it("gives Red's single generic junior group one column, not three", () => {
    // The layout most likely to be wrong is the one with fewer than three
    // columns, so the fixture has to actually produce it.
    const red = applyDemo(feedFor("red"), "top-times", 0)?.topTimes;
    const junior = red?.panels.find((p) => p.cls === "junior");
    expect(junior?.columns).toHaveLength(1);
    expect(junior?.columns[0].label).toBe("Junior");
  });

  it("leaves every other section of the feed alone", () => {
    const out = applyDemo(feedFor("blue"), "top-times", 0);
    expect(out?.raceResults ?? null).toBeNull();
  });

  it("does nothing when no mode is asked for", () => {
    expect(applyDemo(feedFor("blue"), "off", 0)?.topTimes).toBeNull();
  });
});
