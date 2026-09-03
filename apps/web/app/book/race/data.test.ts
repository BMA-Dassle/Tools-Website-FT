import { describe, expect, it } from "vitest";
import { getStaticProducts } from "./data";

/**
 * getStaticProducts must resolve its schedule through the Mega calendar, not a
 * weekday literal. It kept its own inline `dow === 2` after the 2026-08-25
 * mega-calendar sweep replaced the other twelve hardcodings, so on the FIRST
 * Mega Thursday (2026-09-03) the kiosk tile check probed Blue/Red weekday
 * products — none of which have heats on a Mega day — and locked the racing
 * tile with Mega heats wide open (production outage, 2026-09-03).
 */
describe("getStaticProducts schedule resolution", () => {
  it("returns Mega products on a Mega Thursday (Sep–Oct 2026 season)", () => {
    for (const racerType of ["new", "existing"] as const) {
      const products = getStaticProducts("2026-09-03", racerType);
      expect(products.length).toBeGreaterThan(0);
      expect(products.every((p) => p.track === "Mega" || p.track === null)).toBe(true);
    }
  });

  it("returns weekday (Blue/Red) products on a Thursday after the season ends", () => {
    const products = getStaticProducts("2026-11-05", "new");
    expect(products.length).toBeGreaterThan(0);
    expect(products.some((p) => p.track === "Mega")).toBe(false);
  });

  it("still returns Mega products on the standing Mega Tuesday", () => {
    const products = getStaticProducts("2026-09-08", "new");
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => p.track === "Mega" || p.track === null)).toBe(true);
  });

  it("keeps the weekend schedule intact", () => {
    const products = getStaticProducts("2026-09-05", "new"); // Saturday
    expect(products.length).toBeGreaterThan(0);
    expect(products.some((p) => p.track === "Mega")).toBe(false);
  });
});
