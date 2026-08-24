/**
 * Race Sims pricing rail: the builder must PRICE a sim cart for the
 * quote/review screens — day-of-week rate ($14 Mon–Thu / $16 Fri–Sun),
 * the shared Square catalog id on the line, track riding the name — while
 * reserve guard 2e keeps any charge fail-closed until the BMI track keys
 * are armed (that seam is pinned in race-sims/products.test.ts).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ default: {} }));

import { buildCombinedLineItems, quoteUnifiedSession } from "./unified-reserve";
import { emptySession, newItem, type BookingSession, type RaceSimItem } from "../state/types";
import { RACE_SIM_SQUARE_CATALOG_ID } from "~/features/race-sims/products";

function simItem(patch: Partial<RaceSimItem> = {}): RaceSimItem {
  return {
    ...(newItem("racesim") as RaceSimItem),
    id: "rs1",
    date: "2026-08-24", // Monday → weekday rate
    productKind: "single",
    productSlug: "sim-single",
    trackKey: "a",
    racerCount: 2,
    slot: "2026-08-24T15:00:00",
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

describe("unified pricing — racesim cart", () => {
  it("prices a weekday cart at $14/racer on the shared Square catalog id", () => {
    const { sqLineItems, pricedLines, totalPriceCents } = buildCombinedLineItems(
      simSession([simItem()]),
    );
    expect(sqLineItems).toHaveLength(1);
    expect(sqLineItems[0].catalogObjectId).toBe(RACE_SIM_SQUARE_CATALOG_ID);
    expect(sqLineItems[0].quantity).toBe("2");
    expect(sqLineItems[0].basePriceMoney?.amount).toBe(1400);
    expect(sqLineItems[0].name).toContain("Track A");
    expect(pricedLines).toHaveLength(1);
    expect(totalPriceCents).toBe(2800);
  });

  it("prices a weekend date at $16/racer (Fri–Sun)", () => {
    const { sqLineItems } = buildCombinedLineItems(
      simSession([simItem({ date: "2026-08-29", slot: "2026-08-29T15:00:00" })]),
    );
    expect(sqLineItems[0].basePriceMoney?.amount).toBe(1600);
  });

  it("skips an unready draft (no product picked) instead of pricing $0", () => {
    const { sqLineItems, totalPriceCents } = buildCombinedLineItems(
      simSession([simItem({ productSlug: null })]),
    );
    expect(sqLineItems).toHaveLength(0);
    expect(totalPriceCents).toBe(0);
  });

  it("quote mirror carries the same money (weekday single, 1 racer)", () => {
    const q = quoteUnifiedSession(simSession([simItem({ racerCount: 1 })]));
    expect(q.subtotalCents).toBe(1400);
    expect(q.totalCents).toBe(q.subtotalCents + q.taxCents);
    expect(q.lines[0]?.name).toContain("1 Race");
  });
});
