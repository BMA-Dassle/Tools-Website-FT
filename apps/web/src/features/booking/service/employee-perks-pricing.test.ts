/**
 * Live-repro (kiosk, 2026-09-14): a RETURNING team member (licence active — no
 * $4.99 line) booked only their two free single races. The review priced $0,
 * flagged a credit order, and the legacy reserve refused with "cardSourceId or
 * giftCardNonce required for paid orders". CheckoutStep now sends any order
 * with a verified employee down the unified rail — but that rail then built
 * ZERO Square lines for the same cart (the 2026-09-06 voucher failure, one
 * coverage kind over). These tests feed the charge builder the exact session
 * shape the kiosk posts, plus the multi-employee shape (owner 2026-09-14: two
 * team members on one order).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ default: {} }));

import { buildCombinedLineItems, quoteUnifiedSession } from "./unified-reserve";
import { employeeRacingSavingsByMember } from "./employee-perks";
import { lookupCatalogId } from "../data/square-catalog-map";
import {
  emptySession,
  newItem,
  type AttractionItem,
  type BookingSession,
  type PartyMember,
  type RaceHeatAssignment,
  type RaceItem,
} from "../state/types";
import type { SessionEmployee } from "~/features/discount-codes/programs/employee";

const STARTER_RED = "24960859"; // single, $20.99 on 2026-09-06 (race-products.ts)
const DATE = "2026-09-06";
const UNIT = 2099;

const samStamp = { userId: 42, firstName: "Sam" };
const alexStamp = { userId: 77, firstName: "Alex" };
const samEmp: SessionEmployee = {
  userId: 42,
  firstName: "Sam",
  memberId: "sam",
  token: "emp.test.sam",
  usedThisWeek: 0,
  weekKey: "2026-09-02",
};
const alexEmp: SessionEmployee = {
  ...samEmp,
  userId: 77,
  firstName: "Alex",
  memberId: "alex",
  token: "emp.test.alex",
  usedThisWeek: 1,
};

function racer(id: string, firstName: string, stamp?: { userId: number; firstName: string }) {
  return {
    id,
    firstName,
    lastName: "Ortiz",
    bmiPersonId: `6300000000000${id.length}${id.charCodeAt(0)}`,
    licenseActive: true,
    isNewRacer: false,
    ...(stamp ? { employeePerks: stamp } : {}),
  } as PartyMember;
}

function heatFor(assignedTo: string, heatId: string): RaceHeatAssignment {
  return {
    heatId,
    productId: STARTER_RED,
    track: "Red",
    assignedTo,
    category: "adult",
  } as RaceHeatAssignment;
}

function kioskRaceSession(
  party: PartyMember[],
  heats: RaceHeatAssignment[],
  employees: SessionEmployee[] | undefined,
  extra: Partial<BookingSession> = {},
): BookingSession {
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    context: { kiosk: true },
    party,
    items: [
      {
        ...(newItem("race") as RaceItem),
        id: "r1",
        date: DATE,
        heats,
        productIdAdult: STARTER_RED,
      } as RaceItem,
    ],
    ...(employees ? { employees } : {}),
    ...extra,
  } as BookingSession;
}

const sqCents = (lines: ReturnType<typeof buildCombinedLineItems>["sqLineItems"]) =>
  lines.reduce((s, l) => s + (l.basePriceMoney?.amount ?? 0) * Number(l.quantity), 0);

describe("unified pricing — a team member's free races are the WHOLE kiosk cart", () => {
  const twoFree = () =>
    kioskRaceSession(
      [racer("sam", "Sam", samStamp)],
      [heatFor("sam", "2026-09-06T21:36"), heatFor("sam", "2026-09-06T21:48")],
      [samEmp],
    );

  it("two free heats: ONE $0 Square line survives the empty-cart guard, total $0", () => {
    const { sqLineItems, pricedLines, totalPriceCents, employeeFree } =
      buildCombinedLineItems(twoFree());
    expect(totalPriceCents).toBe(0);
    expect(sqLineItems).toHaveLength(1);
    expect(sqLineItems[0]).toMatchObject({
      quantity: "2",
      catalogObjectId: lookupCatalogId(STARTER_RED),
      basePriceMoney: { amount: 0, currency: "USD" },
    });
    expect(employeeFree.heats.size).toBe(2);
    expect(employeeFree.memberIds).toEqual(["sam"]);
    const covered = pricedLines.filter((l) => l.coverage?.kind === "employee-perk");
    expect(covered).toHaveLength(1);
    expect(covered[0]).toMatchObject({ quantity: 2, unitCents: 0 });
    expect(covered[0].coverage?.label).toBe("Employee · free race");
    expect(sqLineItems[0].name).toBe(covered[0].name);
  });

  it("the quote the review renders says the same: $0, one employee-perk line", () => {
    const q = quoteUnifiedSession(twoFree());
    expect(q.totalCents).toBe(0);
    expect(q.taxCents).toBe(0);
    expect(q.lines.filter((l) => l.coverage?.kind === "employee-perk")).toHaveLength(1);
  });

  it("control — no employee on the session: the same two heats are one charged line", () => {
    const s = kioskRaceSession(
      [racer("sam", "Sam")],
      [heatFor("sam", "2026-09-06T21:36"), heatFor("sam", "2026-09-06T21:48")],
      undefined,
    );
    const { sqLineItems, totalPriceCents } = buildCombinedLineItems(s);
    expect(sqLineItems).toHaveLength(1);
    expect(sqLineItems[0].basePriceMoney?.amount).toBe(UNIT);
    expect(sqLineItems[0].quantity).toBe("2");
    expect(totalPriceCents).toBe(2 * UNIT);
  });

  it("a stamp with no employee list behind it prices as a guest (display-only stamps buy nothing)", () => {
    const s = kioskRaceSession(
      [racer("sam", "Sam", samStamp)],
      [heatFor("sam", "2026-09-06T21:36")],
      [],
    );
    const { totalPriceCents, employeeFree } = buildCombinedLineItems(s);
    expect(employeeFree.heats.size).toBe(0);
    // The 50% still splits the line: the stamp IS the entitlement the server
    // re-derives; only the free-race allowance needs the employee entry.
    expect(totalPriceCents).toBeLessThan(UNIT);
  });

  it("third heat: two free + one at the Employee Pass 50%, savings attributed to Sam", () => {
    const s = kioskRaceSession(
      [racer("sam", "Sam", samStamp)],
      [
        heatFor("sam", "2026-09-06T21:36"),
        heatFor("sam", "2026-09-06T21:48"),
        heatFor("sam", "2026-09-06T22:00"),
      ],
      [samEmp],
    );
    const { sqLineItems, totalPriceCents, employeeSavingsByMember, employeeFree } =
      buildCombinedLineItems(s);
    expect(employeeFree.heats.size).toBe(2);
    const free = sqLineItems.find((l) => l.basePriceMoney?.amount === 0);
    const charged = sqLineItems.find((l) => (l.basePriceMoney?.amount ?? 0) > 0);
    expect(free?.quantity).toBe("2");
    expect(charged?.quantity).toBe("1");
    expect(charged?.name).toContain("Employee Pass −50%");
    // Half of $20.99 lands on 10.49/10.50 depending on the cent rounding rule;
    // what matters is the charge is the half, and the ledger figure is the rest.
    expect(totalPriceCents).toBeGreaterThanOrEqual(1049);
    expect(totalPriceCents).toBeLessThanOrEqual(1050);
    expect(employeeSavingsByMember.get("sam")).toBe(UNIT - totalPriceCents);
    expect(sqCents(sqLineItems)).toBe(totalPriceCents);
  });

  it("legacy single `employee` field (a session persisted before 09-14) still frees the heats", () => {
    const s = kioskRaceSession(
      [racer("sam", "Sam", samStamp)],
      [heatFor("sam", "2026-09-06T21:36")],
      undefined,
      { employee: samEmp } as unknown as Partial<BookingSession>,
    );
    const { totalPriceCents, employeeFree } = buildCombinedLineItems(s);
    expect(employeeFree.heats.size).toBe(1);
    expect(totalPriceCents).toBe(0);
  });
});

describe("unified pricing — TWO team members on one kiosk order", () => {
  const both = () =>
    kioskRaceSession(
      [racer("sam", "Sam", samStamp), racer("alex", "Alex", alexStamp), racer("jordan", "Jordan")],
      [
        heatFor("sam", "2026-09-06T21:36"),
        heatFor("alex", "2026-09-06T21:36"),
        heatFor("jordan", "2026-09-06T21:36"),
        heatFor("sam", "2026-09-06T21:48"),
        heatFor("alex", "2026-09-06T21:48"),
      ],
      [samEmp, alexEmp],
    );

  it("each employee spends THEIR OWN allowance: Sam 2 free, Alex 1 free + 1 at 50%, Jordan full price", () => {
    const { sqLineItems, pricedLines, totalPriceCents, employeeFree, employeeSavingsByMember } =
      buildCombinedLineItems(both());
    expect(employeeFree.heats.size).toBe(3);
    expect([...employeeFree.heats].map((h) => h.assignedTo).sort()).toEqual(["alex", "sam", "sam"]);
    expect(employeeFree.memberIds.sort()).toEqual(["alex", "sam"]);

    const free = sqLineItems.filter((l) => l.basePriceMoney?.amount === 0);
    expect(free).toHaveLength(1);
    expect(free[0].quantity).toBe("3");

    const full = sqLineItems.find((l) => l.basePriceMoney?.amount === UNIT);
    expect(full?.quantity).toBe("1"); // Jordan
    const half = sqLineItems.find(
      (l) => (l.basePriceMoney?.amount ?? 0) > 0 && (l.basePriceMoney?.amount ?? 0) < UNIT,
    );
    expect(half?.quantity).toBe("1"); // Alex's second heat
    expect(half?.name).toContain("Employee Pass −50%");

    // Savings land on Alex only — Sam's heats were all free, nothing to halve.
    expect(employeeSavingsByMember.get("sam")).toBeUndefined();
    expect(employeeSavingsByMember.get("alex")).toBe(UNIT - (half?.basePriceMoney?.amount ?? 0));

    expect(sqCents(sqLineItems)).toBe(totalPriceCents);
    expect(pricedLines.reduce((s, l) => s + l.unitCents * l.quantity, 0)).toBe(totalPriceCents);
  });

  it("the per-member savings helper agrees with the split lines", () => {
    const s = both();
    const { employeeFree } = buildCombinedLineItems(s);
    const savings = employeeRacingSavingsByMember(s, employeeFree.heats);
    expect(savings.get("sam")).toBeUndefined();
    expect(savings.get("alex")).toBeGreaterThan(0);
  });

  it("a member with the BMI Employee Pass membership AND a stamp shows $0 program savings (the membership's discount, not ours)", () => {
    const s = both();
    (s.party[0] as PartyMember).memberships = ["Employee Pass"];
    const { employeeSavingsByMember } = buildCombinedLineItems(s);
    expect(employeeSavingsByMember.get("sam")).toBeUndefined();
  });
});

describe("unified pricing — two team members on one kiosk gel line", () => {
  it("splits both employees' own units at 50%, the guest's unit at full price, savings per member", () => {
    const s: BookingSession = {
      ...emptySession({ entryBrand: "fasttrax" }),
      center: "fort-myers",
      context: { kiosk: true },
      party: [
        racer("sam", "Sam", samStamp),
        racer("alex", "Alex", alexStamp),
        racer("jordan", "J"),
      ],
      items: [
        {
          ...(newItem("attraction") as AttractionItem),
          id: "a1",
          slug: "gel-blaster",
          date: "2026-09-14",
          slot: "2026-09-14T19:15:00",
          qty: 3,
          productId: "8976680",
          price: 12,
          participants: ["sam", "alex", "jordan"],
          assignedTo: ["sam", "alex", "jordan"],
          bmiLineId: "63000000000000001",
        } as AttractionItem,
      ],
      employees: [samEmp, alexEmp],
    } as BookingSession;
    const { sqLineItems, totalPriceCents, employeeSavingsByMember } = buildCombinedLineItems(s);
    const split = sqLineItems.find((l) => l.name.includes("Employee Pass"));
    const guest = sqLineItems.find((l) => !l.name.includes("Employee Pass"));
    expect(split).toMatchObject({ quantity: "2", basePriceMoney: { amount: 600 } });
    expect(guest).toMatchObject({ quantity: "1", basePriceMoney: { amount: 1200 } });
    expect(totalPriceCents).toBe(2400);
    expect(employeeSavingsByMember.get("sam")).toBe(600);
    expect(employeeSavingsByMember.get("alex")).toBe(600);
  });
});
