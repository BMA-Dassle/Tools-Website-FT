import { describe, expect, it } from "vitest";
import { rangeOptions, windowKeyOf } from "./range";

/** 2026-09-12 19:30 ET = 23:30Z — and 21:00 ET, which is already the 13th in UTC. */
const SAT_EVENING = new Date("2026-09-12T23:30:00Z");
const SAT_LATE = new Date("2026-09-13T01:00:00Z");

describe("rangeOptions", () => {
  /**
   * LEANS FORWARD, because group events are sold months ahead: a September
   * board is mostly November and December, and neither was reachable. Owner,
   * 2026-09-14: "I should be able to select dates in q4 like nov and dec."
   */
  it("offers two months back, this month, three forward, this quarter and the next", () => {
    const o = rangeOptions(SAT_EVENING);
    expect(o.map((r) => r.key)).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
      "2026-Q3",
      "2026-Q4",
    ]);
  });

  it("marks exactly one option as the current month", () => {
    const current = rangeOptions(SAT_EVENING).filter((r) => r.current);
    expect(current.map((r) => r.key)).toEqual(["2026-09"]);
  });

  it("is derived in ET, so a late Eastern evening is still September", () => {
    expect(rangeOptions(SAT_LATE).map((r) => r.key)).toEqual(
      rangeOptions(SAT_EVENING).map((r) => r.key),
    );
  });

  it("rolls the year backwards and names it when it differs", () => {
    const o = rangeOptions(new Date("2026-01-15T17:00:00Z"));
    expect(o.map((r) => r.key)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-Q1",
      "2026-Q2",
    ]);
    expect(o[0].label).toBe("Nov 25");
    expect(o[2].label).toBe("Jan");
  });

  it("rolls forward across December", () => {
    const o = rangeOptions(new Date("2026-12-15T17:00:00Z"));
    expect(o.map((r) => r.key)).toContain("2027-01");
    expect(o.map((r) => r.key)).toContain("2027-03");
    // Q4 then Q1 of the NEXT year — the pair rolls over with the months.
    expect(o.filter((r) => r.kind === "quarter").map((r) => r.key)).toEqual(["2026-Q4", "2027-Q1"]);
  });

  it("uses the same string for the value and the URL key, so a choice is shareable", () => {
    for (const o of rangeOptions(SAT_EVENING)) expect(o.value).toBe(o.key);
  });
});

describe("windowKeyOf", () => {
  const options = rangeOptions(SAT_EVENING);

  it("shows what the SERVER resolved, not what the URL asked for", () => {
    // A hand-typed ?month=1999-13 falls back to the current month on the
    // server; the control must say what is actually on screen.
    expect(windowKeyOf("2026-09", "1999-13", null, options)).toBe("2026-09");
  });

  it("prefers the resolved key over the URL even when both are valid", () => {
    expect(windowKeyOf("2026-08", "2026-07", null, options)).toBe("2026-08");
  });

  it("falls back to the URL while the first load is still in flight", () => {
    expect(windowKeyOf(null, "2026-07", null, options)).toBe("2026-07");
    expect(windowKeyOf(null, null, "2026-Q3", options)).toBe("2026-Q3");
  });

  it("falls back to this month when nothing matches", () => {
    expect(windowKeyOf(null, null, null, options)).toBe("2026-09");
    expect(windowKeyOf("2020-01", null, null, options)).toBe("2026-09");
  });
});
