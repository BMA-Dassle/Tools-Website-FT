import { afterEach, describe, expect, it } from "vitest";
import {
  addonChargeLines,
  addonPurchaseIntents,
  estimateAddonsTotal,
  resolveAddonSelections,
} from "./addon-charge";
import { applyPromoToBillLines } from "./promo-pricing";
import type { BookingSession, RaceItem } from "../state/types";

const FLAG = "NEXT_PUBLIC_BOOKING_ADDONS_ENABLED";
afterEach(() => {
  delete process.env[FLAG];
});

function raceItem(over: Partial<RaceItem> = {}): RaceItem {
  return {
    id: "r1",
    kind: "race",
    date: "2026-08-15",
    productIdAdult: null,
    productIdJunior: null,
    productTrackAdult: null,
    productTrackJunior: null,
    heats: [],
    packageIdAdult: null,
    packageIdJunior: null,
    povQuantity: 0,
    addons: [],
    ...over,
  } as RaceItem;
}

function sessionWith(
  items: RaceItem[],
  party: Array<{ id: string; firstName: string; lastName?: string; bmiPersonId?: string }>,
): BookingSession {
  return {
    items,
    party: party.map((m) => ({ isNewRacer: false, ...m })),
  } as unknown as BookingSession;
}

const sel = (memberIds: string[]) => [{ slug: "headsock", memberIds }];

describe("addonChargeLines", () => {
  it("one $3 line PER selected racer, named with the racer", () => {
    const s = sessionWith(
      [raceItem({ addonSelections: sel(["a", "b"]) })],
      [
        { id: "a", firstName: "Dana", lastName: "Ng" },
        { id: "b", firstName: "Leo" },
      ],
    );
    const lines = addonChargeLines(s);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      name: "Replacement Headsock · Dana Ng",
      quantity: 1,
      amount: 3,
      bmiProductId: "addon-headsock",
    });
    expect(lines[1].name).toBe("Replacement Headsock · Leo");
  });

  it("promo-immune: lines carry no domain/visitDate so applyPromoToBillLines never discounts them", () => {
    const s = sessionWith(
      [raceItem({ addonSelections: sel(["a"]) })],
      [{ id: "a", firstName: "Dana" }],
    );
    const lines = addonChargeLines(s);
    expect(lines[0].domain).toBeUndefined();
    expect(lines[0].visitDate).toBeUndefined();
    const promoed = applyPromoToBillLines(lines, {
      code: "USA250",
      percentOff: 25,
      domains: ["racing"],
    } as never);
    expect(promoed[0].amount).toBe(3);
    expect(promoed[0].originalAmount).toBeUndefined();
  });

  it("members no longer in the party drop; unknown slugs drop", () => {
    const s = sessionWith(
      [
        raceItem({
          addonSelections: [
            { slug: "headsock", memberIds: ["a", "ghost"] },
            { slug: "not-a-real-addon", memberIds: ["a"] },
          ],
        }),
      ],
      [{ id: "a", firstName: "Dana" }],
    );
    const lines = addonChargeLines(s);
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toContain("Dana");
  });

  it("dedupes one racer across multiple race items — never double-charged", () => {
    const s = sessionWith(
      [
        raceItem({ id: "r1", addonSelections: sel(["a"]) }),
        raceItem({ id: "r2", addonSelections: sel(["a", "b"]) }),
      ],
      [
        { id: "a", firstName: "Dana" },
        { id: "b", firstName: "Leo" },
      ],
    );
    expect(addonChargeLines(s)).toHaveLength(2);
  });

  it("kill switch OFF → no lines regardless of selections", () => {
    process.env[FLAG] = "false";
    const s = sessionWith(
      [raceItem({ addonSelections: sel(["a"]) })],
      [{ id: "a", firstName: "Dana" }],
    );
    expect(addonChargeLines(s)).toHaveLength(0);
  });

  it("legacy BMI add-ons rail (addons qty>0) suppresses retail lines — that item never charges via buildRaceChargeLines", () => {
    const s = sessionWith(
      [
        raceItem({
          addonSelections: sel(["a"]),
          addons: [{ id: "27488020", qty: 1, selectedTime: null, bmiLineId: null }],
        } as unknown as Partial<RaceItem>),
      ],
      [{ id: "a", firstName: "Dana" }],
    );
    expect(addonChargeLines(s)).toHaveLength(0);
  });
});

describe("estimateAddonsTotal ≡ addonChargeLines (displayed == charged)", () => {
  it("single item: estimate equals the summed charge lines", () => {
    const item = raceItem({ addonSelections: sel(["a", "b"]) });
    const s = sessionWith(
      [item],
      [
        { id: "a", firstName: "Dana" },
        { id: "b", firstName: "Leo" },
      ],
    );
    const chargeTotal = addonChargeLines(s).reduce((t, l) => t + l.amount, 0);
    expect(estimateAddonsTotal(item, s)).toBe(chargeTotal);
    expect(estimateAddonsTotal(item, s)).toBe(6);
  });

  it("flag off: estimate is 0, matching the empty charge lines", () => {
    process.env[FLAG] = "false";
    const item = raceItem({ addonSelections: sel(["a"]) });
    const s = sessionWith([item], [{ id: "a", firstName: "Dana" }]);
    expect(estimateAddonsTotal(item, s)).toBe(0);
  });
});

describe("addonPurchaseIntents", () => {
  it("one intent per (addon, racer) with person id when known, null when new", () => {
    const s = sessionWith(
      [raceItem({ addonSelections: sel(["a", "b"]) })],
      [
        { id: "a", firstName: "Dana", lastName: "Ng", bmiPersonId: "16045822052840512" },
        { id: "b", firstName: "Leo" }, // brand-new racer — no BMI person yet
      ],
    );
    const intents = addonPurchaseIntents(s);
    expect(intents).toHaveLength(2);
    expect(intents[0]).toMatchObject({
      memberId: "a",
      addonSlug: "headsock",
      personId: "16045822052840512", // raw string — precision preserved
      memberName: "Dana Ng",
      depositKindId: "48069703",
      grantAmount: 1,
      priceCents: 300,
    });
    expect(intents[1].personId).toBeNull();
  });

  it("intents come from the same walk as the charge lines — same count, same racers", () => {
    const s = sessionWith(
      [
        raceItem({ id: "r1", addonSelections: sel(["a"]) }),
        raceItem({ id: "r2", addonSelections: sel(["a"]) }), // duplicate — must dedupe
      ],
      [{ id: "a", firstName: "Dana" }],
    );
    expect(addonPurchaseIntents(s)).toHaveLength(addonChargeLines(s).length);
  });
});

describe("resolveAddonSelections", () => {
  it("orders memberIds by party order for stable Square idempotency bodies", () => {
    const s = sessionWith(
      [raceItem({ addonSelections: [{ slug: "headsock", memberIds: ["c", "a", "b"] }] })],
      [
        { id: "a", firstName: "A" },
        { id: "b", firstName: "B" },
        { id: "c", firstName: "C" },
      ],
    );
    expect(resolveAddonSelections(s)[0].memberIds).toEqual(["a", "b", "c"]);
  });
});
