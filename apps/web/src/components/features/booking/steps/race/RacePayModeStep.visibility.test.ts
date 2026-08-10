import { describe, expect, it } from "vitest";
import type { BookingSession, RaceItem } from "~/features/booking";
import { payModeStepVisible, RacePayModeStepAdult, RacePayModeStepJunior } from "./RacePayModeStep";
import { RaceProductStepAdult } from "./RaceProductStep";

const item = (over: Partial<RaceItem> = {}): RaceItem =>
  ({
    kind: "race",
    packageIdAdult: null,
    packageIdJunior: null,
    productIdAdult: null,
    productIdJunior: null,
    heats: [],
    povQuantity: 0,
    // A Wednesday — weekday schedule, so the weekday bundle variants apply.
    date: "2026-08-12",
    ...over,
  }) as unknown as RaceItem;

const session = (
  party: Array<{ id: string; category?: "adult" | "junior"; isNewRacer?: boolean }>,
  context: Record<string, unknown> = {},
): BookingSession =>
  ({
    party: party.map((m) => ({ isNewRacer: true, ...m })),
    items: [],
    context,
  }) as unknown as BookingSession;

const WEB = {};
const KIOSK = { kiosk: true as const };

describe("payModeStepVisible — the package page runs on web too (owner 2026-08-10)", () => {
  it("WEB: visible with a date, category racers and eligible bundles", () => {
    expect(payModeStepVisible(item(), session([{ id: "a" }], WEB), "adult")).toBe(true);
  });

  it("hidden without a date (web race-date step not done yet)", () => {
    expect(payModeStepVisible(item({ date: null }), session([{ id: "a" }], WEB), "adult")).toBe(
      false,
    );
  });

  it("hidden for a category with no racers", () => {
    expect(
      payModeStepVisible(item(), session([{ id: "a", category: "adult" }], WEB), "junior"),
    ).toBe(false);
    expect(RacePayModeStepJunior.isVisible!(item(), session([{ id: "a" }], WEB))).toBe(false);
  });

  it("KIOSK: unchanged — still visible under the same conditions", () => {
    expect(payModeStepVisible(item(), session([{ id: "a" }], KIOSK), "adult")).toBe(true);
  });

  it("adult step def mirrors the seam", () => {
    expect(RacePayModeStepAdult.isVisible!(item(), session([{ id: "a" }], WEB))).toBe(true);
  });
});

describe("product step defers to the pay-mode page on web", () => {
  it("hides once a bundle is chosen (the bundle owns the race)", () => {
    const chosen = item({ packageIdAdult: "ultimate-qualifier-weekday" });
    expect(RaceProductStepAdult.isVisible!(chosen, session([{ id: "a" }], WEB))).toBe(false);
  });

  it("shows when no bundle is chosen (single-race path, page 2 is the tier list)", () => {
    expect(RaceProductStepAdult.isVisible!(item(), session([{ id: "a" }], WEB))).toBe(true);
  });
});
