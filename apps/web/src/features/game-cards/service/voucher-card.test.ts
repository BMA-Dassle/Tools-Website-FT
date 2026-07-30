import { describe, it, expect, vi, beforeEach } from "vitest";

/** Order of side effects — the claim MUST precede the ledger row. */
const order: string[] = [];

vi.mock("~/features/booking/service/bmi-voucher.server", () => ({
  peekVoucher: vi.fn(),
  voucherClientKeyForCenter: () => "headpinzftmyers",
}));

vi.mock("../data/voucher-claims-db", () => ({
  claimVoucher: vi.fn(async () => {
    order.push("claim");
    return { ok: true, claim: {} };
  }),
  releaseVoucherClaim: vi.fn(async () => {
    order.push("release");
  }),
}));

vi.mock("../data/transactions-log", () => ({
  startCompedTxn: vi.fn(async () => {
    order.push("ledger");
  }),
  markChargeFailed: vi.fn(async () => {
    order.push("chargeFailed");
  }),
}));

vi.mock("~/config/intercard-centers", () => ({
  getCenter: (code: number) => (code === 12 ? { locationCode: 12 } : null),
}));

async function mods() {
  return {
    svc: await import("./voucher-card"),
    bmi: await import("~/features/booking/service/bmi-voucher.server"),
    claims: await import("../data/voucher-claims-db"),
    log: await import("../data/transactions-log"),
  };
}

const CODE = "D3X5Q4Z8M5C3Z4D3H6S3T4G3"; // live 2026-07-29 batch shape
const input = { code: CODE, locationCode: 12, center: "fort-myers" };

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe("claimGameCardVoucher", () => {
  it("claims BEFORE writing the ledger row", async () => {
    // Reverse order would leave a charged+pending row on a lost claim race,
    // and the reconcile cron would credit a card for a spent voucher.
    const { svc, bmi } = await mods();
    (bmi.peekVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      name: "Complimentary 100 Token Game Card",
      names: ["Complimentary 100 Token Game Card"],
    });

    const res = await svc.claimGameCardVoucher(input);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.grant.bonusTokens).toBe(100);
    expect(order).toEqual(["claim", "ledger"]);
  });

  it("releases the claim when the ledger insert fails", async () => {
    const { svc, bmi, log } = await mods();
    (bmi.peekVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      names: ["Complimentary 100 Token Game Card"],
    });
    (log.startCompedTxn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("neon down"));

    const res = await svc.claimGameCardVoucher(input);

    expect(res).toEqual({ ok: false, reason: "storage" });
    expect(order).toEqual(["claim", "release"]);
  });

  it("refuses a MULTI-ITEM voucher instead of honouring one leg", async () => {
    // Owner question 2026-07-29: game zone card + laser tag on one code. The
    // legs need opposite rails and dispensing is irreversible, so refuse whole.
    const { svc, bmi, claims } = await mods();
    (bmi.peekVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      name: "Complimentary 100 Token Game Card",
      names: ["Complimentary 100 Token Game Card", "Laser Comp"],
    });

    const res = await svc.claimGameCardVoucher(input);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("multi_item");
    // Nothing claimed, nothing spent — Guest Services can still redeem it.
    expect(claims.claimVoucher).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("refuses a real voucher that isn't a game-card comp", async () => {
    const { svc, bmi, claims } = await mods();
    (bmi.peekVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      names: ["Race Comp"],
    });

    const res = await svc.claimGameCardVoucher(input);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unsupported");
    expect(claims.claimVoucher).not.toHaveBeenCalled();
  });

  it("refuses when BMI won't name the comp — never grants blind", async () => {
    // The cart rail may accept blind (checkout re-validates); this path hands
    // over value with no second checkpoint, so an unnamed comp is refused.
    const { svc, bmi, claims } = await mods();
    (bmi.peekVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const res = await svc.claimGameCardVoucher(input);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unverifiable");
    expect(claims.claimVoucher).not.toHaveBeenCalled();
  });

  it("reports a spent code as used", async () => {
    const { svc, bmi, claims } = await mods();
    (bmi.peekVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      names: ["Complimentary 100 Token Game Card"],
    });
    (claims.claimVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "already_claimed",
    });

    const res = await svc.claimGameCardVoucher(input);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("used");
    expect(order).toEqual([]); // no ledger row for a code we don't hold
  });

  it("rejects a non-BMI code shape without calling BMI", async () => {
    const { svc, bmi } = await mods();
    const res = await svc.claimGameCardVoucher({ ...input, code: "SUMMER26" });
    expect(res).toEqual({ ok: false, reason: "bad_format" });
    expect(bmi.peekVoucher).not.toHaveBeenCalled();
  });

  it("maps BMI 'not found' to unknown", async () => {
    const { svc, bmi } = await mods();
    (bmi.peekVoucher as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      errorMessage: `Voucher (code: ${CODE}) is not found`,
    });
    const res = await svc.claimGameCardVoucher(input);
    expect(res).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("releaseGameCardVoucher", () => {
  it("hands the code back AND takes the row out of the recover-forward set", async () => {
    // Releasing without failing the row would let the cron credit a card for a
    // voucher we just gave back.
    const { svc } = await mods();
    await svc.releaseGameCardVoucher({ code: CODE, txnId: "t-1", reason: "guest left" });
    expect(order).toEqual(["release", "chargeFailed"]);
  });
});
