import { describe, it, expect } from "vitest";
import { buildBowlingQuoteLineItems } from "./bowling";
import type { BowlingItem, BookingSession } from "../state/types";

// Minimal fixtures — buildBowlingQuoteLineItems only reads the fields below.
function bowlingItem(overrides: Partial<BowlingItem> = {}): BowlingItem {
  return {
    kind: "bowling",
    lineItems: [
      { label: "Duckpin", quantity: 1, priceCents: 1750, squareCatalogObjectId: "DUCKPIN_VAR" },
    ],
    hasBookingFee: true,
    bookedAt: "2026-07-23T18:15:00-04:00",
    ...overrides,
  } as unknown as BowlingItem;
}

const session = {} as unknown as BookingSession;

describe("buildBowlingQuoteLineItems — variably-priced catalog items", () => {
  it("ALWAYS attaches base_price_money to a catalog-linked line (no promo)", () => {
    // Regression: FastTrax duckpin's Square item is variably priced. Omitting
    // base_price_money made the /quote order 400 ("requires a value for
    // base_price_money"), which surfaced on the kiosk reader as "Bowling quote
    // missing". The catalog id must still ride along for Square reporting.
    const lines = buildBowlingQuoteLineItems(bowlingItem(), session);
    const duckpin = lines.find((l) => l.catalogObjectId === "DUCKPIN_VAR");
    expect(duckpin).toBeDefined();
    expect(duckpin!.basePriceMoney).toEqual({ amount: 1750, currency: "USD" });
  });

  it("sends the line's OWN price, not a static amount (per-duration)", () => {
    const at90 = bowlingItem({
      lineItems: [
        { label: "Duckpin", quantity: 1, priceCents: 4500, squareCatalogObjectId: "DUCKPIN_VAR" },
      ],
    } as unknown as Partial<BowlingItem>);
    const lines = buildBowlingQuoteLineItems(at90, session);
    const duckpin = lines.find((l) => l.catalogObjectId === "DUCKPIN_VAR");
    expect(duckpin!.basePriceMoney).toEqual({ amount: 4500, currency: "USD" });
  });

  it("keeps the catalog-priced Booking Fee line (no price override)", () => {
    const lines = buildBowlingQuoteLineItems(bowlingItem(), session);
    const fee = lines.find((l) => l.name === "Booking Fee");
    expect(fee).toBeDefined();
    expect(fee!.basePriceMoney).toBeUndefined();
    expect(fee!.catalogObjectId).toBeTruthy();
  });
});
