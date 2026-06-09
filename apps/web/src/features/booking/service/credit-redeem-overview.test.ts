import { describe, it, expect } from "vitest";
import {
  applyCreditRedemptionsToOverview,
  buildRaceChargeLines,
  type BillOverview,
} from "./checkout";
import { redemptionsFromSession } from "../data/race-credits";
import { calculateTax } from "./race-pricing";
import {
  emptySession,
  type RaceItem,
  type PartyMember,
  type RaceHeatAssignment,
} from "../state/types";

// Real registry id: adult "existing" Starter Race Mega, $20.99, $0 build pair
// "adult:starter:Mega" exists → zero-model line carries bmiProductId.
const MEGA = "43734407";
const WEEKDAY_KIND = "12744867"; // Weekday Race Credit deposit-kind id

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
    date: "2026-06-09", // Tuesday — weekday, so the Weekday credit is eligible
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

describe("applyCreditRedemptionsToOverview — partial credit reduces the charge", () => {
  it("zeroes the redeemed heats (repro of the screenshot: Eric 2 weekday credits, 3 Mega heats + 1 new racer)", () => {
    const eric = member("eric", {
      bmiPersonId: "111",
      creditBalances: [{ kind: "Credit - Race Weekday", balance: 2 }],
      redeemCreditKindId: WEEKDAY_KIND,
    });
    const newRacer = member("test", { bmiPersonId: undefined, isNewRacer: true });

    const item = raceItem({
      heats: [
        heat("2026-06-09T13:36:00", "eric"),
        heat("2026-06-09T14:12:00", "eric"),
        heat("2026-06-09T14:36:00", "eric"),
        heat("2026-06-09T14:36:00", "test"),
      ],
    });
    const session = {
      ...emptySession({ entryBrand: "fasttrax" }),
      items: [item],
      party: [eric, newRacer],
    };

    // Eric has 2 credits but 3 heats → exactly 2 redemptions (capped).
    const redemptions = redemptionsFromSession(session);
    expect(redemptions.length).toBe(2);

    const lines = buildRaceChargeLines(session);
    const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const base: BillOverview = {
      lines,
      subtotal,
      tax: calculateTax(subtotal),
      total: subtotal,
      cashOwed: subtotal,
      creditApplied: 0,
      isCreditOrder: false,
    };
    // base = 4 Mega heats ($83.96) + license ($4.99) = $88.95
    expect(base.subtotal).toBeCloseTo(4 * 20.99 + 4.99, 2);

    const applied = applyCreditRedemptionsToOverview(base, session);
    // 2 heats redeemed ($0), 2 heats + license charged = $46.97
    expect(applied.creditApplied).toBe(2);
    expect(applied.subtotal).toBeCloseTo(2 * 20.99 + 4.99, 2);
    expect(applied.subtotal).toBeLessThan(base.subtotal);
  });

  it("still applies the credit when the charge line's product id differs from the heats' (new vs existing Mega)", () => {
    // Repro of the live bug: the charge line is keyed by item.productIdAdult
    // (existing Mega 43734407) while the heats were picked under the new-Mega id
    // (24965505). The credit redemption is keyed off the heats' productId, so it
    // must still reduce the charge — not show "-2 credits" yet charge full.
    const NEW_MEGA = "24965505"; // new-racer Starter Mega (same race, different id)
    const eric = member("eric", {
      bmiPersonId: "111",
      creditBalances: [{ kind: "Credit - Race Weekday", balance: 2 }],
      redeemCreditKindId: WEEKDAY_KIND,
    });
    const item = raceItem({
      productIdAdult: MEGA, // charge line uses existing Mega
      heats: [
        { ...heat("2026-06-09T13:36:00", "eric"), productId: NEW_MEGA },
        { ...heat("2026-06-09T14:12:00", "eric"), productId: NEW_MEGA },
        { ...heat("2026-06-09T14:36:00", "eric"), productId: NEW_MEGA },
      ],
    });
    const session = { ...emptySession({ entryBrand: "fasttrax" }), items: [item], party: [eric] };

    const lines = buildRaceChargeLines(session);
    const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const base: BillOverview = {
      lines,
      subtotal,
      tax: calculateTax(subtotal),
      total: subtotal,
      cashOwed: subtotal,
      creditApplied: 0,
      isCreditOrder: false,
    };
    const applied = applyCreditRedemptionsToOverview(base, session);
    expect(applied.creditApplied).toBe(2);
    // The 2 redeemed heats MUST come off the charge — this is the bug if it fails.
    expect(applied.subtotal).toBeLessThan(base.subtotal);
    expect(applied.subtotal).toBeCloseTo(1 * 20.99, 2);
  });
});
