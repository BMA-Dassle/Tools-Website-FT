/**
 * BOGO Wednesdays as a SCHEDULED-RACE rule (owner 2026-08-31: "never meant to
 * be a race pack — buy one get one, all races must be scheduled").
 *
 * Two layers, deliberately:
 *  1. the pure pairing rule (computeBogoScheduledFree) — who goes free;
 *  2. the CHARGE BUILDER end-to-end (buildCombinedLineItems) — the money a
 *     Wednesday cart actually produces, with the displayed==charged parity
 *     check the voucher repro suite established.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ default: {} }));

import { computeBogoScheduledFree, racingPassBlocksBogo } from "./bogo-scheduled";
import { buildCombinedLineItems } from "./unified-reserve";
import { getRaceProductById } from "./race-products";
import { emptySession, newItem, type BookingSession, type RaceItem } from "../state/types";
import type { RaceHeatAssignment } from "../state/types";

/** 2026-09-02 is a Wednesday (promo day); 2026-09-03 a Thursday. */
const WED = "2026-09-02";
const THU = "2026-09-03";

/** Weekday singles from the live registry (race-products.ts). */
const ADULT_STARTER_RED = "24960859"; // $20.99
const JUNIOR_STARTER = "24960106"; // $15.99
const JUNIOR_INTERMEDIATE = "24958587"; // $20.99
const COMBO_PACK = "45094787"; // Pro Mega 3-Pack (packType combo)

/** A party with no racing-pass memberships — nobody is excluded from pairing. */
const NOBODY: Array<{ id: string; memberships?: string[] }> = [];

const heat = (
  assignedTo: string,
  heatId: string,
  over: Partial<RaceHeatAssignment> = {},
): RaceHeatAssignment =>
  ({
    productId: ADULT_STARTER_RED,
    track: "Red",
    category: "adult",
    heatId,
    bmiLineId: null,
    assignedTo,
    ...over,
  }) as RaceHeatAssignment;

const raceItems = (
  heats: RaceHeatAssignment[],
  over: Partial<{
    date: string;
    packageIdAdult: string | null;
    packageIdJunior: string | null;
  }> = {},
) => [{ kind: "race", date: WED, heats, ...over }];

