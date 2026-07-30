import { describe, expect, it } from "vitest";
import {
  BMI_VOUCHER_RE,
  planVoucherCoverage,
  sessionVouchers,
  voucherIsApplied,
  voucherReviewLines,
  voucherDisplayName,
  voucherTarget,
} from "./voucher-redeem";
import type { BookingSession, RaceHeatAssignment } from "../state/types";

// Real production voucher codes (owner-shared 2026-07-27) — the shared regex
// is also consumed by the kiosk classifier and the web promo input.
describe("BMI_VOUCHER_RE (shared)", () => {
  it("matches real production codes", () => {
    expect(BMI_VOUCHER_RE.test("K5B7C3S7Q4Z9Q9Z3M9A9T7Z2")).toBe(true);
    expect(BMI_VOUCHER_RE.test("X7A3M4D3G6Q5S4R6D5M7U7K8")).toBe(true);
  });
  it("rejects 0/1 digits and wrong lengths", () => {
    expect(BMI_VOUCHER_RE.test("K1B7C3S7Q4Z9Q9Z3M9A9T7Z2")).toBe(false);
    expect(BMI_VOUCHER_RE.test("K5B7C3S7Q4Z9")).toBe(false);
  });
});

describe("voucherTarget", () => {
  it("parses the known comp families", () => {
    expect(voucherTarget("Race Comp").kind).toBe("race");
    expect(voucherTarget("Laser Comp")).toEqual({ kind: "attraction", slugs: ["laser-tag"] });
    expect(voucherTarget("Gel Blaster Comp")).toEqual({
      kind: "attraction",
      slugs: ["gel-blaster"],
    });
    expect(voucherTarget("Complimentary 1 Hour Shuffly")).toEqual({
      kind: "attraction",
      slugs: ["shuffly"],
    });
  });
  it("unknown names cover nothing (never guess with money)", () => {
    expect(voucherTarget("Comp Admission").kind).toBe("unknown");
    expect(voucherTarget(undefined).kind).toBe("unknown");
  });
  it("routes a Game Zone card comp to the gamecard rail, carrying its grant", () => {
    const target = voucherTarget("Complimentary 100 Token Game Card");
    expect(target.kind).toBe("gamecard");
    if (target.kind === "gamecard") {
      expect(target.grant.packageId).toBe("gzv-100");
      expect(target.grant.bonusTokens).toBe(100);
    }
  });
  it("checks game-card BEFORE the loose keyword matches", () => {
    // The strict matcher must not steal an attraction comp, and the loose
    // keyword matches must not steal a game card. Both directions.
    expect(voucherTarget("Complimentary Duckpin Game Card")).toEqual({
      kind: "attraction",
      slugs: ["duck-pin"],
    });
    expect(voucherTarget("Complimentary 50 Token Game Card").kind).toBe("gamecard");
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const raceVoucher = (code: string) => ({
  code,
  name: "Race Comp",
  billId: "63000000006397110",
  voucherOrderItemId: `9${code.length}00`,
});
const laserVoucher = (code: string) => ({ ...raceVoucher(code), name: "Laser Comp" });
/** A NATIVE (HPW) applied voucher — no BMI bill, applied via issuer+itemIndex. */
const nativeRaceVoucher = (code: string) => ({
  code,
  issuer: "native" as const,
  itemIndex: 0,
  name: "Race",
});
const gameCardVoucher = (code: string) => ({
  ...raceVoucher(code),
  name: "Complimentary 100 Token Game Card",
});

function heat(heatId: string, assignedTo = "m1"): RaceHeatAssignment {
  return {
    heatId,
    productId: "24960859", // Starter Race Red (weekday) — real catalog product
    track: "Red",
    assignedTo,
    category: "adult",
  } as RaceHeatAssignment;
}

function raceItem(heats: RaceHeatAssignment[]) {
  return {
    id: "item1",
    kind: "race",
    heats,
    productIdAdult: "24960859",
    productIdJunior: null,
    packageIdAdult: null,
    packageIdJunior: null,
    addons: [],
    povQuantity: 0,
  };
}

const laserItem = (id: string, price: number, qty = 2) => ({
  id,
  kind: "attraction",
  slug: "laser-tag",
  date: "2026-07-29",
  qty,
  productId: "111",
  price,
});

function makeSession(items: unknown[], vouchers: unknown[]): BookingSession {
  return { items, party: [], appliedVouchers: vouchers } as unknown as BookingSession;
}

// ── Plan allocation ─────────────────────────────────────────────────────────

describe("planVoucherCoverage", () => {
  it("one race comp covers one heat; two cover two distinct heats", () => {
    const h1 = heat("2026-07-29T18:00:00");
    const h2 = heat("2026-07-29T19:00:00", "m2");
    const one = planVoucherCoverage(
      makeSession([raceItem([h1, h2])], [raceVoucher("A2A2A2A2A2A2A2A2A2A2A2A2")]),
      new Set(),
    );
    expect(one.raceHeats.size).toBe(1);
    expect(one.raceHeats.has(h1)).toBe(true); // equal price → earliest wins
    const two = planVoucherCoverage(
      makeSession(
        [raceItem([h1, h2])],
        [raceVoucher("A2A2A2A2A2A2A2A2A2A2A2A2"), raceVoucher("B3B3B3B3B3B3B3B3B3B3B3B3")],
      ),
      new Set(),
    );
    expect(two.raceHeats.size).toBe(2);
    expect(two.picks.every((p) => p.raceHeat)).toBe(true);
  });

  it("more vouchers than heats: the extra pick covers nothing", () => {
    const h1 = heat("2026-07-29T18:00:00");
    const plan = planVoucherCoverage(
      makeSession(
        [raceItem([h1])],
        [raceVoucher("A2A2A2A2A2A2A2A2A2A2A2A2"), raceVoucher("B3B3B3B3B3B3B3B3B3B3B3B3")],
      ),
      new Set(),
    );
    expect(plan.raceHeats.size).toBe(1);
    expect(plan.picks[0].raceHeat).toBeDefined();
    expect(plan.picks[1].raceHeat).toBeUndefined();
  });

  it("pending/errored vouchers allocate nothing", () => {
    const h1 = heat("2026-07-29T18:00:00");
    const plan = planVoucherCoverage(
      makeSession(
        [raceItem([h1])],
        [
          { code: "P2P2P2P2P2P2P2P2P2P2P2P2", pending: true },
          { code: "E2E2E2E2E2E2E2E2E2E2E2E2", error: "unknown" },
        ],
      ),
      new Set(),
    );
    expect(plan.raceHeats.size).toBe(0);
    expect(plan.picks.length).toBe(0);
  });

  it("credits/packs win first — vouchers never double-cover", () => {
    const h1 = heat("2026-07-29T18:00:00");
    const h2 = heat("2026-07-29T19:00:00", "m2");
    const plan = planVoucherCoverage(
      makeSession([raceItem([h1, h2])], [raceVoucher("A2A2A2A2A2A2A2A2A2A2A2A2")]),
      new Set([h1]),
    );
    expect(plan.raceHeats.has(h2)).toBe(true);
    expect(plan.raceHeats.has(h1)).toBe(false);
  });

  it("attraction comps stack units on the matched item up to its qty", () => {
    const plan = planVoucherCoverage(
      makeSession(
        [laserItem("a1", 12.5, 2)],
        [
          laserVoucher("A2A2A2A2A2A2A2A2A2A2A2A2"),
          laserVoucher("B3B3B3B3B3B3B3B3B3B3B3B3"),
          laserVoucher("C4C4C4C4C4C4C4C4C4C4C4C4"), // 3rd exceeds qty → no pick
        ],
      ),
      new Set(),
    );
    expect(plan.attractionUnits.get("a1")).toBe(2);
    expect(plan.picks.filter((p) => p.attractionItemId).length).toBe(2);
  });

  it("a Game Zone card comp prices NOTHING in the cart", () => {
    // It's fulfilled by dispensing a card on the Intercard rail. If this ever
    // starts discounting, the guest gets a free card AND a free race.
    const h1 = heat("2026-07-29T18:00:00");
    const plan = planVoucherCoverage(
      makeSession(
        [raceItem([h1]), laserItem("a1", 12.5, 1)],
        [gameCardVoucher("A2A2A2A2A2A2A2A2A2A2A2A2")],
      ),
      new Set(),
    );
    expect(plan.raceHeats.size).toBe(0);
    expect(plan.attractionUnits.size).toBe(0);
    expect(plan.picks[0].raceHeat).toBeUndefined();
    expect(plan.picks[0].attractionUnitCents).toBeUndefined();
  });

  it("mixed race + laser vouchers allocate independently", () => {
    const h1 = heat("2026-07-29T18:00:00");
    const plan = planVoucherCoverage(
      makeSession(
        [raceItem([h1]), laserItem("a1", 12.5, 1)],
        [raceVoucher("A2A2A2A2A2A2A2A2A2A2A2A2"), laserVoucher("B3B3B3B3B3B3B3B3B3B3B3B3")],
      ),
      new Set(),
    );
    expect(plan.raceHeats.size).toBe(1);
    expect(plan.attractionUnits.get("a1")).toBe(1);
  });
});

describe("voucherReviewLines", () => {
  it("one negative line per voucher, sequential race deltas + attraction units", () => {
    const h1 = heat("2026-07-29T18:00:00");
    const h2 = heat("2026-07-29T19:00:00", "m2");
    const session = makeSession(
      [raceItem([h1, h2]), laserItem("a1", 12.5, 1)],
      [
        raceVoucher("A2A2A2A2A2A2A2A2A2A2A2A2"),
        raceVoucher("B3B3B3B3B3B3B3B3B3B3B3B3"),
        laserVoucher("C4C4C4C4C4C4C4C4C4C4C4C4"),
      ],
    );
    // Fake race sum: $20.99 per uncovered heat of the two.
    const sum = (ex: Set<RaceHeatAssignment>) => [h1, h2].filter((h) => !ex.has(h)).length * 20.99;
    const lines = voucherReviewLines(session, new Set(), sum);
    expect(lines.length).toBe(3);
    expect(lines[0].amount).toBe(20.99);
    expect(lines[1].amount).toBe(20.99);
    expect(lines[2].amount).toBe(12.5);
  });

  it("a voucher matching nothing yields amount 0 (no-match note upstream)", () => {
    const session = makeSession(
      [laserItem("a1", 12.5, 1)],
      [raceVoucher("A2A2A2A2A2A2A2A2A2A2A2A2")],
    );
    const lines = voucherReviewLines(session, new Set(), () => 0);
    expect(lines.length).toBe(1);
    expect(lines[0].amount).toBe(0);
  });
});

describe("sessionVouchers / voucherIsApplied", () => {
  it("defaults empty; applied requires bill + line id and no pending/error", () => {
    expect(sessionVouchers({} as BookingSession)).toEqual([]);
    expect(voucherIsApplied(raceVoucher("A2A2A2A2A2A2A2A2A2A2A2A2"))).toBe(true);
    expect(voucherIsApplied({ code: "X", pending: true })).toBe(false);
    expect(voucherIsApplied({ code: "X", error: "unknown" })).toBe(false);
    expect(voucherIsApplied(null)).toBe(false);
  });
});

describe("voucherDisplayName (real BMI comp names, live 2026-07-28)", () => {
  it("shortens the gel-blaster instruction sentence to a label", () => {
    expect(
      voucherDisplayName("Complimentary Gel Blasters. Redeem on a kiosk or at guest services."),
    ).toBe("Gel Blaster comp");
  });
  it("keeps race tidy", () => {
    expect(voucherDisplayName("Race Comp")).toBe("Race comp");
    expect(voucherDisplayName("Race Comp - X7P7C2D8Z4M7G9X4M2A3M4S7")).toBe("Race comp");
  });
  it("labels the other attraction families", () => {
    expect(voucherDisplayName("Complimentary 1 Hour Shuffly")).toBe("Shuffly comp");
    expect(voucherDisplayName("Complimentary Laser Tag. Redeem at a kiosk.")).toBe(
      "Laser Tag comp",
    );
    expect(voucherDisplayName("Duckpin comp hour")).toBe("Duckpin comp");
  });
  it("falls back to the first clause, capped, for unmapped names", () => {
    expect(voucherDisplayName("Mystery Prize. Ask an attendant.")).toBe("Mystery Prize");
    expect(voucherDisplayName("A very long unmapped comp product name that never ends")).toBe(
      "A very long unmapped comp…",
    );
    expect(voucherDisplayName(undefined)).toBe("Voucher");
  });
});

describe("native vouchers cover the cart (no BMI bill)", () => {
  it("a native race voucher covers a heat via the SAME coverage plan", () => {
    // The whole point of issuer-aware voucherIsApplied: native vouchers price
    // exactly like BMI ones, just without a bill/comp-line id.
    const h1 = heat("2026-07-29T18:00:00");
    const plan = planVoucherCoverage(
      makeSession([raceItem([h1])], [nativeRaceVoucher("HPW4K7M9PQR")]),
      new Set(),
    );
    expect(plan.raceHeats.size).toBe(1);
    expect(plan.picks[0].raceHeat).toBeDefined();
  });

  it("a native voucher still pending (no itemIndex) prices nothing", () => {
    const h1 = heat("2026-07-29T18:00:00");
    const plan = planVoucherCoverage(
      makeSession([raceItem([h1])], [{ code: "HPW4K7M9PQR", issuer: "native", pending: true }]),
      new Set(),
    );
    expect(plan.raceHeats.size).toBe(0);
  });
});
