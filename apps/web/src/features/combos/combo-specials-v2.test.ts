/**
 * race-bowl-v2 (V2 pack, owner 2026-07-31) — registry invariants + the chips
 * 1-per-3 quantity rule.
 *
 * The v2 entry ships DARK (enabled only when NEXT_PUBLIC_COMBO_RACE_BOWL_V2_ENABLED
 * === "true", evaluated at module load), so these tests stub the env and
 * re-import the modules per test-file run. The unstubbed default is asserted
 * in its own block at the end.
 */
import { describe, expect, it, beforeAll, vi } from "vitest";

import {
  emptySession,
  newItem,
  type BookingSession,
  type BowlingItem,
  type PartyMember,
  type RaceHeatAssignment,
  type RaceItem,
} from "~/features/booking/state/types";
import type { RaceTier } from "~/features/booking/service/race-products";

// June 2026: the 1st is a Monday; the 2nd is Mega Tuesday; the 6th a Saturday.
const MON = "2026-06-01";
const TUE = "2026-06-02";
const SAT = "2026-06-06";
const CHIPS = "LHZXWYO72N5QFX4CGYKRVPZX";

type Specials = typeof import("./combo-specials");
type Pricing = typeof import("./combo-pricing");
let specials: Specials;
let pricing: Pricing;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_COMBO_RACE_BOWL_V2_ENABLED", "true");
  vi.resetModules();
  specials = await import("./combo-specials");
  pricing = await import("./combo-pricing");
});

function member(id: string): PartyMember {
  return { id, firstName: id, isNewRacer: false, category: "adult" };
}

function heat(date: string, time: string, assignedTo: string, tier: RaceTier): RaceHeatAssignment {
  return {
    productId: "24960859",
    track: "Red",
    tier,
    category: "adult",
    heatId: `${date}T${time}:00Z`,
    bmiLineId: null,
    assignedTo,
  };
}

function itineraryHeats(date: string, racers: string[]): RaceHeatAssignment[] {
  return racers.flatMap((r) => [
    heat(date, "13:00", r, "starter"),
    heat(date, "16:00", r, "intermediate"),
  ]);
}

/** V2 session with N racers and the chips $0 inclusion on the lane. */
function v2Session(date: string, racers: string[]): BookingSession {
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    comboSpecialId: "race-bowl-v2",
    party: racers.map(member),
    items: [
      {
        ...(newItem("race") as RaceItem),
        id: "race-1",
        date,
        productIdAdult: "43734407",
        heats: itineraryHeats(date, racers),
      },
      {
        ...(newItem("bowling") as BowlingItem),
        id: "bowl-1",
        date,
        bookedAt: `${date}T14:00:00-04:00`,
        variant: "hourly",
        tier: "vip",
        durationMinutes: 90,
        playerCount: racers.length,
        lineItems: [
          {
            squareProductId: 2,
            quantity: 1, // QAMF seeds 1 per LANE — the rule must re-size this
            label: "VIP Chips & Salsa",
            priceCents: 0,
            squareCatalogObjectId: CHIPS,
          },
        ],
      } as BowlingItem,
    ],
  };
}

