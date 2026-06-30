import { describe, expect, it } from "vitest";

import { getComboSpecial } from "~/features/combos";

import { buildAddOnQuote, addonOrderGroups } from "./pricing";
import { lanePlan, seatsOnExistingLanes, checkAddOnCapacity } from "./capacity";
import type { AddOnContext } from "./types";

// June 2026: 1st = Monday (weekday), 6th = Saturday (weekend).
const MON = "2026-06-01";
const SAT = "2026-06-06";

const combo = getComboSpecial("race-bowl")!;

function ctx(over: Partial<AddOnContext> = {}): AddOnContext {
  return {
    comboSpecialId: "race-bowl",
    originalBillId: "12345678901234567",
    clientKey: "headpinzftmyers",
    center: "fort-myers",
    eventDate: MON,
    raceLegs: [
      { tier: "starter", productId: "24960859", track: "Red", heatStart: "2026-06-01T14:00:00Z" },
      {
        tier: "intermediate",
        productId: "24960860",
        track: "Red",
        heatStart: "2026-06-01T15:00:00Z",
      },
    ],
    bowling: {
      qamfReservationId: "res-1",
      qamfCenterId: 9172,
      bookedAt: "2026-06-01T14:45:00Z",
      webOfferId: 100,
      optionId: 5,
      optionType: "Time",
      durationMinutes: 90,
      laneCount: 1,
      playerCount: 4,
      lane: "12",
    },
    contact: { firstName: "Test", lastName: "Guest", email: "t@e.com", phone: "2390000000" },
    ...over,
  };
}

describe("add-on pricing", () => {
  it("charges the flat per-person combo price (weekday)", () => {
    const q = buildAddOnQuote(combo, MON, 2);
    expect(q.perPersonCents).toBe(6500);
    expect(q.totalCents).toBe(13000);
  });

  it("charges the weekend rate on Fri–Sun", () => {
    const q = buildAddOnQuote(combo, SAT, 1);
    expect(q.perPersonCents).toBe(7500);
    expect(q.totalCents).toBe(7500);
    expect(q.weekend).toBe(true);
  });

  it("splits revenue across FastTrax + HeadPinz matching the registry", () => {
    const q = buildAddOnQuote(combo, MON, 3);
    // race-bowl weekday: FastTrax 4400 + HeadPinz 2100 = 6500 per person.
    expect(q.fasttraxCents).toBe(4400 * 3);
    expect(q.headpinzCents).toBe(2100 * 3);
    expect(q.fasttraxCents + q.headpinzCents).toBe(q.totalCents);
  });

  it("emits one day-of order group per entity with the right qty/price", () => {
    const groups = addonOrderGroups(combo, SAT, 2);
    const ft = groups.find((g) => g.entity === "fasttrax-fm")!;
    const hp = groups.find((g) => g.entity === "headpinz-fm")!;
    expect(ft.lines[0].quantity).toBe(2);
    expect(ft.lines[0].unitCents).toBe(4900);
    expect(hp.lines[0].unitCents).toBe(2600);
    expect(ft.subtotalCents + hp.subtotalCents).toBe(7500 * 2);
  });
});

describe("lane math", () => {
  it("fits within the existing lane below capacity", () => {
    const p = lanePlan(combo, 4, 1, 1);
    expect(p.lanesToAdd).toBe(0);
    expect(p.newLanes).toBe(1);
  });

  it("requires a second lane when crossing 6 players", () => {
    const p = lanePlan(combo, 6, 1, 1);
    expect(p.newPlayers).toBe(7);
    expect(p.newLanes).toBe(2);
    expect(p.lanesToAdd).toBe(1);
  });

  it("adds two lanes for a large jump", () => {
    const p = lanePlan(combo, 5, 1, 8);
    expect(p.newPlayers).toBe(13);
    expect(p.lanesToAdd).toBe(2);
  });

  it("never removes a lane the party already holds", () => {
    const p = lanePlan(combo, 3, 2, 1);
    expect(p.newLanes).toBe(2);
    expect(p.lanesToAdd).toBe(0);
  });

  it("counts empty seats on existing lanes", () => {
    expect(seatsOnExistingLanes(combo, 4, 1)).toBe(2);
    expect(seatsOnExistingLanes(combo, 6, 1)).toBe(0);
    expect(seatsOnExistingLanes(combo, 7, 2)).toBe(5);
  });
});

describe("capacity check", () => {
  const plenty = { heatFreeSpots: async () => 20 };

  it("approves an add within heat + lane capacity", async () => {
    const cap = await checkAddOnCapacity(combo, ctx(), 1, plenty);
    expect(cap.ok).toBe(true);
    expect(cap.lanesToAdd).toBe(0);
  });

  it("approves an add that needs a second lane (allowAddLane)", async () => {
    const cap = await checkAddOnCapacity(
      combo,
      ctx({ bowling: { ...ctx().bowling!, playerCount: 6 } }),
      1,
      plenty,
    );
    expect(cap.ok).toBe(true);
    expect(cap.lanesToAdd).toBe(1);
  });

  it("blocks when heats are full and reports max addable", async () => {
    const cap = await checkAddOnCapacity(combo, ctx(), 2, { heatFreeSpots: async () => 0 });
    expect(cap.ok).toBe(false);
    expect(cap.maxAddable).toBe(0);
    expect(cap.blockedReason).toMatch(/full|call us/i);
  });

  it("blocks when only some heat spots remain", async () => {
    const cap = await checkAddOnCapacity(combo, ctx(), 3, { heatFreeSpots: async () => 1 });
    expect(cap.ok).toBe(false);
    expect(cap.maxAddable).toBe(1);
  });

  it("blocks above the per-transaction cap", async () => {
    const cap = await checkAddOnCapacity(combo, ctx(), 99, plenty);
    expect(cap.ok).toBe(false);
    expect(cap.blockedReason).toMatch(/up to 8/);
  });
});
