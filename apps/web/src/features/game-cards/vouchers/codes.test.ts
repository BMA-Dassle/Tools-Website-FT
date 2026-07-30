import { describe, it, expect } from "vitest";
import {
  NATIVE_VOUCHER_PREFIX,
  VOUCHER_ALPHABET,
  formatVoucherCode,
  generateVoucherCode,
  isNativeVoucherCode,
  normalizeVoucherCode,
} from "./codes";
import { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";

describe("native voucher code format", () => {
  it("accepts the canonical and the printed/spoken forms", () => {
    expect(isNativeVoucherCode("HPW4K7M9PQR")).toBe(true);
    expect(isNativeVoucherCode("HPW-4K7M-9PQR")).toBe(true);
    expect(isNativeVoucherCode("hpw-4k7m-9pqr")).toBe(true);
    expect(isNativeVoucherCode("  HPW 4K7M 9PQR  ")).toBe(true);
  });

  it("normalizes to one stored form", () => {
    expect(normalizeVoucherCode("hpw-4k7m-9pqr")).toBe("HPW4K7M9PQR");
  });

  it("rejects wrong length, wrong prefix, and out-of-alphabet characters", () => {
    expect(isNativeVoucherCode("HPW4K7M9PQ")).toBe(false); // 7 body chars
    expect(isNativeVoucherCode("HPW4K7M9PQRS")).toBe(false); // 9
    expect(isNativeVoucherCode("XYZ4K7M9PQR")).toBe(false);
    expect(isNativeVoucherCode("HPW4K7M9PQ0")).toBe(false); // 0 excluded
    expect(isNativeVoucherCode("HPW4K7M9PQ1")).toBe(false); // 1 excluded
    expect(isNativeVoucherCode("HPW4K7M9PQI")).toBe(false); // I excluded
    expect(isNativeVoucherCode("HPW4K7M9PQ_")).toBe(false);
  });

  it("never silently strips an unexpected character into a DIFFERENT valid code", () => {
    // Only whitespace/hyphens are removed. A stray letter must fail, not be
    // dropped — otherwise "HPW4K7M9PQR!" would validate as someone else's code.
    expect(normalizeVoucherCode("HPW4K7M9PQR!")).toBe("HPW4K7M9PQR!");
    expect(isNativeVoucherCode("HPW4K7M9PQR!")).toBe(false);
  });

  it("uses an alphabet with no confusable members", () => {
    for (const bad of ["0", "1", "I", "L", "O", "U"]) {
      expect(VOUCHER_ALPHABET).not.toContain(bad);
    }
  });

  it("cannot be confused with a BMI voucher, in either direction", () => {
    // The two issuers are resolved locally by shape, so an overlap would send a
    // code to the wrong registry.
    expect(BMI_VOUCHER_RE.test("HPW4K7M9PQR")).toBe(false);
    expect(isNativeVoucherCode("D3X5Q4Z8M5C3Z4D3H6S3T4G3")).toBe(false);
  });

  it("formats for reading and round-trips", () => {
    expect(formatVoucherCode("HPW4K7M9PQR")).toBe("HPW-4K7M-9PQR");
    expect(normalizeVoucherCode(formatVoucherCode("HPW4K7M9PQR"))).toBe("HPW4K7M9PQR");
  });

  it("leaves a non-matching string alone when formatting", () => {
    expect(formatVoucherCode("SUMMER26")).toBe("SUMMER26");
  });
});

describe("generateVoucherCode", () => {
  it("produces valid codes drawn only from the alphabet", () => {
    // Deterministic sequence stands in for the CSPRNG.
    let i = 0;
    const seq = (max: number) => (i++ * 7) % max;
    for (let n = 0; n < 50; n++) {
      const code = generateVoucherCode(seq);
      expect(code.startsWith(NATIVE_VOUCHER_PREFIX)).toBe(true);
      expect(isNativeVoucherCode(code)).toBe(true);
    }
  });

  it("asks the generator for indices strictly inside the alphabet", () => {
    const seen: number[] = [];
    generateVoucherCode((max) => {
      seen.push(max);
      return 0;
    });
    expect(seen).toHaveLength(8);
    expect(new Set(seen)).toEqual(new Set([VOUCHER_ALPHABET.length]));
  });
});
