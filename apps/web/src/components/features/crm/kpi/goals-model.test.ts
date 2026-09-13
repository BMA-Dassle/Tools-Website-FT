import { describe, expect, it } from "vitest";
import type { GoalCell, GoalMirrorState } from "~/features/crm/kpi/contracts";
import {
  cellKey,
  dirtyCells,
  draftFromCells,
  formatMoneyInput,
  invalidCells,
  mirrorLines,
  monthTotals,
  parseMoneyInput,
  suggestAll,
  suggestFrom,
  yearTotals,
} from "./goals-model";

/**
 * The Goals grid. Every number here becomes somebody's commission target, so
 * the failure that matters is a SILENT one: a box that will not parse being
 * saved as zero, or a re-save un-syncing a year nobody touched.
 */

function cell(over: Partial<GoalCell> & { repSlug: string; month: number }): GoalCell {
  return {
    year: 2026,
    goalCents: 0,
    lastYearCents: 0,
    actualCents: null,
    pandoraSyncedAt: null,
    ...over,
  };
}

const CELLS: GoalCell[] = [
  cell({
    repSlug: "kelsea",
    month: 1,
    goalCents: 1_200_000,
    lastYearCents: 1_000_000,
    actualCents: 900_000,
  }),
  cell({ repSlug: "kelsea", month: 2, goalCents: 0, lastYearCents: 800_000 }),
  cell({
    repSlug: "lori",
    month: 1,
    goalCents: 900_000,
    lastYearCents: 850_000,
    actualCents: 700_000,
  }),
  cell({ repSlug: "lori", month: 2, goalCents: 0, lastYearCents: 0 }),
];

describe("parseMoneyInput", () => {
  it("reads plain dollars as cents", () => {
    expect(parseMoneyInput("12000")).toBe(1_200_000);
  });

  it("reads what people actually type into a money box", () => {
    expect(parseMoneyInput("$12,000")).toBe(1_200_000);
    expect(parseMoneyInput(" 12 000 ")).toBe(1_200_000);
    expect(parseMoneyInput("12k")).toBe(1_200_000);
    expect(parseMoneyInput("12.5k")).toBe(1_250_000);
  });

  it("treats an empty box as zero, which is a real goal", () => {
    expect(parseMoneyInput("")).toBe(0);
    expect(parseMoneyInput("   ")).toBe(0);
  });

  it("returns NULL — never 0 — for something it cannot read", () => {
    // 0 would silently wipe a target somebody set.
    expect(parseMoneyInput("abc")).toBeNull();
    expect(parseMoneyInput("12-000")).toBeNull();
    expect(parseMoneyInput("1.234")).toBeNull();
    expect(parseMoneyInput("-500")).toBeNull();
  });

  it("round-trips through the input format", () => {
    expect(formatMoneyInput(1_200_000)).toBe("12,000");
    expect(parseMoneyInput(formatMoneyInput(1_200_000))).toBe(1_200_000);
    // Zero shows as an empty box, not "0".
    expect(formatMoneyInput(0)).toBe("");
  });
});

describe("draftFromCells", () => {
  it("seeds one entry per cell", () => {
    const d = draftFromCells(CELLS);
    expect(d[cellKey("kelsea", 1)]).toBe("12,000");
    expect(d[cellKey("kelsea", 2)]).toBe("");
  });
});

describe("dirtyCells", () => {
  it("is empty when nothing was touched", () => {
    expect(dirtyCells(draftFromCells(CELLS), CELLS, 2026)).toEqual([]);
  });

  it("returns ONLY the changed cells", () => {
    // Posting the whole grid would enqueue a Pandora mirror for every
    // salesperson every time anybody saved one number.
    const d = { ...draftFromCells(CELLS), [cellKey("lori", 2)]: "5,000" };
    expect(dirtyCells(d, CELLS, 2026)).toEqual([
      { repSlug: "lori", year: 2026, month: 2, goalCents: 500_000 },
    ]);
  });

  it("DROPS an unreadable box rather than saving it as zero", () => {
    const d = { ...draftFromCells(CELLS), [cellKey("kelsea", 1)]: "twelve thousand" };
    expect(dirtyCells(d, CELLS, 2026)).toEqual([]);
    expect(invalidCells(d)).toEqual([cellKey("kelsea", 1)]);
  });

  it("treats clearing a box as a deliberate zero", () => {
    const d = { ...draftFromCells(CELLS), [cellKey("kelsea", 1)]: "" };
    expect(dirtyCells(d, CELLS, 2026)).toEqual([
      { repSlug: "kelsea", year: 2026, month: 1, goalCents: 0 },
    ]);
  });
});

