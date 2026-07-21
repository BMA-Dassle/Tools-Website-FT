import { describe, expect, it } from "vitest";
import { formatPersonName, normalizeEmail } from "./name-format";

describe("formatPersonName", () => {
  it("title-cases ALL-CAPS CRM names", () => {
    expect(formatPersonName("JOHN SMITH")).toBe("John Smith");
  });

  it("title-cases lowercase input", () => {
    expect(formatPersonName("john")).toBe("John");
  });

  it("caps each hyphen/apostrophe segment", () => {
    expect(formatPersonName("mary-jane o'brien")).toBe("Mary-Jane O'Brien");
    expect(formatPersonName("D’ANGELO")).toBe("D’Angelo");
  });

  it("keeps deliberate interior caps", () => {
    expect(formatPersonName("McDonald")).toBe("McDonald");
    expect(formatPersonName("mcDonald")).toBe("McDonald");
  });

  it("collapses whitespace and trims", () => {
    expect(formatPersonName("  ana   maria ")).toBe("Ana Maria");
  });

  it("is empty-safe", () => {
    expect(formatPersonName("")).toBe("");
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail(" John@Example.COM ")).toBe("john@example.com");
  });

  it("is empty-safe", () => {
    expect(normalizeEmail("")).toBe("");
  });
});
