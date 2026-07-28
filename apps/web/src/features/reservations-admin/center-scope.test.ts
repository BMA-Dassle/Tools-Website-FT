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

  it("drops pure 'fort-myers' slug race rows (FastTrax racing)", () => {
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "race",
        bookingMetadata: { heats: [{ heatId: "2026-07-27T18:00:00" }] },
      }),
    ).toBe(false);
    // No metadata at all — unlike attractions, a race with no attraction legs
    // has nothing happening at HeadPinz.
    expect(belongsOnHeadpinzFmBoard({ centerCode: "fort-myers", productKind: "race" })).toBe(false);
  });

  it("keeps mixed race + HeadPinz attraction anchor rows (race kind, laser tag leg)", () => {
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "race",
        bookingMetadata: {
          heats: [{ heatId: "2026-07-27T18:00:00" }],
          attractions: [{ slug: "laser-tag", slot: "2026-07-27T19:00:00", qty: 4 }],
        },
      }),
    ).toBe(true);
  });

  it("drops race rows whose only attraction legs are FastTrax-owned", () => {
    expect(
      belongsOnHeadpinzFmBoard({
        centerCode: "fort-myers",
        productKind: "race",
        bookingMetadata: {
          heats: [{ heatId: "2026-07-27T18:00:00" }],
          attractions: [{ slug: "duck-pin", slot: "2026-07-27T19:00:00", qty: 2 }],
        },
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
