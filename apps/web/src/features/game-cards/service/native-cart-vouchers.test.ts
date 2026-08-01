import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];

vi.mock("../data/voucher-claims-db", () => ({
  claimVoucher: vi.fn(),
  getClaimsByCode: vi.fn(async () => []),
  releaseVoucherClaim: vi.fn(async (code: string) => {
    calls.push("release:" + code);
  }),
  markVoucherClaimSpent: vi.fn(async (code: string) => {
    calls.push("spent:" + code);
    return true;
  }),
  listStaleCartClaims: vi.fn(async () => []),
}));
vi.mock("../data/vouchers-db", () => ({
  logVoucherEvent: vi.fn(async () => {}),
  hasChargedRedeemEvent: vi.fn(async () => false),
}));

async function mods() {
  return {
    svc: await import("./native-cart-vouchers"),
    claims: await import("../data/voucher-claims-db"),
    vouchers: await import("../data/vouchers-db"),
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
      expect.objectContaining({
        code: race.code,
        itemIndex: 0,
        issuer: "native",
        txnId: `cart-${BASE}-${race.code}-0`,
      }),
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

    const res = await svc.claimNativeCartVouchers({
      vouchers: [race],
      baseKey: BASE,
      locationCode: 12,
    });
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

  it("falls over to an equivalent SUBSTITUTE leg when the named leg is spent", async () => {
    // The session names leg 1 (spent by an earlier checkout) but leg 3 — same
    // code, same coverage — is unallocated and unspent (owner repro
    // 2026-08-01, W56657): the claim must spend leg 3, not fail the booking.
    const { svc, claims } = await mods();
    const leg1 = { code: "HPWZ96RZ4SX", itemIndex: 1, name: "Laser Tag or Gel Blaster" };
    const leg3 = { code: "HPWZ96RZ4SX", itemIndex: 3, name: "Laser Tag or Gel Blaster" };
    (claims.claimVoucher as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, reason: "already_claimed" }) // leg 1 → spent
      .mockResolvedValueOnce({ ok: true, claim: {} }); // leg 3 → ours
    (claims.getClaimsByCode as ReturnType<typeof vi.fn>).mockResolvedValue([
      { code: leg1.code, itemIndex: 1, status: "spent", txnId: "cart-SOMEONE-ELSE" },
    ]);

    const res = await svc.claimNativeCartVouchers({
      vouchers: [leg1],
      baseKey: BASE,
      locationCode: 12,
      substitutes: new Map([[`${leg1.code}:1`, [leg3]]]),
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claimed).toHaveLength(1);
      expect(res.claimed[0].itemIndex).toBe(3); // the twin, not the spent leg
    }
    expect(claims.claimVoucher).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemIndex: 3, txnId: `cart-${BASE}-${leg3.code}-3` }),
    );
  });

  it("still hard-fails when the substitute is spent too", async () => {
    const { svc, claims } = await mods();
    const leg1 = { code: "HPWZ96RZ4SX", itemIndex: 1, name: "Laser Tag or Gel Blaster" };
    const leg3 = { code: "HPWZ96RZ4SX", itemIndex: 3, name: "Laser Tag or Gel Blaster" };
    (claims.claimVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "already_claimed",
    });
    (claims.getClaimsByCode as ReturnType<typeof vi.fn>).mockResolvedValue([
      { code: leg1.code, itemIndex: 1, status: "spent", txnId: "cart-SOMEONE-ELSE" },
      { code: leg1.code, itemIndex: 3, status: "spent", txnId: "cart-SOMEONE-ELSE-2" },
    ]);

    const res = await svc.claimNativeCartVouchers({
      vouchers: [leg1],
      baseKey: BASE,
      locationCode: 12,
      substitutes: new Map([[`${leg1.code}:1`, [leg3]]]),
    });
    expect(res.ok).toBe(false);
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

describe("markNativeCartVouchersCharged (capture → terminal 'spent')", () => {
  it("flips every claim to spent under this reserve's txn id and logs the redemption", async () => {
    const { svc, claims, vouchers } = await mods();
    await svc.markNativeCartVouchersCharged({ vouchers: [race, laser], baseKey: BASE });
    expect(claims.markVoucherClaimSpent).toHaveBeenCalledWith(
      race.code,
      `cart-${BASE}-${race.code}-0`,
    );
    expect(claims.markVoucherClaimSpent).toHaveBeenCalledWith(
      laser.code,
      `cart-${BASE}-${laser.code}-1`,
    );
    expect(vouchers.logVoucherEvent).toHaveBeenCalledWith(
      race.code,
      "redeem",
      expect.objectContaining({ charged: true, itemIndex: 0 }),
    );
  });
});

describe("a replay of a reserve that already CAPTURED", () => {
  it("re-recognises its own 'spent' claim instead of hard-failing the guest", async () => {
    const { svc, claims } = await mods();
    (claims.claimVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "already_claimed",
    });
    (claims.getClaimsByCode as ReturnType<typeof vi.fn>).mockResolvedValue([
      { code: race.code, itemIndex: 0, status: "spent", txnId: `cart-${BASE}-${race.code}-0` },
    ]);
    const res = await svc.claimNativeCartVouchers({
      vouchers: [race],
      baseKey: BASE,
      locationCode: 12,
    });
    expect(res.ok).toBe(true);
  });
});

