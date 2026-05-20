import { describe, expect, it } from "vitest";
import { etWeekday, evaluateCode } from "./service";
import type { DiscountCodeRow } from "./types";

function makeRow(over: Partial<DiscountCodeRow> = {}): DiscountCodeRow {
  return {
    id: 1,
    code: "TEST20",
    description: "Test code",
    mechanic: "percent",
    amountPct: 20,
    amountCents: null,
    mechanicConfig: null,
    startsAt: "2026-05-01T00:00:00Z",
    expiresAt: "2026-06-01T00:00:00Z",
    allowedWeekdays: null,
    allowedLocations: null,
    scopes: { bowling: { experienceSlugs: null } },
    squareCatalogId: "SQ-CAT-123",
    squareCatalogType: "discount",
    squareDisplayName: null,
    marketingAccount: null,
    bmiPromoRef: null,
    maxUses: null,
    maxUsesPerCustomer: null,
    usesCount: 0,
    active: true,
    createdAt: "2026-05-01T00:00:00Z",
    createdBy: "admin",
    ...over,
  };
}

const inWindow = new Date("2026-05-20T12:00:00Z"); // Wed

describe("evaluateCode", () => {
  it("rejects unknown codes with reason=unknown", () => {
    const r = evaluateCode(null, { code: "X", domain: "bowling" }, inWindow);
    expect(r).toEqual({ valid: false, reason: "unknown" });
  });

  it("rejects inactive codes", () => {
    const r = evaluateCode(
      makeRow({ active: false }),
      { code: "TEST20", domain: "bowling" },
      inWindow,
    );
    expect(r).toEqual({ valid: false, reason: "inactive" });
  });

  it("rejects codes before their window", () => {
    const r = evaluateCode(
      makeRow(),
      { code: "TEST20", domain: "bowling" },
      new Date("2026-04-15T00:00:00Z"),
    );
    expect(r).toEqual({ valid: false, reason: "not_yet_active" });
  });

  it("rejects expired codes", () => {
    const r = evaluateCode(
      makeRow(),
      { code: "TEST20", domain: "bowling" },
      new Date("2026-07-01T00:00:00Z"),
    );
    expect(r).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects exhausted codes", () => {
    const r = evaluateCode(
      makeRow({ maxUses: 5, usesCount: 5 }),
      { code: "TEST20", domain: "bowling" },
      inWindow,
    );
    expect(r).toEqual({ valid: false, reason: "exhausted" });
  });

  it("rejects unsupported mechanics", () => {
    const r = evaluateCode(
      makeRow({ mechanic: "bogo" }),
      { code: "TEST20", domain: "bowling" },
      inWindow,
    );
    expect(r).toEqual({ valid: false, reason: "unsupported_mechanic" });
  });

  it("rejects locations not in the allowlist", () => {
    const r = evaluateCode(
      makeRow({ allowedLocations: ["TXBSQN0FEKQ11"] }),
      { code: "TEST20", domain: "bowling", locationId: "PPTR5G2N0QXF7" },
      inWindow,
    );
    expect(r).toEqual({ valid: false, reason: "wrong_location" });
  });

  it("accepts locations when none restricted", () => {
    const r = evaluateCode(
      makeRow({ allowedLocations: null }),
      { code: "TEST20", domain: "bowling", locationId: "PPTR5G2N0QXF7" },
      inWindow,
    );
    expect(r.valid).toBe(true);
  });

  it("rejects a domain that isn't in scopes", () => {
    const r = evaluateCode(
      makeRow({ scopes: { bowling: { experienceSlugs: null } } }),
      { code: "TEST20", domain: "racing" },
      inWindow,
    );
    expect(r).toEqual({ valid: false, reason: "wrong_domain" });
  });

  it("rejects a product slug not in the domain allowlist", () => {
    const r = evaluateCode(
      makeRow({ scopes: { bowling: { experienceSlugs: ["regular-mon-thur"] } } }),
      { code: "TEST20", domain: "bowling", productSlug: "midnight-madness" },
      inWindow,
    );
    expect(r).toEqual({ valid: false, reason: "wrong_product" });
  });

  it("accepts product slug in the domain allowlist", () => {
    const r = evaluateCode(
      makeRow({ scopes: { bowling: { experienceSlugs: ["regular-mon-thur"] } } }),
      { code: "TEST20", domain: "bowling", productSlug: "regular-mon-thur" },
      inWindow,
    );
    expect(r.valid).toBe(true);
  });

  it("accepts when domain scope has slugs=null (means 'all')", () => {
    const r = evaluateCode(
      makeRow({ scopes: { attractions: { slugs: null } } }),
      { code: "TEST20", domain: "attractions", productSlug: "gel-blaster" },
      inWindow,
    );
    expect(r.valid).toBe(true);
  });

  it("rejects bookings on a weekday outside allowedWeekdays", () => {
    const r = evaluateCode(
      makeRow({ allowedWeekdays: [1, 2, 3, 4] }), // Mon-Thu
      { code: "TEST20", domain: "bowling", bookingDate: "2026-05-23" }, // Sat (ET)
      inWindow,
    );
    expect(r).toEqual({ valid: false, reason: "wrong_weekday" });
  });

  it("accepts bookings on an allowed weekday", () => {
    const r = evaluateCode(
      makeRow({ allowedWeekdays: [1, 2, 3, 4] }),
      { code: "TEST20", domain: "bowling", bookingDate: "2026-05-20" }, // Wed
      inWindow,
    );
    expect(r.valid).toBe(true);
  });

  it("returns the Square catalog id for valid bowling codes", () => {
    const r = evaluateCode(makeRow(), { code: "TEST20", domain: "bowling" }, inWindow);
    expect(r).toMatchObject({ valid: true, squareCatalogId: "SQ-CAT-123", amountPct: 20 });
  });
});

describe("etWeekday", () => {
  it("returns 3 for a Wednesday in ET", () => {
    expect(etWeekday("2026-05-20")).toBe(3);
  });

  it("returns 6 for a Saturday in ET", () => {
    expect(etWeekday("2026-05-23")).toBe(6);
  });

  it("returns 0 for a Sunday in ET", () => {
    expect(etWeekday("2026-05-24")).toBe(0);
  });
});
