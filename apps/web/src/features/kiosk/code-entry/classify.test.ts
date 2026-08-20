import { describe, expect, it } from "vitest";
import { BMI_VOUCHER_RE, classifyKioskCode } from "./classify";

// Real payloads from the owner's live-scanner capture (2026-07-27) — the
// classifier's ground truth. See tasks/future/kiosk-coupons-vouchers.md § 1b.
describe("classifyKioskCode", () => {
  it("recognizes a BMI voucher number (live capture)", () => {
    expect(classifyKioskCode("C2D8M8D6M6C9M9U9U5K7Q6R9")).toMatchObject({
      kind: "bmi-voucher",
      value: "C2D8M8D6M6C9M9U9U5K7Q6R9",
    });
  });

  it("recognizes every code shape from the 32-code BMI Office batch", () => {
    const batch = [
      "X7A3M4D3G6Q5S4R6D5M7U7K8",
      "Z9G3S2C6T9Q9R3M7K6G2R2U6",
      "Q5K5H5P5Q6M3G9Z5C8X7Z7S3",
      "S6U9X6R5R6S3A9R3X4X3Z4Z4",
      "K9C5C3A6U9B8B6C5U6T9A6M3",
    ];
    for (const code of batch) expect(BMI_VOUCHER_RE.test(code)).toBe(true);
  });

  it("normalizes lowercase + spaced voucher input (typed on the OSK)", () => {
    expect(classifyKioskCode(" c2d8 m8d6 m6c9 m9u9 u5k7 q6r9 ")).toMatchObject({
      kind: "bmi-voucher",
      value: "C2D8M8D6M6C9M9U9U5K7Q6R9",
    });
  });

  it("does NOT voucher-match codes with 0/1 digits or wrong length", () => {
    // 0/1 never appear in BMI codes (lookalike-free alphabet).
    expect(classifyKioskCode("C1D8M8D6M6C9M9U9U5K7Q6R9").kind).toBe("promo");
    expect(classifyKioskCode("C2D8M8D6M6C9M9U9U5K7Q6").kind).toBe("promo");
  });

  it("recognizes the game-card QR shortlink (live capture)", () => {
    expect(classifyKioskCode("https://icardinc.net/063PFZHQEAKEQ0A6M5")).toMatchObject({
      kind: "game-card",
    });
  });

  it("recognizes the game-card 1D barcode and strips zero padding (live capture)", () => {
    expect(classifyKioskCode("0000000001063464")).toMatchObject({
      kind: "game-card",
      value: "1063464",
    });
  });

  it("recognizes an MSR track-2 burst", () => {
    expect(classifyKioskCode(";6283=1063464?")).toMatchObject({
      kind: "game-card",
      value: "1063464",
    });
  });

  it("recognizes both Square gift-card payloads (live capture)", () => {
    expect(classifyKioskCode("sqgc://7783324218120014")).toMatchObject({
      kind: "gift-card",
      value: "7783324218120014",
    });
    expect(
      classifyKioskCode("https://squareup.com/gift/balance/359d3e06fed34f6ebb0d51198404a3d4").kind,
    ).toBe("gift-card");
  });

  it("extracts a coupon code from our printed QR URL", () => {
    expect(classifyKioskCode("https://headpinz.com/book/v2?code=SUMMER26")).toMatchObject({
      kind: "promo",
      value: "SUMMER26",
    });
  });

  it("re-classifies a voucher code inside a /v/ deep link", () => {
    expect(classifyKioskCode("https://headpinz.com/v/C2D8M8D6M6C9M9U9U5K7Q6R9")).toMatchObject({
      kind: "bmi-voucher",
    });
  });

  it("treats short alphanumerics as promo candidates (server decides)", () => {
    expect(classifyKioskCode("SUMMER26").kind).toBe("promo");
    expect(classifyKioskCode("usa250").value).toBe("USA250");
  });

  it("flags unmappable URLs as unknown", () => {
    expect(classifyKioskCode("https://example.com/whatever").kind).toBe("unknown");
  });
});