describe("totals", () => {
  it("sums each month across the roster from what is TYPED, not what is saved", () => {
    const d = { ...draftFromCells(CELLS), [cellKey("lori", 2)]: "5,000" };
    const t = monthTotals(CELLS, d);
    expect(t.map((r) => r.month)).toEqual([1, 2]);
    expect(t[0].goalCents).toBe(2_100_000);
    expect(t[1].goalCents).toBe(500_000);
    expect(t[0].lastYearCents).toBe(1_850_000);
  });

  it("keeps 'not started' as null rather than folding it into zero", () => {
    const t = monthTotals(CELLS, draftFromCells(CELLS));
    expect(t[0].actualCents).toBe(1_600_000);
    expect(t[1].actualCents).toBeNull();
  });

  it("year totals imply a growth percentage, or none when last year was zero", () => {
    const t = yearTotals([
      { month: 1, goalCents: 1_130_000, lastYearCents: 1_000_000, actualCents: null },
    ]);
    expect(t.growthPct).toBe(13);
    expect(
      yearTotals([{ month: 1, goalCents: 500, lastYearCents: 0, actualCents: null }]).growthPct,
    ).toBeNull();
  });
});

describe("suggestions", () => {
  it("is last year times the factor, rounded to a readable $100", () => {
    expect(suggestFrom(1_000_000, 1.12)).toBe(1_120_000);
    // $8,537 × 1.12 = $9,561.44 — a goal is a round figure a director says out
    // loud, so it lands on $9,600 rather than carrying cents into Pandora.
    expect(suggestFrom(853_700, 1.12)).toBe(960_000);
  });

  it("fills only the cells that HAVE a last year to suggest from", () => {
    const d = suggestAll(CELLS, 1.12, draftFromCells(CELLS));
    expect(d[cellKey("kelsea", 1)]).toBe("11,200");
    expect(d[cellKey("kelsea", 2)]).toBe("9,000");
    // Lori's February has no last-year figure: left exactly as it was.
    expect(d[cellKey("lori", 2)]).toBe("");
  });
});

describe("mirrorLines", () => {
  function mirror(over: Partial<GoalMirrorState>): GoalMirrorState {
    return {
      repSlug: "kelsea",
      year: 2026,
      status: "failed",
      attempts: 1,
      lastError: null,
      updatedAt: "2026-09-13T18:00:00Z",
      ...over,
    };
  }

  it("says nothing about a mirror that went through", () => {
    expect(mirrorLines([mirror({ status: "done" })])).toEqual([]);
  });

  it("NEVER swallows a failure, and says Neon still holds the goal", () => {
    const [line] = mirrorLines([mirror({ status: "failed", lastError: "Pandora timed out" })]);
    expect(line.tone).toBe("warn");
    expect(line.text).toContain("Pandora timed out");
    expect(line.text).toContain("Neon still holds the goal");
  });

  it("escalates a parked mirror, which will not retry itself", () => {
    const [line] = mirrorLines([mirror({ status: "parked", attempts: 20 })]);
    expect(line.tone).toBe("crit");
    expect(line.text).toContain("gave up after 20 attempts");
  });

  it("still says something when the failure had no recorded reason", () => {
    const [line] = mirrorLines([mirror({ status: "failed", lastError: null })]);
    expect(line.text).toContain("no reason recorded");
  });

  it("shows a queued mirror as informational", () => {
    expect(mirrorLines([mirror({ status: "pending" })])[0].tone).toBe("ok");
  });
});
