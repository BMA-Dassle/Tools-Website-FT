import { describe, expect, it } from "vitest";
import { __testMockCatalog, __testRealCatalog } from "./square-catalog";

describe("squareCatalogAdapter (mock)", () => {
  it("findByBmiItemId returns a Square-shaped item for a known race product", async () => {
    const item = await __testMockCatalog.findByBmiItemId("24960859"); // Starter Race Red weekday new
    expect(item).not.toBeNull();
    expect(item?.name).toBe("Starter Race Red");
    expect(item?.priceCents).toBe(2099); // $20.99
    expect(item?.bmiItemId).toBe("24960859");
    expect(item?.bookingActivity).toBe("race");
    expect(item?.catalogObjectId).toMatch(/^mock-cat-/);
  });

  it("findByBmiItemId returns null for an unknown BMI id", async () => {
    expect(await __testMockCatalog.findByBmiItemId("99999999")).toBeNull();
  });

  it("findByBookingActivity('race') returns multiple items", async () => {
    const items = await __testMockCatalog.findByBookingActivity("race");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.bookingActivity === "race")).toBe(true);
    expect(items.every((i) => i.priceCents > 0)).toBe(true);
  });

  it("findByBookingActivity('nonsense') returns empty array", async () => {
    expect(await __testMockCatalog.findByBookingActivity("nonsense")).toEqual([]);
  });

  it("getById resolves a mock catalog id back to its source item", async () => {
    const item = await __testMockCatalog.getById("mock-cat-24960859");
    expect(item?.bmiItemId).toBe("24960859");
  });

  it("getById returns null for malformed catalog ids", async () => {
    expect(await __testMockCatalog.getById("not-a-mock-id")).toBeNull();
  });
});

describe("squareCatalogAdapter (real impl placeholder)", () => {
  it("findByBmiItemId throws until wired in commit 10", async () => {
    await expect(__testRealCatalog.findByBmiItemId("x")).rejects.toThrow(/commit 10/);
  });

  it("findByBookingActivity throws until wired in commit 10", async () => {
    await expect(__testRealCatalog.findByBookingActivity("race")).rejects.toThrow(/commit 10/);
  });

  it("getById throws until wired in commit 10", async () => {
    await expect(__testRealCatalog.getById("x")).rejects.toThrow(/commit 10/);
  });
});
