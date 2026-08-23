/**
 * Race Sims placeholder phase (2026-08): the pricing builder must PRICE a
 * racesim cart for the quote/review screens (placeholder catalog, no Square
 * catalog id) while reserve guard 2e keeps any charge fail-closed until real
 * ids exist. These tests pin the builder half; the guard's seam
 * (raceSimProductConfigured) is pinned in race-sims/products.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ default: {} }));

import { buildCombinedLineItems, quoteUnifiedSession } from "./unified-reserve";
import { emptySession, newItem, type BookingSession, type RaceSimItem } from "../state/types";

function simItem(patch: Partial<RaceSimItem> = {}): RaceSimItem {
  return {
    ...(newItem("racesim") as RaceSimItem),
    id: "rs1",
    date: "2026-08-23",
    productKind: "single",
    productSlug: "sim-single",
    trackKey: "a",
    racerCount: 2,
    assignedTo: ["m1", "m2"],
    ...patch,
  };
}

function simSession(items: BookingSession["items"]): BookingSession {
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    context: { kiosk: true },
    items,
  } as BookingSession;
}

describe("unified pricing — racesim placeholder cart", () => {
  it("prices a solo sim cart from the in-code catalog with NO catalog id", () => {
    const { sqLineItems, pricedLines, totalPriceCents } = buildCombinedLineItems(
      simSession([simItem()]),
    );
    expect(sqLineItems).toHaveLength(1);
    expect(sqLineItems[0].catalogObjectId).toBeUndefined();
    expect(sqLineItems[0].quantity).toBe("2");
    expect(sqLineItems[0].basePriceMoney?.amount).toBe(1499);
    expect(sqLineItems[0].name).toContain("Track A");
    expect(pricedLines).toHaveLength(1);
    expect(totalPriceCents).toBe(2998);
  });

  it("skips an unready draft (no product picked) instead of pricing $0", () => {
    const { sqLineItems, totalPriceCents } = buildCombinedLineItems(
      simSession([simItem({ productSlug: null })]),
    );
    expect(sqLineItems).toHaveLength(0);
    expect(totalPriceCents).toBe(0);
  });

  it("quote mirror carries the same money (pack SKU, 1 racer)", () => {
    const q = quoteUnifiedSession(
      simSession([simItem({ productSlug: "sim-3-pack", racerCount: 1 })]),
    );
    expect(q.subtotalCents).toBe(3999);
    expect(q.totalCents).toBe(q.subtotalCents + q.taxCents);
    expect(q.lines[0]?.name).toContain("3-Race Pack");
  });
});
