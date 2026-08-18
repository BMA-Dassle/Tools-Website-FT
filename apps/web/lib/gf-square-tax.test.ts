import { describe, expect, it } from "vitest";

/**
 * The day-of order must book tax as TAX and the service charge as a SERVICE CHARGE.
 *
 * These lock the two halves of the 2026-08-17 misclassification (see gf-square-tax.ts):
 * tax used to be written into `service_charges` and the service charge into a
 * "Legacy Service Charge" merchandise line — right total, both slots wrong.
 *
 * The fixtures are real contract shapes, not tidy ones: GF-3471 (Fort Myers, flat 6.5%),
 * Naples 1244 (6.0% with a 6.59% soda line — the case that rules out an order-scope tax),
 * and a mixed taxable/untaxed Fort Myers event.
 */

import { buildDayofOrderShape, GF_TAX_INTERNALS, type GfTaxProduct } from "./gf-square-tax";

const HPFM = "TXBSQN0FEKQ11";
const NAPLES = "PPTR5G2N0QXF7";
const LEE = "UBPQTR3W6ZKVRYFC7DXN2SJN";
const COLLIER = "BQNVIEEZQO2PX2FI72U6FEC4";
const {
  ALCOHOL_TAX_ID,
  TIER_SERVICE_CHARGE,
  TIER_SERVICE_CHARGE_TAX_EXEMPT,
  CUSTOM_SERVICE_CHARGE_ID,
} = GF_TAX_INTERNALS;

const p = (over: Partial<GfTaxProduct>): GfTaxProduct => ({
  name: "GF Thing",
  price: 100,
  qty: 1,
  total: 100,
  tax: 0.065,
  plu: "QYQJCZM6CJL7OEV3VE2NZ7U3",
  ...over,
});

/** GF-3471: $961.50 merchandise, $144.22 service charge (15%), all lines at 6.5%. */
const GF3471: GfTaxProduct[] = [
  p({ name: "GF Nexus Laser Tag", price: 450, total: 450 }),
  p({ name: "GF Well liquor", price: 5, qty: 20, total: 100 }),
  p({ name: "Nemos Wings", price: 411.5, total: 411.5 }),
  p({
    name: "GF Service Charge - 15%",
    price: 144.22,
    total: 144.22,
    plu: "IBXWNWIZRCEY4B4RXK4JXD5G",
  }),
];

const shapeOf = (products: GfTaxProduct[], locationId = HPFM, taxExempt = false) =>
  buildDayofOrderShape({ centerCode: "fort-myers", locationId, products, taxExempt });

