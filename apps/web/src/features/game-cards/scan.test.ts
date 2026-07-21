import { describe, expect, it } from "vitest";
import { cardNumberFromScan } from "./scan";

describe("cardNumberFromScan", () => {
  it("decodes the 1D barcode (straight number, leading zeros dropped)", () => {
    expect(cardNumberFromScan("0000000001061888")).toBe("1061888");
    expect(cardNumberFromScan("1061888")).toBe("1061888");
    expect(cardNumberFromScan(" 1061888 ")).toBe("1061888");
  });

  it("decodes the QR redirect URL", () => {
    expect(cardNumberFromScan("https://swflpassport.com/?id=1061888")).toBe("1061888");
    expect(cardNumberFromScan("https://swflpassport.com/?id=0001061888")).toBe("1061888");
    expect(cardNumberFromScan("http://swflpassport.com/?utm=x&id=42")).toBe("42");
    expect(cardNumberFromScan("https://headpinz.com/reload?id=1061888")).toBe("1061888");
  });

  it("extracts id from a non-URL payload as a fallback", () => {
    expect(cardNumberFromScan("swflpassport.com/?id=1061888")).toBe("1061888");
  });

  it("rejects codes that are not a game card", () => {
    expect(cardNumberFromScan("https://example.com/menu")).toBeNull();
    expect(cardNumberFromScan("WIFI:S:GuestNet;P:pass;;")).toBeNull();
    expect(cardNumberFromScan("hello")).toBeNull();
    expect(cardNumberFromScan("")).toBeNull();
    expect(cardNumberFromScan("0000")).toBeNull(); // zeros normalize to nothing
    expect(cardNumberFromScan("12345678901234567890")).toBeNull(); // 20 digits — too long
    expect(cardNumberFromScan("https://swflpassport.com/?id=abc")).toBeNull();
  });
});
