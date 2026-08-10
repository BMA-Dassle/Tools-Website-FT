import { describe, expect, it } from "vitest";
import type { BookingSession, RaceItem } from "~/features/booking";
import { RacePovStep } from "./RacePovStep";

const item = (over: Partial<RaceItem> = {}): RaceItem =>
  ({
    kind: "race",
    packageIdAdult: null,
    packageIdJunior: null,
    productIdAdult: null,
    productIdJunior: null,
    heats: [],
    povQuantity: 0,
    date: "2026-07-20",
    ...over,
  }) as unknown as RaceItem;

const session = (party: Array<{ id: string; category?: "adult" | "junior" }>): BookingSession =>
  ({ party }) as unknown as BookingSession;

const isVisible = RacePovStep.isVisible!;

describe("RacePovStep visibility — pure video upsell", () => {
  it("hidden with an empty party", () => {
    expect(isVisible(item(), session([]))).toBe(false);
  });

  it("visible for a plain non-packaged party (new or returning alike)", () => {
    expect(isVisible(item(), session([{ id: "a" }, { id: "b" }]))).toBe(true);
  });

  it("hidden when every category present is packaged (video already included)", () => {
    const it_ = item({
      packageIdAdult: "ultimate-qualifier-weekday",
      packageIdJunior: "ultimate-qualifier-weekday-junior",
    });
    const s = session([
      { id: "a", category: "adult" },
      { id: "j", category: "junior" },
    ]);
    expect(isVisible(it_, s)).toBe(false);
  });

  it("hidden for a single-category party whose category is packaged", () => {
    const it_ = item({ packageIdAdult: "rookie-pack-weekday" });
    expect(isVisible(it_, session([{ id: "a", category: "adult" }]))).toBe(false);
  });

  it("visible when only PART of the party is packaged — the uncovered side still gets the offer", () => {
    const it_ = item({ packageIdAdult: "ultimate-qualifier-weekday" });
    const s = session([
      { id: "a", category: "adult" },
      { id: "j", category: "junior" },
    ]);
    expect(isVisible(it_, s)).toBe(true);
  });
});
