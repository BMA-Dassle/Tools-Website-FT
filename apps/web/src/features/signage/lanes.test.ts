import { describe, it, expect } from "vitest";
import { formatLanes, formatResourceList } from "./lanes";

describe("formatLanes", () => {
  it("says a consecutive run the way a person would", () => {
    // Owner 2026-08-11: "if they have lanes 1,2,3,4 it should show Lanes 1-4".
    expect(formatLanes("1,2,3,4")).toBe("Lanes 1–4");
    expect(formatLanes("1-4")).toBe("Lanes 1–4");
    expect(formatLanes("11 12")).toBe("Lanes 11–12");
  });

  it("lists non-consecutive lanes", () => {
    expect(formatLanes("11 & 14")).toBe("Lanes 11 & 14");
    expect(formatLanes("2, 5, 9")).toBe("Lanes 2 & 5 & 9");
  });

  it("keeps a single lane singular", () => {
    expect(formatLanes("11")).toBe("Lane 11");
  });

  it("dedupes and sorts whatever ordering the opener typed", () => {
    expect(formatLanes("4, 2, 3, 1, 2")).toBe("Lanes 1–4");
  });

  it("shows a non-numeric label verbatim rather than hiding it", () => {
    expect(formatLanes("VIP Suite")).toBe("Lane VIP Suite");
  });

  it("is null for nothing", () => {
    expect(formatLanes(null)).toBeNull();
    expect(formatLanes("")).toBeNull();
    expect(formatLanes("   ")).toBeNull();
  });
});

describe("formatResourceList", () => {
  it("folds a party's six lane lines into one range — the reported bug", () => {
    // Contract H3231 (Gartner) books one schedule line per lane; the board was
    // showing "Lane 5" because it read only the first (owner 2026-08-11).
    const lines = ["Lane 5", "Lane 6", "Lane 7", "Lane 8", "Lane 9", "Lane 10"];
    expect(formatResourceList(lines)).toBe("Lanes 5–10");
  });

  it("speaks gaps rather than pretending they are a run", () => {
    expect(formatResourceList(["Lane 5", "Lane 6", "Lane 9"])).toBe("Lanes 5–6 & 9");
    expect(formatResourceList(["Lane 1", "Lane 4"])).toBe("Lanes 1 & 4");
  });

  it("keeps a single lane singular", () => {
    expect(formatResourceList(["Lane 5"])).toBe("Lane 5");
  });

  it("handles resources with no number at all", () => {
    expect(formatResourceList(["HP Arena"])).toBe("HP Arena");
    expect(formatResourceList(["Laser Tag", "Laser Tag"])).toBe("Laser Tag");
  });

  it("keeps mixed bookings honest, in booking order", () => {
    expect(formatResourceList(["Lane 5", "Lane 6", "HP Arena"])).toBe("Lanes 5–6 · HP Arena");
    expect(formatResourceList(["HP Arena", "Lane 5"])).toBe("Lane 5 · HP Arena");
  });

  it("groups separate prefixes separately", () => {
    expect(formatResourceList(["Lane 1", "Lane 2", "Bay 3", "Bay 4"])).toBe("Lanes 1–2 · Bays 3–4");
  });

  it("de-duplicates repeated lanes", () => {
    expect(formatResourceList(["Lane 5", "Lane 5", "Lane 6"])).toBe("Lanes 5–6");
  });

  it("is null for nothing usable", () => {
    expect(formatResourceList([])).toBeNull();
    expect(formatResourceList([null, undefined, "   "])).toBeNull();
  });

  it("sorts out-of-order lines", () => {
    expect(formatResourceList(["Lane 10", "Lane 5", "Lane 7", "Lane 6", "Lane 9", "Lane 8"])).toBe(
      "Lanes 5–10",
    );
  });
});
