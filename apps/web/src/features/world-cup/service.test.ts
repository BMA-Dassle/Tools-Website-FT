import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorldCupReservationError,
  buildWorldCupLineItems,
  isWorldCupBowlingItem,
  validateWorldCupBooking,
  worldCupQamfBanner,
  worldCupQamfTitle,
} from "./service";
import { findFixture } from "./fixtures";

const ET = (s: string) => Date.parse(s);
// A safely-pre-kickoff "now" for validation calls.
const NOW = ET("2026-07-05T12:00:00-04:00");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isWorldCupBowlingItem", () => {
  it("keys off the experience slug prefix", () => {
    expect(isWorldCupBowlingItem({ experienceSlug: "world-cup-vip-mon-thur" })).toBe(true);
    expect(isWorldCupBowlingItem({ experienceSlug: "vip-mon-thur" })).toBe(false);
    expect(isWorldCupBowlingItem({ experienceSlug: null })).toBe(false);
    expect(isWorldCupBowlingItem({})).toBe(false);
  });
});

describe("validateWorldCupBooking", () => {
  it("accepts an exact upcoming kickoff at an enabled center", () => {
    const fixture = validateWorldCupBooking({
      center: "fort-myers",
      bookedAt: "2026-07-06T20:00:00-04:00",
      nowMs: NOW,
    });
    expect(fixture.id).toBe("r16-6");
  });

  it("accepts the QAMF numeric center id path", () => {
    const fixture = validateWorldCupBooking({
      centerQamfId: 9172,
      bookedAt: "2026-07-06T20:00:00-04:00",
      nowMs: NOW,
    });
    expect(fixture.id).toBe("r16-6");
  });

  it("fail-closes a disabled center (the per-center kill switch)", () => {
    vi.stubEnv("NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED", "false");
    expect(() =>
      validateWorldCupBooking({
        center: "naples",
        bookedAt: "2026-07-06T20:00:00-04:00",
        nowMs: NOW,
      }),
    ).toThrow(WorldCupReservationError);
    // Fort Myers stays sellable while Naples is dark.
    expect(
      validateWorldCupBooking({
        center: "fort-myers",
        bookedAt: "2026-07-06T20:00:00-04:00",
        nowMs: NOW,
      }).id,
    ).toBe("r16-6");
  });

  it("master switch kills every center", () => {
    vi.stubEnv("NEXT_PUBLIC_WORLD_CUP_VIP_ENABLED", "false");
    expect(() =>
      validateWorldCupBooking({
        center: "fort-myers",
        bookedAt: "2026-07-06T20:00:00-04:00",
        nowMs: NOW,
      }),
    ).toThrow(WorldCupReservationError);
  });

  it("fail-closes unknown/missing centers", () => {
    for (const center of [null, undefined, "cape-coral"] as const) {
      expect(() =>
        validateWorldCupBooking({
          center: center as string | null | undefined,
          bookedAt: "2026-07-06T20:00:00-04:00",
          nowMs: NOW,
        }),
      ).toThrow(WorldCupReservationError);
    }
    expect(() =>
      validateWorldCupBooking({
        centerQamfId: 1111,
        bookedAt: "2026-07-06T20:00:00-04:00",
        nowMs: NOW,
      }),
    ).toThrow(WorldCupReservationError);
  });

  it("rejects starts that aren't exactly a fixture kickoff", () => {
    for (const bookedAt of [
      "2026-07-06T20:15:00-04:00", // 15 past kickoff
      "2026-07-06T19:00:00-04:00", // wrong hour
      "2026-07-12T15:00:00-04:00", // off-day
      null,
      undefined,
    ]) {
      expect(() => validateWorldCupBooking({ center: "fort-myers", bookedAt, nowMs: NOW })).toThrow(
        WorldCupReservationError,
      );
    }
  });

  it("rejects a kickoff that has already passed", () => {
    expect(() =>
      validateWorldCupBooking({
        center: "fort-myers",
        bookedAt: "2026-07-04T13:00:00-04:00",
        nowMs: NOW,
      }),
    ).toThrow(WorldCupReservationError);
  });
});

