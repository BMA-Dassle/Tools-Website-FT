import { afterEach, describe, expect, it } from "vitest";
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

const FLAG = "NEXT_PUBLIC_BOOKING_ADDONS_ENABLED";
afterEach(() => {
  delete process.env[FLAG];
});

describe("RacePovStep visibility — video + retail extras", () => {
  it("hidden with an empty party (even with add-ons enabled)", () => {
    expect(isVisible(item(), session([]))).toBe(false);
  });

  it("visible for a plain non-packaged party (new or returning alike)", () => {
    expect(isVisible(item(), session([{ id: "a" }, { id: "b" }]))).toBe(true);
  });

  it("STAYS visible when every category is packaged — the headsock add-on keeps the step alive", () => {
    // The headline 2026-08-10 change: a fully-packaged party used to skip this
    // step entirely; now it sees the extras (the POV CARD still hides — that's
    // component behavior, not step visibility).
    const it_ = item({
      packageIdAdult: "ultimate-qualifier-weekday",
      packageIdJunior: "ultimate-qualifier-weekday-junior",
    });
    const s = session([
      { id: "a", category: "adult" },
      { id: "j", category: "junior" },
    ]);
    expect(isVisible(it_, s)).toBe(true);
  });

  it("kill switch OFF restores the old rule: fully packaged party skips the step", () => {
    process.env[FLAG] = "false";
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

  it("kill switch OFF: single packaged category still hides the step", () => {
    process.env[FLAG] = "false";
    const it_ = item({ packageIdAdult: "rookie-pack-weekday" });
    expect(isVisible(it_, session([{ id: "a", category: "adult" }]))).toBe(false);
  });

  it("kill switch OFF: plain party keeps the plain video step", () => {
    process.env[FLAG] = "false";
    expect(isVisible(item(), session([{ id: "a" }]))).toBe(true);
  });

  it("visible when only PART of the party is packaged — the uncovered side still gets the offer", () => {
    const it_ = item({ packageIdAdult: "ultimate-qualifier-weekday" });
    const s = session([
      { id: "a", category: "adult" },
      { id: "j", category: "junior" },
    ]);
    expect(isVisible(it_, s)).toBe(true);
  });

  it("legacy BMI add-ons rail (addons qty>0) suppresses the retail extras — flag-off equivalence", () => {
    // Items on the legacy BMI-priced rail never run buildRaceChargeLines, so
    // offerableAddons returns [] for them — with a fully-packaged party the
    // step must hide exactly as it did pre-extras.
    const it_ = item({
      packageIdAdult: "ultimate-qualifier-weekday",
      addons: [{ id: "27488020", qty: 1, selectedTime: null, bmiLineId: null }],
    } as unknown as Partial<RaceItem>);
    expect(isVisible(it_, session([{ id: "a", category: "adult" }]))).toBe(false);
  });
});
