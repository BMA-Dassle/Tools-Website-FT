import { describe, it, expect } from "vitest";
import {
  diffSnapshots,
  diffVersionsAgainstLive,
  type ContractSnapshot,
  type ContractVersion,
} from "@/lib/group-function-db";

/**
 * Fixtures are the REAL rows from event 3370 / quote 166 (LPG Emergency Physicians,
 * HeadPinz Fort Myers, 2026-09-11) — the group that added food twice after signing.
 *
 * The shape that matters: a version row holds the contract as it stood BEFORE the change
 * it carries, so v4's snapshot is the contract BEFORE today's food was added. Diffing v3
 * against v4 — what the page used to do — renders week-old news, and today's $199.63 never
 * renders at all.
 */

const ITEMS_BEFORE_TODAY = [
  { name: "G/F Fri - Sun Cl 2hr VIP", price: 168, qty: 5, total: 840 },
  { name: 'GF Extra - 16" Pizza Cheese', price: 18, qty: 6, total: 108 },
  { name: 'GF Extra - 16" Pizza Pepperoni', price: 20, qty: 1, total: 20 },
  { name: 'G/F 16" Pizza BBQ Chicken', price: 19, qty: 1, total: 19 },
  { name: "GF Extra - Chicken Tenders (20)", price: 80, qty: 1, total: 80 },
  { name: "GF Chicken Tenders", price: 13, qty: 5, total: 65 },
  { name: "GF Extra - Spinach Artichoke Dip", price: 65, qty: 1, total: 65 },
  { name: "GF Extra - Chicken Teriyaki Potstickers", price: 45, qty: 1, total: 45 },
  { name: "15 Mini Sliders", price: 52, qty: 1, total: 52 },
  { name: "GF Extra - Coconut Shrimp", price: 68, qty: 2, total: 136 },
  { name: "GF Extra - Cookies (Small)", price: 75, qty: 1, total: 75 },
  { name: "GF Service Charge - 15%", price: 225.75, qty: 1, total: 225.75 },
];

// Today's BMI edit: +1 cheese pizza, +1 pepperoni, +1 tenders(20), +1 potstickers,
// and the 15% service charge riding the new subtotal. $187.45 + tax = $199.63.
const ITEMS_NOW = ITEMS_BEFORE_TODAY.map((li) => {
  switch (li.name) {
    case 'GF Extra - 16" Pizza Cheese':
      return { ...li, qty: 7, total: 126 };
    case 'GF Extra - 16" Pizza Pepperoni':
      return { ...li, qty: 2, total: 40 };
    case "GF Extra - Chicken Tenders (20)":
      return { ...li, qty: 2, total: 160 };
    case "GF Extra - Chicken Teriyaki Potstickers":
      return { ...li, qty: 2, total: 90 };
    case "GF Service Charge - 15%":
      return { ...li, price: 250.2, total: 250.2 };
    default:
      return li;
  }
});

function snapshot(over: Partial<ContractSnapshot>): ContractSnapshot {
  return {
    event_name: "LPG Emergency Physicians",
    event_number: "3370",
    event_date: "2026-09-11T22:00:00.000Z",
    event_date_display: "Sep 11 6:00 PM",
    guest_count: null,
    notes: null,
    guest_first_name: "Suzanne",
    guest_last_name: "Felt",
    guest_email: "guest@example.com",
    guest_phone: "816-810-9908",
    planner_first: null,
    planner_last: null,
    planner_email: null,
    planner_phone: null,
    total_cents: 184325,
    tax_cents: 11250,
    deposit_due_cents: 92163,
    balance_cents: 0,
    line_items: ITEMS_BEFORE_TODAY,
    ...over,
  };
}

// v3: cut 2026-09-02. Holds the state left by the 9/1 re-price.
const V3 = snapshot({ balance_cents: 132885, guest_phone: "239-" });
// v4: cut 2026-09-11 12:37 ET, just before today's food landed. Balance already zeroed by
// the 9/8 balance charge (a write that never made a version of its own).
const V4 = snapshot({});
// The live row after today's re-price.
const LIVE = snapshot({
  total_cents: 204288,
  tax_cents: 12468,
  deposit_due_cents: 204288, // flipped to the full total by the 96h dispatch rule
  balance_cents: 19963,
  line_items: ITEMS_NOW,
});