describe("race-bowl-v2 registry invariants", () => {
  it("prices at $79 weekday / $99 weekend, split evenly over v1 (FT 5100/6100 + HP 2800/3800)", () => {
    const v2 = specials.getComboSpecial("race-bowl-v2")!;
    expect(v2.price).toEqual({ weekday: 7900, weekend: 9900 });
    const ft = v2.revenueSplit!.find((l) => l.entity === "fasttrax-fm")!;
    const hp = v2.revenueSplit!.find((l) => l.entity === "headpinz-fm")!;
    expect([ft.weekdayCents, ft.weekendCents]).toEqual([5100, 6100]);
    expect([hp.weekdayCents, hp.weekendCents]).toEqual([2800, 3800]);
    // The split MUST sum to the per-person price — the deposit equals the
    // day-of orders, so a drift here is a real money bug.
    expect(ft.weekdayCents + hp.weekdayCents).toBe(v2.price.weekday);
    expect(ft.weekendCents + hp.weekendCents).toBe(v2.price.weekend);
  });

  it("Mega Tuesday prices as weekday; Fri–Sun as weekend", () => {
    const v2 = specials.getComboSpecial("race-bowl-v2")!;
    expect(specials.comboPriceCentsForDate(v2, TUE)).toBe(7900);
    expect(specials.comboPriceCentsForDate(v2, SAT)).toBe(9900);
  });

  it("keeps v1's itinerary, name and headcount (same experience, new inclusions)", () => {
    const v1 = specials.getComboSpecial("race-bowl")!;
    const v2 = specials.getComboSpecial("race-bowl-v2")!;
    expect(v2.name).toBe(v1.name); // shared name keeps flat-display + receipt collapse working
    expect(v2.components).toEqual(v1.components);
    expect(v2.fallbackComponents).toEqual(v1.fallbackComponents);
    expect(v2.minHeadcount).toBe(v1.minHeadcount);
    expect(v2.startHours).toEqual(v1.startHours);
    expect(v2.adminShortLabel).toBe("VIP V2");
  });

  it("grants per-guest gamezone + laser/gel choice and one shared shuffly hour, 12 months from visit", () => {
    const grant = specials.getComboSpecial("race-bowl-v2")!.voucherGrant!;
    expect(grant.expiresMonthsFromVisit).toBe(12);
    expect(grant.perGuest).toEqual([
      { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
      { kind: "attraction-choice", slugs: ["laser-tag", "gel-blaster"], qty: 1 },
    ]);
    expect(grant.perBooking).toEqual([{ kind: "attraction", slug: "shuffly", qty: 1 }]);
  });

  it("the gamezone denomination is on the sellable allowlist (mint would throw otherwise)", async () => {
    const { NATIVE_GRANT_DENOMINATIONS } = await import(
      "~/features/game-cards/service/native-voucher"
    );
    const grant = specials.getComboSpecial("race-bowl-v2")!.voucherGrant!;
    for (const item of [...grant.perGuest, ...grant.perBooking]) {
      if (item.kind === "gamezone") {
        expect(NATIVE_GRANT_DENOMINATIONS).toContain(item.bonusTokens);
      }
    }
  });

  it("voucher inclusions live in their OWN section with the terms stated once (EN and ES)", () => {
    // Owner 2026-07-31: no "(voucher — when available…)" suffix repeated per
    // line — one section, one shared note carrying the full terms.
    const v2 = specials.getComboSpecial("race-bowl-v2")!;
    expect(v2.includes).toHaveLength(4); // itinerary only — no voucher suffix lines
    expect(v2.includes.join(" ")).not.toMatch(/voucher/i);

    const vi2 = v2.voucherIncludes!;
    expect(vi2.items).toHaveLength(3);
    expect(vi2.items.join(" ")).toMatch(/game zone/i);
    expect(vi2.items.join(" ")).toMatch(/laser tag or gel blaster/i);
    expect(vi2.items.join(" ")).toMatch(/shuffly/i);
    expect(vi2.note).toMatch(/1 year from your race date/i);
    expect(vi2.note).toMatch(/when available/i);
    expect(vi2.note).toMatch(/not transferable/i);

    const es = v2.es!.voucherIncludes!;
    expect(es.items).toHaveLength(3);
    expect(es.note).toMatch(/no transferible/i);
    expect(v2.es!.includes!).toHaveLength(v2.includes.length);
  });
});

describe("chips & salsa 1-per-3 (inclusionQtyRules)", () => {
  const chipsQty = (racers: string[]): number => {
    const groups = pricing.comboOrderGroups(v2Session(MON, racers))!;
    const hp = groups.find((g) => g.entity === "headpinz-fm")!;
    return hp.lines.find((l) => l.catalogObjectId === CHIPS)!.quantity;
  };

  it("rounds UP per 3 guests: 2→1, 4→2, 6→2, 7→3", () => {
    expect(chipsQty(["a", "b"])).toBe(1);
    expect(chipsQty(["a", "b", "c", "d"])).toBe(2);
    expect(chipsQty(["a", "b", "c", "d", "e", "f"])).toBe(2);
    expect(chipsQty(["a", "b", "c", "d", "e", "f", "g"])).toBe(3);
  });

  it("stays $0 — totals and the deposit are untouched by the rule", () => {
    const racers = ["a", "b", "c", "d"];
    const groups = pricing.comboOrderGroups(v2Session(MON, racers))!;
    const hp = groups.find((g) => g.entity === "headpinz-fm")!;
    const ft = groups.find((g) => g.entity === "fasttrax-fm")!;
    expect(hp.subtotalCents).toBe(2800 * racers.length);
    expect(ft.subtotalCents).toBe(5100 * racers.length);
    expect(hp.subtotalCents + ft.subtotalCents).toBe(7900 * racers.length);
  });

  // v1's rule-less pass-through (quantity untouched) is covered by
  // combo-pricing.test.ts's re-attach spec, which revives v1 for the file.
});

describe("flag defaults (owner 2026-07-31: flags on by default)", () => {
  async function freshWith(env: Record<string, string>) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules();
    return import("./combo-specials");
  }

  it("v2 is LIVE by default; v1 is retired — activeVipCombo resolves v2", async () => {
    const fresh = await freshWith({
      NEXT_PUBLIC_COMBO_RACE_BOWL_V2_ENABLED: "",
      NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED: "",
    });
    expect(fresh.getComboSpecial("race-bowl-v2")!.enabled).toBe(true);
    expect(fresh.getComboSpecial("race-bowl")!.enabled).toBe(false);
    expect(fresh.enabledCombos().map((c) => c.id)).toEqual(["race-bowl-v2"]);
    expect(fresh.activeVipCombo()?.id).toBe("race-bowl-v2");
  });

  it("NEVER both on: forcing v1 true while v2 lives keeps v1 off (structural guard)", async () => {
    const fresh = await freshWith({
      NEXT_PUBLIC_COMBO_RACE_BOWL_V2_ENABLED: "",
      NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED: "true",
    });
    expect(fresh.getComboSpecial("race-bowl")!.enabled).toBe(false);
    expect(fresh.enabledCombos().map((c) => c.id)).toEqual(["race-bowl-v2"]);
  });

  it("kill switch: V2=false turns v2 off without silently reviving v1", async () => {
    const fresh = await freshWith({
      NEXT_PUBLIC_COMBO_RACE_BOWL_V2_ENABLED: "false",
      NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED: "",
    });
    expect(fresh.getComboSpecial("race-bowl-v2")!.enabled).toBe(false);
    expect(fresh.getComboSpecial("race-bowl")!.enabled).toBe(false);
    expect(fresh.activeVipCombo()).toBeNull(); // anchor reserve lifts, kiosk tile hides
  });

  it("revive path: v1 true + v2 false brings the original pack back", async () => {
    const fresh = await freshWith({
      NEXT_PUBLIC_COMBO_RACE_BOWL_V2_ENABLED: "false",
      NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED: "true",
    });
    expect(fresh.getComboSpecial("race-bowl")!.enabled).toBe(true);
    expect(fresh.enabledCombos().map((c) => c.id)).toEqual(["race-bowl"]);
    expect(fresh.activeVipCombo()?.id).toBe("race-bowl");
  });
});
