import { describe, expect, it } from "vitest";
import { cardTail, staffCardAccountFromScan } from "./staff-card";

describe("staffCardAccountFromScan", () => {
  it("takes the padded 1D barcode and strips the zero padding", () => {
    expect(staffCardAccountFromScan("0000000001063464")).toBe("1063464");
  });

  it("takes the BARE account too — the first live scan arrived unpadded (597195)", () => {
    expect(staffCardAccountFromScan("597195")).toBe("597195");
    expect(staffCardAccountFromScan("1062397")).toBe("1062397");
    expect(staffCardAccountFromScan("00597195")).toBe("597195");
    expect(staffCardAccountFromScan("123")).toBeNull(); // too short to be an account
  });

  it("takes the icardinc QR shortlink and the track-2 burst", () => {
    expect(staffCardAccountFromScan("https://www.swflpassport.com/?id=0001063464")).toBe("1063464");
    expect(staffCardAccountFromScan(";6283=1063464?")).toBe("1063464");
  });

  it("declines everything that is not a card", () => {
    expect(staffCardAccountFromScan("W56444")).toBeNull(); // booking
    expect(staffCardAccountFromScan("SUMMER26")).toBeNull(); // promo
    expect(staffCardAccountFromScan("HPW-4K7M-9PQR")).toBeNull(); // our voucher
    expect(staffCardAccountFromScan("sqgc://7783320012345678")).toBeNull(); // gift card
    expect(staffCardAccountFromScan("https://smstim.in/abc")).toBeNull();
    expect(staffCardAccountFromScan("")).toBeNull();
    expect(staffCardAccountFromScan("   ")).toBeNull();
  });

  it("card tail is the last four digits", () => {
    expect(cardTail("1063464")).toBe("3464");
  });
});
