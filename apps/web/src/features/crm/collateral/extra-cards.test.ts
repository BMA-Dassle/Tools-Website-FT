import { describe, expect, it } from "vitest";
import {
  COLLATERAL_EXTRA_CARDS,
  COLLATERAL_EXTRA_CARD_IDS,
  shippedExtraCards,
} from "./extra-cards";

/**
 * The slot registry exists so C5 can put its quote-templates card on THIS
 * screen with a one-line change, the way a feature PR replaces one line of
 * `core/screens.ts`. Two things have to hold for that promise to be real:
 *
 *   every id has an entry   otherwise C5 ADDS a key, which is exactly the
 *                           merge conflict the pre-populated pattern exists to
 *                           avoid;
 *   null renders nothing    a placeholder card for a feature that has not
 *                           shipped teaches reps to ignore the screen, and a
 *                           flip that silently keeps showing the placeholder
 *                           would be indistinguishable from not flipping it.
 */

describe("COLLATERAL_EXTRA_CARDS", () => {
  it("has exactly one entry per declared slot, and no extras", () => {
    expect(Object.keys(COLLATERAL_EXTRA_CARDS).sort()).toEqual(
      [...COLLATERAL_EXTRA_CARD_IDS].sort(),
    );
  });

  it("declares the quote-templates slot the prototype renders (crm-shared.js:484)", () => {
    expect(COLLATERAL_EXTRA_CARD_IDS).toContain("quote-templates");
  });

  it("ships nothing today — C5 owns the only card, so the screen renders no slot", () => {
    expect(COLLATERAL_EXTRA_CARDS["quote-templates"]).toBeNull();
    expect(shippedExtraCards()).toEqual([]);
  });

  /**
   * The flip is driven through the REGISTRY ITSELF and read back through
   * `shippedExtraCards()` — the same function `CollateralScreen` builds its
   * slot list from. An earlier version of this test re-implemented the lookup
   * inline, so it would have passed even if the helper had stopped working.
   */
  it("surfaces a slot the moment its line is flipped, in declaration order", () => {
    const before = COLLATERAL_EXTRA_CARDS["quote-templates"];
    const load = () => Promise.resolve({ default: () => null });
    try {
      COLLATERAL_EXTRA_CARDS["quote-templates"] = load;
      expect(shippedExtraCards()).toEqual([{ id: "quote-templates", load }]);
    } finally {
      COLLATERAL_EXTRA_CARDS["quote-templates"] = before;
    }
    expect(shippedExtraCards()).toEqual([]);
  });
});