describe("buildDayofOrderShape", () => {
  it("moves the service charge out of the line items and into service_charges", () => {
    const shape = shapeOf(GF3471)!;
    expect(shape.line_items).toHaveLength(3);
    // The "Legacy Service Charge" catalog id must never appear as merchandise again.
    expect(JSON.stringify(shape.line_items)).not.toContain("IBXWNWIZRCEY4B4RXK4JXD5G");
    expect(shape.service_charges).toHaveLength(1);
  });

  it("books tax as a catalog TAX object, never as a service charge", () => {
    const shape = shapeOf(GF3471)!;
    expect(shape.taxes).toEqual([
      { uid: "gf-county-tax", catalog_object_id: LEE, scope: "LINE_ITEM" },
    ]);
    // no amount-bearing service charge masquerading as tax
    expect(shape.service_charges![0].amount_money).toBeUndefined();
  });

  it("picks the tiered service charge when the contract amount lands on a tier", () => {
    const shape = shapeOf(GF3471)!;
    expect(shape.service_charges![0]).toMatchObject({
      catalog_object_id: TIER_SERVICE_CHARGE[15],
      applied_taxes: [{ tax_uid: "gf-county-tax" }],
    });
  });

  it("taxes the service charge, because BMI taxes it", () => {
    const shape = shapeOf(GF3471)!;
    expect(shape.service_charges![0].applied_taxes).toEqual([{ tax_uid: "gf-county-tax" }]);
  });

  it("falls back to the amount-based custom charge when the service charge is off-tier", () => {
    // $200 on $961.50 is 20.8% — no tier. Must carry the exact contract amount.
    const products = GF3471.map((x) =>
      x.plu === "IBXWNWIZRCEY4B4RXK4JXD5G" ? { ...x, price: 200, total: 200 } : x,
    );
    const shape = shapeOf(products)!;
    expect(shape.service_charges![0]).toMatchObject({
      catalog_object_id: CUSTOM_SERVICE_CHARGE_ID,
      amount_money: { amount: 20000, currency: "USD" },
    });
  });

  it("stacks the alcohol tax only on the lines whose BMI rate calls for it", () => {
    const naples: GfTaxProduct[] = [
      p({ name: "VIP GF Fri-Sun 2hr", price: 672, total: 672, tax: 0.06 }),
      p({ name: "Soda Pitchers", price: 28, total: 28, tax: 0.0659 }),
      p({
        name: "GF Service Charge 15%",
        price: 105,
        total: 105,
        tax: 0.06,
        plu: "IBXWNWIZRCEY4B4RXK4JXD5G",
      }),
    ];
    const shape = buildDayofOrderShape({
      centerCode: "naples",
      locationId: NAPLES,
      products: naples,
      taxExempt: false,
    })!;

    expect(shape.taxes).toEqual([
      { uid: "gf-county-tax", catalog_object_id: COLLIER, scope: "LINE_ITEM" },
      { uid: "gf-alcohol-tax", catalog_object_id: ALCOHOL_TAX_ID, scope: "LINE_ITEM" },
    ]);
    expect(shape.line_items[0].applied_taxes).toEqual([{ tax_uid: "gf-county-tax" }]);
    expect(shape.line_items[1].applied_taxes).toEqual([
      { tax_uid: "gf-county-tax" },
      { tax_uid: "gf-alcohol-tax" },
    ]);
  });

  it("leaves a genuinely untaxed line untaxed instead of sweeping it into an order-scope tax", () => {
    const shape = shapeOf([
      p({ name: "Taxable thing", total: 100, tax: 0.065 }),
      p({ name: "Untaxed thing", total: 50, tax: 0 }),
    ])!;
    expect(shape.line_items[0].applied_taxes).toEqual([{ tax_uid: "gf-county-tax" }]);
    expect(shape.line_items[1].applied_taxes).toBeUndefined();
    expect(shape.taxes).toHaveLength(1);
  });

  it("emits no taxes at all for a tax-exempt event, and uses the T/E service charge", () => {
    const shape = shapeOf(GF3471, HPFM, true)!;
    expect(shape.taxes).toBeUndefined();
    expect(shape.service_charges![0]).toMatchObject({
      catalog_object_id: TIER_SERVICE_CHARGE_TAX_EXEMPT[15],
    });
    expect(shape.service_charges![0].applied_taxes).toBeUndefined();
    for (const li of shape.line_items) expect(li.applied_taxes).toBeUndefined();
  });

  it("refuses (null) an unmapped location rather than guessing a jurisdiction", () => {
    expect(shapeOf(GF3471, "LSOMEWHEREELSE")).toBeNull();
  });

  it("refuses (null) a per-line rate it cannot express, rather than approximating it", () => {
    // 4% inclusive video-game tax is neither the county rate nor county+alcohol.
    expect(shapeOf([p({ tax: 0.04 })])).toBeNull();
  });

  it("refuses (null) a contract that is nothing but a service charge", () => {
    expect(shapeOf([p({ name: "Service Charge", plu: "IBXWNWIZRCEY4B4RXK4JXD5G" })])).toBeNull();
  });

  it("collapses MULTIPLE service-charge lines into one, leaving none as merchandise", () => {
    // H3222: two identical "GF Service Charge - 15%" lines, one per section. An early
    // `.find` lifted only the first and left the second booked as merchandise.
    const twoCharges: GfTaxProduct[] = [
      p({ name: "GF Duckpin Per Hour", price: 30, qty: 8, total: 240 }),
      p({ name: "GF Race Blue Starter", price: 399.99, total: 399.99 }),
      p({
        name: "GF Service Charge - 15%",
        price: 159.82,
        total: 159.82,
        plu: "IBXWNWIZRCEY4B4RXK4JXD5G",
      }),
      p({
        name: "GF Service Charge - 15%",
        price: 159.82,
        total: 159.82,
        plu: "IBXWNWIZRCEY4B4RXK4JXD5G",
      }),
    ];
    const shape = shapeOf(twoCharges)!;
    expect(shape.line_items).toHaveLength(2);
    expect(JSON.stringify(shape.line_items)).not.toContain("IBXWNWIZRCEY4B4RXK4JXD5G");
    expect(shape.service_charges).toHaveLength(1);
    // both lines summed: $159.82 + $159.82
    expect(shape.service_charges![0]).toMatchObject({
      catalog_object_id: CUSTOM_SERVICE_CHARGE_ID,
      amount_money: { amount: 31964, currency: "USD" },
    });
  });

  it("refuses (null) service-charge lines whose tax treatment disagrees", () => {
    expect(
      shapeOf([
        p({ name: "Thing", total: 100 }),
        p({ name: "Service Charge", total: 50, tax: 0.065, plu: "IBXWNWIZRCEY4B4RXK4JXD5G" }),
        p({ name: "Service Charge", total: 50, tax: 0, plu: "IBXWNWIZRCEY4B4RXK4JXD5G" }),
      ]),
    ).toBeNull();
  });

  it("omits service_charges entirely when the contract has none", () => {
    const shape = shapeOf([p({ total: 100 })])!;
    expect(shape.service_charges).toBeUndefined();
    expect(shape.line_items).toHaveLength(1);
  });

  it("keeps the catalog link on every merchandise line (item-sales attribution)", () => {
    const shape = shapeOf(GF3471)!;
    for (const li of shape.line_items) {
      expect(li.catalog_object_id).toBe("QYQJCZM6CJL7OEV3VE2NZ7U3");
      expect(li.base_price_money).toBeDefined();
    }
  });
});