describe("sweepStaleCartClaims (abandoned checkouts hand the codes back)", () => {
  const staleRow = (code: string, itemIndex: number) => ({
    code,
    itemIndex,
    status: "claimed",
    txnId: `cart-${BASE}-${code}-${itemIndex}`,
  });

  it("releases a stale claim with no capture evidence", async () => {
    const { svc, claims } = await mods();
    (claims.listStaleCartClaims as ReturnType<typeof vi.fn>).mockResolvedValue([
      staleRow(race.code, 0),
    ]);
    const summary = await svc.sweepStaleCartClaims({ minAgeMinutes: 120, dryRun: false });
    expect(summary).toMatchObject({ candidates: 1, released: 1, healedSpent: 0, errors: 0 });
    expect(claims.releaseVoucherClaim).toHaveBeenCalledWith(
      race.code,
      `cart-${BASE}-${race.code}-0`,
      "stale cart claim sweep",
    );
  });

  it("NEVER releases a claim whose charge captured — heals it to spent instead", async () => {
    const { svc, claims, vouchers } = await mods();
    (claims.listStaleCartClaims as ReturnType<typeof vi.fn>).mockResolvedValue([
      staleRow(race.code, 0),
    ]);
    (vouchers.hasChargedRedeemEvent as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const summary = await svc.sweepStaleCartClaims({ minAgeMinutes: 120, dryRun: false });
    expect(summary).toMatchObject({ candidates: 1, released: 0, healedSpent: 1 });
    expect(claims.releaseVoucherClaim).not.toHaveBeenCalled();
    expect(claims.markVoucherClaimSpent).toHaveBeenCalledWith(
      race.code,
      `cart-${BASE}-${race.code}-0`,
    );
  });

  it("dry-run counts but mutates nothing", async () => {
    const { svc, claims, vouchers } = await mods();
    // mockResolvedValue survives clearAllMocks — reset the evidence check
    // explicitly or this test inherits the previous test's `true`.
    (vouchers.hasChargedRedeemEvent as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (claims.listStaleCartClaims as ReturnType<typeof vi.fn>).mockResolvedValue([
      staleRow(race.code, 0),
      staleRow(laser.code, 1),
    ]);
    const summary = await svc.sweepStaleCartClaims({ minAgeMinutes: 120, dryRun: true });
    expect(summary).toMatchObject({ candidates: 2, released: 2 });
    expect(claims.releaseVoucherClaim).not.toHaveBeenCalled();
    expect(claims.markVoucherClaimSpent).not.toHaveBeenCalled();
  });
});