describe("buildWorldCupLineItems (mirrors BowlingOfferStep.buildLineItems, hourly, no duration options)", () => {
  const usaBelgium = findFixture("r16-6")!;

  it("DEDICATED mode: one window line + chips, every item × laneCount, match on the primary label", () => {
    const lines = buildWorldCupLineItems(
      [
        {
          squareProductId: 101,
          quantity: 1,
          label: "World Cup VIP Match Window (Mon–Thur)",
          priceCents: 11250,
          depositPct: 100,
          squareCatalogObjectId: "WC_MON",
          sortOrder: 0,
        },
        {
          squareProductId: 102,
          quantity: 1,
          label: "VIP Chips & Salsa",
          priceCents: 0,
          depositPct: 100,
          squareCatalogObjectId: "LHZXWYO72N5QFX4CGYKRVPZX",
          sortOrder: 1,
        },
      ],
      3, // 13-18 bowlers
      usaBelgium,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].quantity).toBe(3);
    expect(lines[0].label).toBe("World Cup VIP Match Window (Mon–Thur) — USA vs Belgium");
    expect(lines[1].quantity).toBe(3); // chips & salsa: one per lane
    expect(lines[1].label).toBe("VIP Chips & Salsa"); // non-primary label untouched
    const total = lines.reduce((s, l) => s + l.priceCents * l.quantity, 0);
    expect(total).toBe(3 * 11250);
  });

  it("FALLBACK mode: 1.5-hr + 1-hr + chips rings the same per-lane window price", () => {
    const monThur = buildWorldCupLineItems(
      [
        {
          squareProductId: 1,
          quantity: 1,
          label: "1.5 Hr Mon-Thur VIP",
          priceCents: 6750,
          depositPct: 100,
          sortOrder: 0,
        },
        {
          squareProductId: 2,
          quantity: 1,
          label: "1 Hr Mon-Thur VIP",
          priceCents: 4500,
          depositPct: 100,
          sortOrder: 1,
        },
        {
          squareProductId: 3,
          quantity: 1,
          label: "VIP Chips & Salsa",
          priceCents: 0,
          depositPct: 100,
          sortOrder: 2,
        },
      ],
      2,
      usaBelgium,
    );
    expect(monThur.reduce((s, l) => s + l.priceCents * l.quantity, 0)).toBe(2 * 11250);
    expect(monThur[0].label).toBe("1.5 Hr Mon-Thur VIP — USA vs Belgium");

    const friSun = buildWorldCupLineItems(
      [
        {
          squareProductId: 4,
          quantity: 1,
          label: "1.5 Hr Fri-Sun VIP",
          priceCents: 8250,
          depositPct: 100,
          sortOrder: 0,
        },
        {
          squareProductId: 5,
          quantity: 1,
          label: "1 Hr Fri-Sun VIP",
          priceCents: 5500,
          depositPct: 100,
          sortOrder: 1,
        },
        {
          squareProductId: 6,
          quantity: 1,
          label: "VIP Chips & Salsa",
          priceCents: 0,
          depositPct: 100,
          sortOrder: 2,
        },
      ],
      1,
      findFixture("final")!,
    );
    expect(friSun.reduce((s, l) => s + l.priceCents * l.quantity, 0)).toBe(13750);
  });
});

describe("staff strings", () => {
  it("QAMF title carries the Futbal prefix (owner 7/6)", () => {
    expect(worldCupQamfTitle("Jane Doe", 12)).toBe("Futbal Jane Doe (12p)");
  });

  it("QAMF banner leads with the match", () => {
    expect(worldCupQamfBanner(findFixture("r16-6")!)).toBe(
      "*** WORLD CUP: USA vs Belgium — Mon, Jul 6 8 PM (2.5-hr window, paid online) ***",
    );
  });
});
