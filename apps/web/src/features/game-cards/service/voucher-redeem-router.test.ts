import { afterEach, describe, expect, it, vi } from "vitest";

// validateNativeVoucher hits the DB — the router's job is only the routing.
vi.mock("./native-voucher", () => ({
  validateNativeVoucher: vi.fn(async (code: string) => ({
    ok: true,
    items: [{ index: 0, redeemVia: "gamezone", label: "mock", tokens: 100 }],
    codeMocked: code,
  })),
  claimNativeVoucher: vi.fn(),
  releaseNativeVoucher: vi.fn(),
}));
vi.mock("./voucher-card", () => ({
  claimGameCardVoucher: vi.fn(),
  releaseGameCardVoucher: vi.fn(),
}));

import { validateAnyVoucher, voucherIssuerFor } from "./voucher-redeem-router";
import { validateNativeVoucher } from "./native-voucher";

// Real shapes: ours is HPW-…; BMI's is the 24-char alternating form.
const NATIVE = "HPW-RKEM-G926";
const BMI = "H7D3B5B2X4B4D8R9Q5R2X4Q4";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("voucherIssuerFor", () => {
  it("classifies the three shapes", () => {
    expect(voucherIssuerFor(NATIVE)).toBe("native");
    expect(voucherIssuerFor(BMI)).toBe("bmi");
    expect(voucherIssuerFor("SUMMER26")).toBeNull();
  });
});

describe("validateAnyVoucher", () => {
  it("native codes delegate to validateNativeVoucher", async () => {
    const res = await validateAnyVoucher(NATIVE);
    expect(res.ok).toBe(true);
    expect(validateNativeVoucher).toHaveBeenCalledWith(NATIVE);
  });

  it("BMI comps answer UNSUPPORTED while parked — the kiosk learns at SCAN time", async () => {
    vi.stubEnv("GZ_VOUCHER_BMI", "");
    expect(await validateAnyVoucher(BMI)).toEqual({ ok: false, reason: "unsupported" });
    expect(validateNativeVoucher).not.toHaveBeenCalled();
  });

  it("BMI comps validate optimistically once the park flag lifts (claim stays authority)", async () => {
    vi.stubEnv("GZ_VOUCHER_BMI", "1");
    const res = await validateAnyVoucher(BMI);
    expect(res.ok).toBe(true);
  });

  it("unrecognized shapes are bad_format", async () => {
    expect(await validateAnyVoucher("SUMMER26")).toEqual({ ok: false, reason: "bad_format" });
  });
});
