import { describe, expect, it } from "vitest";

import { belongsOnHeadpinzFmBoard } from "./center-scope";

describe("belongsOnHeadpinzFmBoard", () => {
  it("keeps native HPFM rows (Square location ID center_code)", () => {
    expect(belongsOnHeadpinzFmBoard({ centerCode: "TXBSQN0FEKQ11", productKind: "open" })).toBe(
      true,
    );
    expect(belongsOnHeadpinzFmBoard({ centerCode: "TXBSQN0FEKQ11", productKind: "kbf" })).toBe(
      true,
    );
  });

  it("drops 'fort-myers' slug race rows (FastTrax racing)", () => {
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "race",
        bookingMetadata: { heats: [{ heatId: "2026-07-27T18:00:00" }] },
      }),
    ).toBe(false);
  });

  it("keeps HeadPinz attractions under the 'fort-myers' slug (laser tag)", () => {
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "attraction",
        bookingMetadata: {
          attractions: [{ slug: "laser-tag", slot: "2026-07-27T18:00:00", qty: 4 }],
        },
      }),
    ).toBe(true);
  });

  it("drops attractions where EVERY slug is FastTrax-owned (duck-pin)", () => {
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "attraction",
        bookingMetadata: {
          attractions: [{ slug: "duck-pin", slot: "2026-07-27T18:00:00", qty: 2 }],
        },
      }),
    ).toBe(false);
  });

  it("keeps mixed carts with at least one HeadPinz attraction", () => {
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "attraction",
        bookingMetadata: {
          attractions: [
            { slug: "duck-pin", slot: "2026-07-27T18:00:00", qty: 2 },
            { slug: "gel-blaster", slot: "2026-07-27T19:00:00", qty: 2 },
          ],
        },
      }),
    ).toBe(true);
  });

  it("keeps attraction rows with missing/empty slug metadata (visible beats invisible)", () => {
    expect(belongsOnHeadpinzFmBoard({ centerCode: "fort-myers", productKind: "attraction" })).toBe(
      true,
    );
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "attraction",
        bookingMetadata: { attractions: [] },
      }),
    ).toBe(true);
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "attraction",
        bookingMetadata: { attractions: "corrupt" },
      }),
    ).toBe(true);
  });
});