describe("our own vouchers (HPW…)", () => {
  it("classifies the canonical, hyphenated and lowercase forms", () => {
    // Regression: HPW codes were reaching the PROMO validator (which of course
    // doesn't know them) and the guest was told "we couldn't find that code"
    // for a perfectly good voucher. Live-caught on preview 2026-07-29.
    for (const raw of ["HPWRKEMG926", "HPW-RKEM-G926", "hpw-rkem-g926", " HPW RKEM G926 "]) {
      const c = classifyKioskCode(raw);
      expect(c.kind).toBe("native-voucher");
      expect(c.value).toBe("HPWRKEMG926");
    }
  });

  it("classifies the emailed /v/{code} QR payload", () => {
    const c = classifyKioskCode("https://headpinz.com/v/HPWRKEMG926");
    expect(c.kind).toBe("native-voucher");
    expect(c.value).toBe("HPWRKEMG926");
  });

  it("keeps a promo code a promo", () => {
    expect(classifyKioskCode("SUMMER26").kind).toBe("promo");
    // Near-misses must NOT become vouchers.
    expect(classifyKioskCode("HPWRKEMG92").kind).toBe("promo"); // 7 body chars
    expect(classifyKioskCode("HPWRKEMG9260").kind).toBe("promo"); // 9
  });

  it("still classifies a BMI voucher as BMI", () => {
    expect(classifyKioskCode("D3X5Q4Z8M5C3Z4D3H6S3T4G3").kind).toBe("bmi-voucher");
  });
});

// `89895632` and `VS-GCMV-VNXS-4YN4-2V4X` are a REAL production Groupon unit
// (fetched 2026-08-20, $65 value, still unredeemed at the time of writing).
// Groupon's short code is 8 alphanumerics, which overlaps two shapes this
// screen already accepts — so the rule here is that the hint may be added but
// no existing input may change `kind`.
describe("classifyKioskCode — Groupon", () => {
  it("keeps a real 8-DIGIT Groupon code a game-card, and flags it", () => {
    // The collision that makes shape-based routing impossible: this is
    // indistinguishable from an unpadded Intercard account. Kind must NOT move,
    // or every game card scanned today changes meaning.
    expect(classifyKioskCode("89895632")).toMatchObject({
      kind: "game-card",
      value: "89895632",
      grouponCandidate: true,
    });
  });

  it("routes the printed VS- long form straight to Groupon", () => {
    expect(classifyKioskCode("VS-GCMV-VNXS-4YN4-2V4X")).toMatchObject({
      kind: "groupon",
      value: "VS-GCMV-VNXS-4YN4-2V4X",
      grouponCandidate: true,
    });
  });

  it("normalizes a lowercase / space-padded VS- form (typed on the OSK)", () => {
    expect(classifyKioskCode("  vs-gcmv-vnxs-4yn4-2v4x ")).toMatchObject({
      kind: "groupon",
      value: "VS-GCMV-VNXS-4YN4-2V4X",
    });
  });

  it("keeps an 8-char alphanumeric Groupon code a promo, and flags it", () => {
    // The staging code. Promo priority is deliberate: an existing 8-character
    // promo must keep working, so Groupon is only ever the fallback.
    expect(classifyKioskCode("WNDXH4DJ")).toMatchObject({
      kind: "promo",
      grouponCandidate: true,
    });
  });

  it("flags a real promo code too — the overlap is accepted, not resolved here", () => {
    // SUMMER26 is 8 alphanumerics, so it is a Groupon candidate on shape alone.
    // Harmless: the promo validator answers first and the fallback never runs.
    expect(classifyKioskCode("SUMMER26")).toMatchObject({
      kind: "promo",
      grouponCandidate: true,
    });
  });

  it("does NOT flag a padded 16-digit game-card barcode", () => {
    const c = classifyKioskCode("0000000001038091");
    expect(c.kind).toBe("game-card");
    expect(c.value).toBe("1038091");
    expect(c.grouponCandidate).toBeFalsy();
  });

  it("does NOT flag shapes that are already unambiguous", () => {
    expect(classifyKioskCode("HPWRKEMG926").grouponCandidate).toBeFalsy();
    expect(classifyKioskCode("D3X5Q4Z8M5C3Z4D3H6S3T4G3").grouponCandidate).toBeFalsy();
    expect(
      classifyKioskCode("https://icardinc.net/063PFZHQEAKEQ0A6M5").grouponCandidate,
    ).toBeFalsy();
  });
});