const versions = [
  { version_number: 3, snapshot: V3, changes: ["guest_phone"] },
  {
    version_number: 4,
    snapshot: V4,
    changes: ["total: 184325 → 204288", "balance: 0 → 19963", "line_items"],
  },
] as unknown as ContractVersion[];

const byField = (diffs: Array<{ field: string }>) => diffs.map((d) => d.field);
const find = (diffs: Array<{ field: string; before: string; after: string }>, field: string) =>
  diffs.find((d) => d.field === field);

describe("contract version diffs", () => {
  it("CONTROL: diffing the two newest snapshots reports the PREVIOUS revision", () => {
    // This is the old behaviour, kept as a control so the regression is unmistakable.
    // Suzanne was asked to re-sign for $199.63 of food under exactly this card.
    const stale = diffSnapshots(V3, V4);
    expect(byField(stale)).toEqual(["guest_phone", "balance_cents"]);
    expect(find(stale, "balance_cents")).toMatchObject({
      before: "$1,328.85",
      after: "$0.00",
    });
    // The money she is actually being asked to approve is nowhere in it.
    expect(byField(stale)).not.toContain("total_cents");
  });

  it("pairs the newest version with the live row, so today's change is the one shown", () => {
    const paired = diffVersionsAgainstLive(versions, LIVE);
    const newest = paired[paired.length - 1];

    expect(newest.version.version_number).toBe(4);
    expect(find(newest.diffs, "total_cents")).toMatchObject({
      before: "$1,843.25",
      after: "$2,042.88",
    });
    expect(find(newest.diffs, "balance_cents")).toMatchObject({
      before: "$0.00",
      after: "$199.63",
    });
    // The balance delta is the money resign-settle will charge: total − collected.
    expect(LIVE.total_cents - 184325).toBe(19963);
  });

  it("pairs every older version with the snapshot above it, not below", () => {
    const paired = diffVersionsAgainstLive(versions, LIVE);
    // v3's own row describes the 9/2 phone change; its diff must be that change.
    expect(byField(paired[0].diffs)).toEqual(["guest_phone", "balance_cents"]);
    expect(paired[0].version.changes).toEqual(["guest_phone"]);
  });

  it("reports only the products that moved, not the whole menu", () => {
    const products = find(diffSnapshots(V4, LIVE), "line_items");
    expect(products).toBeDefined();

    // Four quantity changes plus the percentage service charge — out of twelve lines.
    expect(products!.before).toBe(
      'GF Extra - 16" Pizza Cheese x6, GF Extra - 16" Pizza Pepperoni x1, ' +
        "GF Extra - Chicken Tenders (20) x1, GF Extra - Chicken Teriyaki Potstickers x1, " +
        "GF Service Charge - 15% $225.75",
    );
    expect(products!.after).toBe(
      'GF Extra - 16" Pizza Cheese x7, GF Extra - 16" Pizza Pepperoni x2, ' +
        "GF Extra - Chicken Tenders (20) x2, GF Extra - Chicken Teriyaki Potstickers x2, " +
        "GF Service Charge - 15% $250.20",
    );
    // Untouched lines stay out of it entirely.
    expect(products!.before).not.toContain("Coconut Shrimp");
    expect(products!.after).not.toContain("Coconut Shrimp");
  });

  it("names an added product on one side only", () => {
    const added = snapshot({
      line_items: [
        ...ITEMS_BEFORE_TODAY,
        { name: "GF Extra - Wings", price: 60, qty: 1, total: 60 },
      ],
    });
    const products = find(diffSnapshots(V4, added), "line_items");
    expect(products!.before).toBe("(none)");
    expect(products!.after).toBe("GF Extra - Wings x1");
  });

  it("stays silent when the product list is merely reordered", () => {
    const reordered = snapshot({ line_items: [...ITEMS_BEFORE_TODAY].reverse() });
    expect(byField(diffSnapshots(V4, reordered))).not.toContain("line_items");
  });

  it("surfaces the 96h deposit flip for staff (the guest page filters it)", () => {
    // Kept generic here on purpose: /contract/[shortId] drops this field once the deposit
    // is paid, but admin version history should still see it.
    expect(byField(diffSnapshots(V4, LIVE))).toContain("deposit_due_cents");
  });
});
