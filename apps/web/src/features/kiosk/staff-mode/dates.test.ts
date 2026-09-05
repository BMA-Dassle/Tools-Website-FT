import { describe, expect, it } from "vitest";
import { endOfDay, formatMdy, parseMdy } from "./dates";

describe("staff-mode dates", () => {
  it("round-trips MM/DD/YYYY at local midnight", () => {
    const d = parseMdy("09/04/2026")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(0);
    expect(formatMdy(d)).toBe("09/04/2026");
    expect(formatMdy(parseMdy("9/4/2026")!)).toBe("09/04/2026");
  });

  it("rejects impossible and malformed dates", () => {
    expect(parseMdy("02/30/2026")).toBeNull();
    expect(parseMdy("13/01/2026")).toBeNull();
    expect(parseMdy("2026-09-04")).toBeNull();
    expect(parseMdy("09/04/26")).toBeNull();
    expect(parseMdy("")).toBeNull();
  });

  it("endOfDay is the last millisecond of that calendar day", () => {
    const e = endOfDay(parseMdy("09/04/2027")!);
    expect(e.getDate()).toBe(4);
    expect(e.getHours()).toBe(23);
    expect(e.getMinutes()).toBe(59);
    expect(e.getMilliseconds()).toBe(999);
  });
});
