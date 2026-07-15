import { describe, it, expect } from "vitest";
import { TOKEN_PACKAGES, getPackage } from "./constants";

describe("token packages", () => {
  it("has the six owner-specified packages with correct token/price mapping", () => {
    const byId = Object.fromEntries(TOKEN_PACKAGES.map((p) => [p.id, p]));
    expect(byId["tok-50"]).toMatchObject({ priceCents: 500, tokens: 50, bonusTokens: 0 });
    expect(byId["tok-100"]).toMatchObject({ priceCents: 1000, tokens: 100, bonusTokens: 0 });
    expect(byId["tok-200"]).toMatchObject({ priceCents: 2000, tokens: 200, bonusTokens: 0 });
    expect(byId["tok-300"]).toMatchObject({ priceCents: 3000, tokens: 300, bonusTokens: 50 });
    expect(byId["tok-500"]).toMatchObject({ priceCents: 5000, tokens: 500, bonusTokens: 100 });
    expect(byId["tok-1000"]).toMatchObject({ priceCents: 10000, tokens: 1000, bonusTokens: 250 });
  });

  it("getPackage returns null for unknown ids (never trust client input)", () => {
    expect(getPackage("nope")).toBeNull();
    expect(getPackage("tok-500")?.bonusTokens).toBe(100);
  });
});
