import { describe, expect, it } from "vitest";
import {
  scaleQuantity,
  scaleTemplate,
  templateLinesFromQuote,
  templateSummary,
  usageLabel,
} from "./templates";
import type { QuoteTemplate } from "../contracts";

/**
 * Quote-template scaling — pure arithmetic, so it is tested as arithmetic.
 *
 * The rule, from PR1's own DDL comment:
 *   qty = per ? max(min ?? 1, ceil(guests / per)) : (min ?? 1)
 */

function template(lines: QuoteTemplate["lines"], baselineGuests = 20): QuoteTemplate {
  return {
    id: "1",
    name: "Party package",
    centre: null,
    baselineGuests,
    description: null,
    lines,
    uses: 0,
    createdBy: null,
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
  };
}

describe("scaleQuantity", () => {
  it("rounds UP — you cannot sell two thirds of a lane", () => {
    expect(scaleQuantity({ productId: "1", per: 6 }, 19)).toBe(4);
    expect(scaleQuantity({ productId: "1", per: 6 }, 18)).toBe(3);
    expect(scaleQuantity({ productId: "1", per: 4 }, 1)).toBe(1);
  });

  it("respects the floor when the party is small", () => {
    // "always at least two lanes", even for a party of five
    expect(scaleQuantity({ productId: "1", per: 6, min: 2 }, 5)).toBe(2);
    expect(scaleQuantity({ productId: "1", per: 6, min: 2 }, 30)).toBe(5);
  });

  it("a line with no `per` is flat, at `min` or one", () => {
    expect(scaleQuantity({ productId: "1" }, 60)).toBe(1);
    expect(scaleQuantity({ productId: "1", min: 3 }, 60)).toBe(3);
  });

  it("never divides by zero or goes negative on hand-edited JSON", () => {
    expect(scaleQuantity({ productId: "1", per: 0 }, 20)).toBe(1);
    expect(scaleQuantity({ productId: "1", per: -4 }, 20)).toBe(1);
    expect(scaleQuantity({ productId: "1", per: 6 }, -20)).toBe(1);
  });
});

describe("scaleTemplate", () => {
  it("scales a whole package to the party in front of you", () => {
    const t = template([
      { productId: "100", productName: "Lane", per: 6, min: 2 },
      { productId: "200", productName: "Pizza", per: 4 },
      { productId: "300", productName: "Room fee" },
    ]);

    expect(scaleTemplate(t, 22)).toEqual([
      { productId: "100", productName: "Lane", quantity: 4 },
      { productId: "200", productName: "Pizza", quantity: 6 },
      { productId: "300", productName: "Room fee", quantity: 1 },
    ]);
  });

  it("carries no price at all — that is the whole point", () => {
    const scaled = scaleTemplate(template([{ productId: "100", per: 6 }]), 12);
    expect(Object.keys(scaled[0])).toEqual(["productId", "productName", "quantity"]);
    // A price frozen into a package is last season's rate the day after the
    // catalogue moves; the builder always asks Office for the event's date.
    expect(JSON.stringify(scaled)).not.toMatch(/price|cents/i);
  });
});

describe("templateLinesFromQuote", () => {
  it("infers a per-head rule only when the quote actually scales", () => {
    const lines = templateLinesFromQuote(
      [
        { productId: "100", productName: "Lane", quantity: 4 },
        { productId: "300", productName: "Room fee", quantity: 1 },
      ],
      24,
    );
    expect(lines).toEqual([
      { productId: "100", productName: "Lane", per: 6, min: 1 },
      // One of something for a party of 24 is a FLAT line, not "one per 24".
      { productId: "300", productName: "Room fee", min: 1 },
    ]);
  });

  it("records a flat line rather than inventing a fractional rule", () => {
    const lines = templateLinesFromQuote(
      [{ productId: "200", productName: "Pizza", quantity: 7 }],
      20,
    );
    // 20 / 7 is not whole — a made-up `per` would scale wrongly on every
    // future quote, so it stays flat and the editor can see it plainly.
    expect(lines).toEqual([{ productId: "200", productName: "Pizza", min: 7 }]);
  });

  it("round-trips a scaled package back to the same shape", () => {
    const original = template([{ productId: "100", productName: "Lane", per: 6, min: 1 }], 24);
    const scaled = scaleTemplate(original, 24);
    expect(templateLinesFromQuote(scaled as never, 24)).toEqual(original.lines);
  });
});

describe("the copy that makes a stale package visible", () => {
  it("says never, once, or a count", () => {
    expect(usageLabel(0)).toBe("Never used");
    expect(usageLabel(1)).toBe("Used once");
    expect(usageLabel(34)).toBe("Used 34 times");
  });

  it("summarises a template by its size, not its price", () => {
    expect(templateSummary(template([{ productId: "1" }], 20))).toBe("1 line · 20 guests");
    expect(templateSummary(template([{ productId: "1" }, { productId: "2" }], 60))).toBe(
      "2 lines · 60 guests",
    );
  });
});