describe("computeBogoScheduledFree — the pairing rule", () => {
  it("two scheduled Wednesday races: the second is free", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2")];
    const bogo = computeBogoScheduledFree(raceItems(heats), NOBODY, new Set());
    expect(bogo.heats.size).toBe(1);
    expect(bogo.heats.has(heats[1])).toBe(true);
    expect(bogo.freeByMember.get("a1")).toBe(1);
  });

  it("four races → two free; the owner's complaint case needs ONE transaction", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a1", "h3"), heat("a1", "h4")];
    const bogo = computeBogoScheduledFree(raceItems(heats), NOBODY, new Set());
    expect(bogo.heats.size).toBe(2);
    expect(bogo.freeByMember.get("a1")).toBe(2);
  });

  it("odd count pairs by floor: three races → one free (owner: every 2nd free)", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a1", "h3")];
    expect(computeBogoScheduledFree(raceItems(heats), NOBODY, new Set()).heats.size).toBe(1);
  });

  it("one race alone earns nothing — the free race must be scheduled", () => {
    expect(
      computeBogoScheduledFree(raceItems([heat("a1", "h1")]), NOBODY, new Set()).heats.size,
    ).toBe(0);
  });

  it("no cap: ten races → five free (owner decision)", () => {
    const heats = Array.from({ length: 10 }, (_, i) => heat("a1", `h${i}`));
    expect(computeBogoScheduledFree(raceItems(heats), NOBODY, new Set()).heats.size).toBe(5);
  });

  it("only Wednesday race dates pair — Thursday and undated items never do", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2")];
    expect(
      computeBogoScheduledFree(raceItems(heats, { date: THU }), NOBODY, new Set()).heats.size,
    ).toBe(0);
    expect(computeBogoScheduledFree([{ kind: "race", heats }], NOBODY, new Set()).heats.size).toBe(
      0,
    );
  });

  it("the CHEAPER of a mixed-price pair goes free (never over-discounts)", () => {
    // Junior Intermediate $20.99 first, Junior Starter $15.99 second — and
    // then the same pair in the other order: the $15.99 heat is free both ways.
    const dear = getRaceProductById(JUNIOR_INTERMEDIATE)!.price;
    const cheap = getRaceProductById(JUNIOR_STARTER)!.price;
    expect(dear).toBeGreaterThan(cheap); // guard: the fixture stays mixed-price
    for (const order of [
      [JUNIOR_INTERMEDIATE, JUNIOR_STARTER],
      [JUNIOR_STARTER, JUNIOR_INTERMEDIATE],
    ]) {
      const heats = order.map((productId, i) =>
        heat("j1", `h${i}`, { productId, category: "junior" }),
      );
      const bogo = computeBogoScheduledFree(raceItems(heats), NOBODY, new Set());
      expect(bogo.heats.size).toBe(1);
      const free = [...bogo.heats][0];
      expect(free.productId).toBe(JUNIOR_STARTER);
    }
  });

  it("pairs are PER RACER — two racers with one race each get nothing", () => {
    const heats = [heat("a1", "h1"), heat("a2", "h2")];
    expect(computeBogoScheduledFree(raceItems(heats), NOBODY, new Set()).heats.size).toBe(0);
  });

  it("each racer pairs independently — 2+2 across two racers → one free each", () => {
    const heats = [heat("a1", "h1"), heat("a2", "h2"), heat("a1", "h3"), heat("a2", "h4")];
    const bogo = computeBogoScheduledFree(raceItems(heats), NOBODY, new Set());
    expect(bogo.heats.size).toBe(2);
    expect(bogo.freeByMember.get("a1")).toBe(1);
    expect(bogo.freeByMember.get("a2")).toBe(1);
  });

  it("an already-covered heat (credit/pack/voucher) neither pairs nor goes free", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2")];
    // h1 covered elsewhere: only ONE cash heat remains — no pair, no freebie.
    const bogo = computeBogoScheduledFree(raceItems(heats), NOBODY, new Set([heats[0]]));
    expect(bogo.heats.size).toBe(0);
    // Three cash heats after one is covered → one free.
    const four = [heat("a1", "h1"), heat("a1", "h2"), heat("a1", "h3"), heat("a1", "h4")];
    expect(computeBogoScheduledFree(raceItems(four), NOBODY, new Set([four[0]])).heats.size).toBe(
      1,
    );
  });

  it("a racing pass takes PRIORITY — its holder never pairs (owner, preview smoke)", () => {
    const employee = [{ id: "a1", memberships: ["Employee Pass"] }];
    const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a1", "h3"), heat("a1", "h4")];
    expect(computeBogoScheduledFree(raceItems(heats), employee, new Set()).heats.size).toBe(0);
    // League Racer (20% racing) is a racing pass too — same rule, no stacking.
    const league = [{ id: "a1", memberships: ["League Racer"] }];
    expect(computeBogoScheduledFree(raceItems(heats), league, new Set()).heats.size).toBe(0);
    // A non-racing membership does NOT block the special.
    const unrelated = [{ id: "a1", memberships: ["Have-A-Ball"] }];
    expect(computeBogoScheduledFree(raceItems(heats), unrelated, new Set()).heats.size).toBe(2);
  });

  it("a passholder in the party never blocks the OTHER racers' pairs", () => {
    const party = [{ id: "a1", memberships: ["Employee Pass"] }, { id: "a2" }];
    const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a2", "h3"), heat("a2", "h4")];
    const bogo = computeBogoScheduledFree(raceItems(heats), party, new Set());
    expect(bogo.heats.size).toBe(1);
    expect(bogo.freeByMember.get("a2")).toBe(1);
    expect(bogo.freeByMember.has("a1")).toBe(false);
  });

  it("racingPassBlocksBogo reads the racing category only", () => {
    expect(racingPassBlocksBogo(["Employee Pass"])).toBe(true);
    expect(racingPassBlocksBogo(["League Racer"])).toBe(true);
    expect(racingPassBlocksBogo(["Some Bowling Club"])).toBe(false);
    expect(racingPassBlocksBogo([])).toBe(false);
    expect(racingPassBlocksBogo(undefined)).toBe(false);
  });

  it("package component heats are excluded PER CATEGORY (first-timers keep the package half)", () => {
    const adultHeats = [heat("a1", "h1"), heat("a1", "h2")];
    const juniorHeats = [
      heat("j1", "h3", { category: "junior", productId: JUNIOR_STARTER }),
      heat("j1", "h4", { category: "junior", productId: JUNIOR_STARTER }),
    ];
    const bogo = computeBogoScheduledFree(
      raceItems([...adultHeats, ...juniorHeats], { packageIdAdult: "bogo-weekday" }),
      NOBODY,
      new Set(),
    );
    // The adult package owns its heats; the junior singles still pair.
    expect(bogo.heats.size).toBe(1);
    expect([...bogo.heats][0].category).toBe("junior");
  });

  it("booked combo pack products never pair — their price is already a bundle", () => {
    const heats = [
      heat("a1", "h1", { productId: COMBO_PACK }),
      heat("a1", "h2", { productId: COMBO_PACK }),
    ];
    expect(computeBogoScheduledFree(raceItems(heats), NOBODY, new Set()).heats.size).toBe(0);
  });

  it("unpicked slots (no heatId) and unassigned heats are ignored", () => {
    const heats = [
      heat("a1", "h1"),
      { ...heat("a1", "h2"), heatId: null } as RaceHeatAssignment,
      { ...heat("a1", "h3"), assignedTo: null } as RaceHeatAssignment,
    ];
    expect(computeBogoScheduledFree(raceItems(heats), NOBODY, new Set()).heats.size).toBe(0);
  });
});

// ── The CHARGE the rule produces (buildCombinedLineItems end-to-end) ────────

