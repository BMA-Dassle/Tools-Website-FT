import { describe, it, expect } from "vitest";
import { VoucherRedeemSchema } from "./schemas";
import { GROUPON_CODE_RE, GROUPON_LONG_CODE_RE } from "~/features/groupon/codes";
import { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";
import { isNativeVoucherCode } from "./vouchers/codes";

/**
 * `VoucherRedeemSchema` is the ONE gate in front of every issuer's voucher, so
 * its length bound is a cross-issuer constraint, not a local detail. It drifted
 * once already and cost real money: the bound sat at 8 while Groupon mints 7-
 * and 8-character redemption codes, so every 7-char voucher redeemed at Groupon
 * on the scan path and then died at claim with a bare 400 — zero of twelve ever
 * dispensed a card between 2026-08-27 and 2026-09-11.
 *
 * The point of these tests is therefore NOT "7 works" (a literal that drifts
 * just as quietly). It is that the bound is DERIVED from the issuers' own shape
 * rules: widen a code regex without widening this schema and these fail.
 */

const claim = (code: string) =>
  VoucherRedeemSchema.safeParse({ action: "claim", code, locationCode: 1 });

/** Shortest string each issuer's own regex will accept, found by asking it. */
function shortestAccepted(re: RegExp, sample: (n: number) => string): number {
  for (let n = 1; n <= 64; n++) if (re.test(sample(n))) return n;
  throw new Error(`nothing up to 64 chars matches ${re}`);
}

describe("VoucherRedeemSchema — the length bound tracks every issuer", () => {
  it("accepts the SHORTEST code Groupon's own regex allows", () => {
    // Derived, not typed in: this is what actually broke. If GROUPON_CODE_RE is
    // ever widened again, this test widens with it and fails until the schema
    // follows.
    const n = shortestAccepted(GROUPON_CODE_RE, (n) => "1".repeat(n));
    expect(n).toBe(7);
    expect(claim("1".repeat(n)).success).toBe(true);
  });

  it("accepts the real production Groupon codes, 7- and 8-character", () => {
    // `2187728` is the live 7-char voucher the owner reported as not dispensing
    // (2026-09-11); `89895632` is the 8-char production unit burned on 8/20.
    for (const code of ["2187728", "89895632", "WNDXH4D", "WNDXH4DJ"]) {
      expect(GROUPON_CODE_RE.test(code)).toBe(true);
      expect(claim(code).success).toBe(true);
    }
  });

  it("accepts Groupon's unambiguous long form, and BMI's 24-char shape", () => {
    const long = "VS-P2NH-KFJH-F143-JYN5";
    expect(GROUPON_LONG_CODE_RE.test(long)).toBe(true);
    expect(claim(long).success).toBe(true);

    // BMI alternates [A-Z][2-9] twelve times — never 0 or 1, so a fixture
    // carrying them would pass the schema while silently failing the shape it
    // claims to represent.
    const bmi = "A2B3C4D5E6F7G8H9J2K3L4M5";
    expect(BMI_VOUCHER_RE.test(bmi)).toBe(true);
    expect(claim(bmi).success).toBe(true);
  });

  it("accepts our own HPW voucher shape", () => {
    const native = "HPW4K7M2QX9";
    expect(isNativeVoucherCode(native)).toBe(true);
    expect(claim(native).success).toBe(true);
  });

  it("still rejects codes shorter than any issuer mints", () => {
    // The bound is a real gate, not a formality — these are guessing-surface
    // reduction, and nothing legitimate is this short.
    expect(claim("123456").success).toBe(false);
    expect(claim("").success).toBe(false);
  });

  it("applies the same bound to EVERY action, not just claim", () => {
    // The 2026-09-11 outage was a claim-path failure, but `validate` shares this
    // schema and a mismatch there turns a good voucher into "that doesn't look
    // like a voucher code" at scan time instead.
    const code = "2187728";
    expect(VoucherRedeemSchema.safeParse({ action: "validate", code }).success).toBe(true);
    expect(VoucherRedeemSchema.safeParse({ action: "status", code }).success).toBe(true);
    expect(
      VoucherRedeemSchema.safeParse({
        action: "release",
        code,
        txnId: "3f1e6b8a-2c4d-4a7e-9b10-5d8c2f6a1e30",
      }).success,
    ).toBe(true);
    expect(
      VoucherRedeemSchema.safeParse({
        action: "to-card",
        code,
        accountNumber: "1038091",
        locationCode: 1,
      }).success,
    ).toBe(true);
  });
});
