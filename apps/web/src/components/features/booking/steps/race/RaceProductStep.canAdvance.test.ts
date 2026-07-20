import { describe, expect, it } from "vitest";
import type { BookingSession, RaceItem } from "~/features/booking";
import { RaceProductStepAdult, RaceProductStepJunior } from "./RaceProductStep";

const item = (over: Partial<RaceItem> = {}): RaceItem =>
  ({
    kind: "race",
    packageIdAdult: null,
    packageIdJunior: null,
    productIdAdult: null,
    productIdJunior: null,
    heats: [],
    date: "2026-07-20",
    ...over,
  }) as unknown as RaceItem;

const session = (party: Array<{ id: string; category?: "adult" | "junior" }>): BookingSession =>
  ({ party }) as unknown as BookingSession;

const ADULTS = session([{ id: "m1", category: "adult" }]);
const JUNIORS = session([{ id: "j1", category: "junior" }]);

describe("race product step canAdvance", () => {
  it("blocks with the generic hint when nothing is picked", () => {
    expect(RaceProductStepAdult.canAdvance(item(), ADULTS)).toEqual({
      reason: "Pick an adult race to continue.",
    });
  });

  it("blocks with the pack-aware hint when a credit pack is in the cart", () => {
    const it_ = item({ creditPacks: [{ slug: "3-race-anytime", memberId: "m1" }] });
    expect(RaceProductStepAdult.canAdvance(it_, ADULTS)).toEqual({
      reason: "Race pack added — now pick which race to run today.",
    });
    expect(RaceProductStepJunior.canAdvance(it_, JUNIORS)).toEqual({
      reason: "Race pack added — now pick which race to run today.",
    });
  });

  it("advances once a race, a package, or an added heat exists", () => {
    const withPack = item({ creditPacks: [{ slug: "3-race-anytime", memberId: "m1" }] });
    expect(
      RaceProductStepAdult.canAdvance(item({ ...withPack, productIdAdult: "43046468" }), ADULTS),
    ).toBe(true);
    expect(
      RaceProductStepAdult.canAdvance(item({ packageIdAdult: "rookie-pack-weekday" }), ADULTS),
    ).toBe(true);
    expect(
      RaceProductStepAdult.canAdvance(
        item({
          heats: [
            {
              productId: "43046468",
              track: "Blue",
              heatId: "h1",
              bmiLineId: null,
              assignedTo: "m1",
            },
          ],
        }),
        ADULTS,
      ),
    ).toBe(true);
  });
});
