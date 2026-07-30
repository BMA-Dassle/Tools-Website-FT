import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];

vi.mock("../data/voucher-claims-db", () => ({
  claimVoucher: vi.fn(),
  getClaimsByCode: vi.fn(async () => []),
  releaseVoucherClaim: vi.fn(async (code: string) => {
    calls.push("release:" + code);
  }),
}));
vi.mock("../data/vouchers-db", () => ({ logVoucherEvent: vi.fn(async () => {}) }));

async function mods() {
  return {
    svc: await import("./native-cart-vouchers"),
    claims: await import("../data/voucher-claims-db"),
  };
}

const BASE = "abc123def456";
const race = { code: "HPW4K7M9PQR", itemIndex: 0, name: "Race" };
const laser = { code: "HPW5P8C4PHE", itemIndex: 1, name: "Laser Tag" };

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe("claimNativeCartVouchers", () => {
  it("claims every voucher for the reserve, keyed by baseKey+code+item", async () => {
    const { svc, claims } = await mods();
    (claims.claimVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, claim: {} });

    const res = await svc.claimNativeCartVouchers({
      vouchers: [race, laser],
      baseKey: BASE,
      locationCode: 12,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claimed).toHaveLength(2);
    // Distinct, deterministic txn id per (reserve, code, item).
    expect(claims.claimVoucher).toHaveBeenCalledWith(
      expect.objectContaining({ code: race.code, itemIndex: 0, issuer: "native", txnId: `cart-${BASE}-${race.code}-0` }),
    );
  });

  it("a retry of the SAME reserve re-recognises its own claim (idempotent)", async () => {
    // Second pass: the CAS returns already_claimed, but the live claim is ours
    // (same txn id) → success, not a double-charge and not a hard fail.
    const { svc, claims } = await mods();
    (claims.claimVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "already_claimed",
    });
    (claims.getClaimsByCode as ReturnType<typeof vi.fn>).mockResolvedValue([
      { code: race.code, itemIndex: 0, status: "claimed", txnId: `cart-${BASE}-${race.code}-0` },
    ]);

    const res = await svc.claimNativeCartVouchers({ vouchers: [race], baseKey: BASE, locationCode: 12 });
    expect(res.ok).toBe(true);
  });

  it("hard-fails on a genuine double-spend and releases what it already took", async () => {
    // race claims fine; laser is held by ANOTHER reserve → conflict. The race
    // claim must be released so no partial charge lands.
    const { svc, claims } = await mods();
    (claims.claimVoucher as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, claim: {} }) // race
      .mockResolvedValueOnce({ ok: false, reason: "already_claimed" }); // laser
    (claims.getClaimsByCode as ReturnType<typeof vi.fn>).mockResolvedValue([
      { code: laser.code, itemIndex: 1, status: "claimed", txnId: "cart-SOMEONE-ELSE" },
    ]);

    const res = await svc.claimNativeCartVouchers({
      vouchers: [race, laser],
      baseKey: BASE,
      locationCode: 12,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflictCode).toBe(laser.code);
    expect(calls).toContain("release:" + race.code); // rolled back
  });
});

describe("releaseNativeCartVouchers", () => {
  it("releases each claim under this reserve's txn id", async () => {
    const { svc, claims } = await mods();
    await svc.releaseNativeCartVouchers({ vouchers: [race, laser], baseKey: BASE });
    expect(claims.releaseVoucherClaim).toHaveBeenCalledWith(
      race.code,
      `cart-${BASE}-${race.code}-0`,
      expect.any(String),
    );
    expect(claims.releaseVoucherClaim).toHaveBeenCalledWith(
      laser.code,
      `cart-${BASE}-${laser.code}-1`,
      expect.any(String),
    );
  });
});
