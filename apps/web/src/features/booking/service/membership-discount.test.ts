import { describe, it, expect } from "vitest";
import {
  MEMBERSHIP_DISCOUNTS,
  activeMembershipDiscounts,
  membershipDiscountsForNames,
  applyMembershipDiscounts,
  bestPercentOffForCategory,
} from "./membership-discounts";
import { buildRaceChargeLines } from "./checkout";
import {
  emptySession,
  type RaceItem,
  type PartyMember,
  type RaceHeatAssignment,
} from "../state/types";

// adult "existing" Starter Race Mega, $20.99 (same id the credit-redeem test uses).
const MEGA = "43734407";
const PRICE = 20.99;

function member(id: string, over: Partial<PartyMember> = {}): PartyMember {
  return { id, firstName: id, isNewRacer: false, category: "adult", ...over };
}
function heat(heatId: string, assignedTo: string): RaceHeatAssignment {
  return {
    productId: MEGA,
    track: "Mega",
    tier: "starter",
    category: "adult",
    heatId,
    bmiLineId: null,
    assignedTo,
  };
}
function raceItem(over: Partial<RaceItem> = {}): RaceItem {
  return {
    id: "race-1",
    kind: "race",
    date: "2026-06-09",
    productIdAdult: MEGA,
    productIdJunior: null,
    productTrackAdult: "Mega",
    productTrackJunior: null,
    heats: [],
    packageId: null,
    povQuantity: 0,
    addons: [],
    rookiePack: null,
    ...over,
  };
}

describe("membership-discounts config + resolvers", () => {
  it("detects Employee Pass (50%, racing/gel/laser) and League Racer (20%, racing) by name", () => {
    const emp = membershipDiscountsForNames(["Employee Pass"]);
    expect(emp.map((d) => d.key)).toContain("employee-pass");
    expect(bestPercentOffForCategory(emp, "racing")).toBe(50);
    expect(bestPercentOffForCategory(emp, "laser-tag")).toBe(50);

    const league = membershipDiscountsForNames(["League Racer"]);
    expect(league.map((d) => d.key)).toContain("league-racer");
    expect(bestPercentOffForCategory(league, "racing")).toBe(20);
    expect(bestPercentOffForCategory(league, "gel-blasters")).toBe(0); // league = racing only

    expect(membershipDiscountsForNames(["Default", "Testing"])).toEqual([]);
  });

  it("activeMembershipDiscounts honors the active window", () => {
    const now = "2026-06-09T12:00:00";
    const active = activeMembershipDiscounts(
      [
        {
          membershipKindId: "12754847",
          name: "Employee Pass",
          starts: "2026-04-04",
          stops: "2027-04-04",
        },
      ],
      now,
    );
    expect(active.map((d) => d.key)).toContain("employee-pass");
    const expired = activeMembershipDiscounts(
      [{ name: "Employee Pass", starts: "2025-09-08", stops: "2026-01-20" }],
      now,
    );
    expect(expired).toEqual([]);
  });

  it("applyMembershipDiscounts halves a racing line for Employee Pass, leaves others", () => {
    const emp = MEMBERSHIP_DISCOUNTS.filter((d) => d.key === "employee-pass");
    const out = applyMembershipDiscounts(
      [
        { name: "Race", basePriceCents: 2099, category: "racing" },
        { name: "Booking Fee", basePriceCents: 299, category: null },
      ],
      emp,
    );
    expect(out[0].newBasePriceCents).toBe(1050); // round(2099 * 0.5)
    expect(out[0].percentOff).toBe(50);
    expect(out[1].newBasePriceCents).toBe(299); // untouched
  });
});

describe("buildRaceChargeLines — per-racer membership discount", () => {
  it("discounts ONLY the Employee Pass holder's heat; others pay full", () => {
    const eric = member("eric", { bmiPersonId: "409523", memberships: ["Employee Pass"] });
    const friend = member("friend", { bmiPersonId: "222" });
    const item = raceItem({
      heats: [heat("2026-06-09T13:36:00", "eric"), heat("2026-06-09T14:12:00", "friend")],
    });
    const session = {
      ...emptySession({ entryBrand: "fasttrax" }),
      items: [item],
      party: [eric, friend],
    };

    const lines = buildRaceChargeLines(session);
    const full = lines.find((l) => !l.membershipDiscountPct && l.bmiProductId === MEGA);
    const disc = lines.find((l) => l.membershipDiscountPct === 50);
    expect(full?.amount).toBeCloseTo(PRICE, 2); // friend, full
    expect(disc?.amount).toBeCloseTo(10.5, 2); // eric, 50% off (round2(10.495) = 10.50)
    expect(disc?.name).toMatch(/Employee Pass/);
  });

  it("League Racer gets 20% off racing", () => {
    const racer = member("lr", { bmiPersonId: "333", memberships: ["League Racer"] });
    const item = raceItem({ heats: [heat("2026-06-09T13:36:00", "lr")] });
    const session = { ...emptySession({ entryBrand: "fasttrax" }), items: [item], party: [racer] };
    const disc = buildRaceChargeLines(session).find((l) => l.membershipDiscountPct === 20);
    expect(disc?.amount).toBeCloseTo(PRICE * 0.8, 2);
  });

  it("a credit-redeeming member is NOT discounted (stays on the full-price line for credit redemption)", () => {
    const eric = member("eric", {
      bmiPersonId: "409523",
      memberships: ["Employee Pass"],
      redeemCredits: true,
    });
    const item = raceItem({ heats: [heat("2026-06-09T13:36:00", "eric")] });
    const session = { ...emptySession({ entryBrand: "fasttrax" }), items: [item], party: [eric] };
    const lines = buildRaceChargeLines(session);
    expect(lines.some((l) => l.membershipDiscountPct)).toBe(false);
    expect(lines.find((l) => l.bmiProductId === MEGA)?.amount).toBeCloseTo(PRICE, 2);
  });
});
