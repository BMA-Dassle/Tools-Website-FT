import { describe, expect, it } from "vitest";
import { resolveAttractionContext } from "./attractions";
import { emptySession } from "../state/types";
import type { BookingSession } from "../state/types";

function session(args: {
  center?: BookingSession["center"];
  entryBrand?: BookingSession["entryBrand"];
}): BookingSession {
  const s = emptySession({ entryBrand: args.entryBrand ?? "headpinz" });
  return { ...s, center: args.center ?? null };
}

/**
 * Regression suite for the 2026-07-20 Naples misroute: brand-based resolution
 * ("headpinz" ≡ HP Fort Myers) sent every Naples gel-blaster / laser-tag
 * booking into the Fort Myers BMI. The CENTER must win.
 */
describe("resolveAttractionContext", () => {
  it("Naples session resolves Naples products + the Naples BMI client key", () => {
    for (const slug of ["gel-blaster", "laser-tag"]) {
      const ctx = resolveAttractionContext(slug, session({ center: "naples" }));
      expect(ctx?.location).toBe("naples");
      expect(ctx?.clientKey).toBe("headpinznaples");
    }
  });

  it("Naples gel-blaster resolves the Naples product id, not Fort Myers'", () => {
    const ctx = resolveAttractionContext("gel-blaster", session({ center: "naples" }));
    const ids = ctx!.config.products
      .filter((p) => p.location === ctx!.location)
      .map((p) => p.productId);
    expect(ids).toEqual(["7565025"]);
  });

  it("Fort Myers HeadPinz entry keeps resolving HP Fort Myers (default client key)", () => {
    for (const slug of ["gel-blaster", "laser-tag"]) {
      const ctx = resolveAttractionContext(
        slug,
        session({ center: "fort-myers", entryBrand: "headpinz" }),
      );
      expect(ctx?.location).toBe("headpinz");
      expect(ctx?.clientKey).toBeUndefined();
    }
  });

  it("FastTrax entry at Fort Myers falls back to headpinz for HP-only attractions", () => {
    const ctx = resolveAttractionContext(
      "gel-blaster",
      session({ center: "fort-myers", entryBrand: "fasttrax" }),
    );
    expect(ctx?.location).toBe("headpinz");
  });

  it("FastTrax-only attractions stay FastTrax for Fort Myers sessions", () => {
    const ctx = resolveAttractionContext(
      "duck-pin",
      session({ center: "fort-myers", entryBrand: "fasttrax" }),
    );
    expect(ctx?.location).toBe("fasttrax");
    expect(ctx?.clientKey).toBeUndefined();
  });

  it("shuffly (no Naples products) keeps brand resolution even for a naples center", () => {
    const ctx = resolveAttractionContext(
      "shuffly",
      session({ center: "naples", entryBrand: "headpinz" }),
    );
    expect(ctx?.location).toBe("headpinz");
  });

  it("returns null for an unknown slug", () => {
    expect(resolveAttractionContext("nonsense", session({}))).toBeNull();
  });
});