function wednesdayRaceSession(
  heats: RaceHeatAssignment[],
  date = WED,
  party: Array<{ id: string; firstName: string; memberships?: string[] }> = [],
): BookingSession {
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    party,
    items: [
      {
        ...(newItem("race") as RaceItem),
        id: "r1",
        date,
        heats,
        // Singles charge at the CATEGORY's selected product (raceItemChargeLines
        // reads item.productIdAdult, not the heat's own id).
        productIdAdult: ADULT_STARTER_RED,
      } as RaceItem,
    ],
  } as BookingSession;
}

describe("BOGO scheduled — the Wednesday charge itself", () => {
  const price = getRaceProductById(ADULT_STARTER_RED)!.price; // $20.99

  it("4 scheduled races charge as 2 paid + 2 tagged $0 'BOGO Wednesday' lines", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a1", "h3"), heat("a1", "h4")];
    const { pricedLines, totalPriceCents, bogoFree } = buildCombinedLineItems(
      wednesdayRaceSession(heats),
    );
    expect(bogoFree.heats.size).toBe(2);
    const freeLine = pricedLines.find((l) => l.coverage?.kind === "bogo-special");
    expect(freeLine).toMatchObject({
      quantity: 2,
      unitCents: 0,
      coverage: { kind: "bogo-special", label: "BOGO Wednesday" },
    });
    // Total = exactly two paid races.
    expect(totalPriceCents).toBe(Math.round(price * 100) * 2);
  });

  it("the same 4 races on a THURSDAY charge in full — no free lines", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a1", "h3"), heat("a1", "h4")];
    const { pricedLines, totalPriceCents, bogoFree } = buildCombinedLineItems(
      wednesdayRaceSession(heats, THU),
    );
    expect(bogoFree.heats.size).toBe(0);
    expect(pricedLines.some((l) => l.coverage?.kind === "bogo-special")).toBe(false);
    expect(totalPriceCents).toBe(Math.round(price * 100) * 4);
  });

  it("displayed == charged: priced-line money equals Square-line money, both days", () => {
    for (const date of [WED, THU]) {
      const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a1", "h3")];
      const { sqLineItems, pricedLines, totalPriceCents } = buildCombinedLineItems(
        wednesdayRaceSession(heats, date),
      );
      const sqCents = sqLineItems.reduce(
        (sum, l) => sum + (l.basePriceMoney?.amount ?? 0) * Number(l.quantity),
        0,
      );
      const quoteCents = pricedLines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
      expect(quoteCents).toBe(sqCents);
      expect(quoteCents).toBe(totalPriceCents);
    }
  });

  it("odd Wednesday count: 3 races charge as 2 paid + 1 free", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a1", "h3")];
    const { totalPriceCents, bogoFree } = buildCombinedLineItems(wednesdayRaceSession(heats));
    expect(bogoFree.heats.size).toBe(1);
    expect(totalPriceCents).toBe(Math.round(price * 100) * 2);
  });

  it("two racers × two races: each pays one — party math stays per racer", () => {
    const heats = [heat("a1", "h1"), heat("a2", "h2"), heat("a1", "h3"), heat("a2", "h4")];
    const { totalPriceCents, bogoFree } = buildCombinedLineItems(wednesdayRaceSession(heats));
    expect(bogoFree.heats.size).toBe(2);
    expect(totalPriceCents).toBe(Math.round(price * 100) * 2);
  });

  it("EMPLOYEE PASS takes priority: pass pricing on every heat, zero free races", () => {
    // Owner, preview smoke 2026-08-31: "cannot combine employee pass with BOGO
    // Wednesday — employee pass takes priority." Two Wednesday races charge as
    // TWO heats at 50% off (≈ the price of one, which is why the exclusion is
    // money-neutral for this pass) — never one full + one free + 50% stacked.
    const heats = [heat("a1", "h1"), heat("a1", "h2")];
    const party = [{ id: "a1", firstName: "Eric", memberships: ["Employee Pass"] }];
    const { totalPriceCents, bogoFree, pricedLines } = buildCombinedLineItems(
      wednesdayRaceSession(heats, WED, party),
    );
    expect(bogoFree.heats.size).toBe(0);
    expect(pricedLines.some((l) => l.coverage?.kind === "bogo-special")).toBe(false);
    // round2(20.99 × 2 × 0.5) = 20.99 → 2099 cents.
    expect(totalPriceCents).toBe(2099);
  });

  it("mixed party: the passholder gets pass pricing, the guest still gets BOGO", () => {
    const heats = [heat("a1", "h1"), heat("a1", "h2"), heat("a2", "h3"), heat("a2", "h4")];
    const party = [
      { id: "a1", firstName: "Eric", memberships: ["Employee Pass"] },
      { id: "a2", firstName: "Dale" },
    ];
    const { totalPriceCents, bogoFree } = buildCombinedLineItems(
      wednesdayRaceSession(heats, WED, party),
    );
    expect(bogoFree.heats.size).toBe(1); // only a2 pairs
    // a1: 2 × 50% off = 2099 · a2: pay one, get one = 2099.
    expect(totalPriceCents).toBe(2099 + 2099);
  });
});
