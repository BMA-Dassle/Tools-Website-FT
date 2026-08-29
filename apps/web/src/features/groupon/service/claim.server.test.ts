import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";

const order: string[] = [];

const findGrouponUnit = vi.fn();
const spentItemIndexes = vi.fn(async () => new Set<number>());
// Explicit return type: a CAS loss is `{ ok: false }` with no claim, so letting
// the happy-path implementation infer the shape makes that case untypeable.
const claimVoucher = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; claim?: object }>>(
  async () => {
    order.push("claim");
    return { ok: true, claim: {} };
  },
);
const releaseVoucherClaim = vi.fn(async () => {
  order.push("release");
});
const startCompedTxn = vi.fn(async () => {
  order.push("ledger");
});

vi.mock("../data/groupon-units-db", () => ({
  findGrouponUnit: (...a: unknown[]) => findGrouponUnit(...(a as [])),
}));

vi.mock("~/features/game-cards/data/voucher-claims-db", () => ({
  claimVoucher: (...a: unknown[]) => claimVoucher(...(a as [])),
  releaseVoucherClaim: (...a: unknown[]) => releaseVoucherClaim(...(a as [])),
  spentItemIndexes: (...a: unknown[]) => spentItemIndexes(...(a as [])),
}));

vi.mock("~/features/game-cards/data/transactions-log", () => ({
  startCompedTxn: (...a: unknown[]) => startCompedTxn(...(a as [])),
}));

const DEAL: VoucherItem[] = [
  { kind: "gamezone", tokens: 0, bonusTokens: 250, bonusCashDollars: 0 },
  { kind: "attraction", slug: "laser-tag", qty: 1 },
  { kind: "attraction", slug: "laser-tag", qty: 1 },
  { kind: "attraction", slug: "laser-tag", qty: 1 },
  { kind: "attraction", slug: "laser-tag", qty: 1 },
];

const ROW = {
  redemptionCode: "89895632",
  unitId: "23cc45c6",
  grouponCode: "VS-GCMV-VNXS-4YN4-2V4X",
  dealKey: "arcade25-laser4",
  items: DEAL,
  valueAmount: 6500,
  currencyCode: "USD",
  fetchedAt: "2026-08-20T15:00:00Z",
  redeemState: "pending" as const,
  redeemedAt: null,
  redeemAttempts: 0,
  lastError: null,
};

async function claim(over: Record<string, unknown> = {}) {
  const m = await import("./claim.server");
  return m.claimGrouponGameZone({
    code: "89895632",
    locationCode: 1,
    source: "kiosk",
    ...over,
  });
}

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  findGrouponUnit.mockResolvedValue(ROW);
  spentItemIndexes.mockResolvedValue(new Set<number>());
  claimVoucher.mockImplementation(async () => {
    order.push("claim");
    return { ok: true, claim: {} };
  });
  startCompedTxn.mockImplementation(async () => {
    order.push("ledger");
  });
});

describe("claimGrouponGameZone", () => {
  it("claims BEFORE the ledger row, and tells Groupon NOTHING", async () => {
    // Claim-then-ledger is the safe order: a claim without a ledger row is a leg
    // the guest can never spend; a ledger row without a claim is a card we might
    // hand out twice. And the Groupon PATCH belongs at card delivery, not here.
    const res = await claim();

    expect(res.ok).toBe(true);
    expect(order).toEqual(["claim", "ledger"]);
  });

  it("takes the game-card leg with issuer 'groupon' at its real index", async () => {
    await claim();

    expect(claimVoucher).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "89895632",
        itemIndex: 0,
        issuer: "groupon",
        compName: "250 bonus tokens",
      }),
    );
  });

  it("grants the full $25 as bonus tokens", async () => {
    const res = await claim();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.grant).toEqual({ tokens: 0, bonusTokens: 250, bonusCashDollars: 0 });
  });

  it("releases the claim when the ledger insert fails", async () => {
    // Otherwise the leg is consumed and the guest can never spend it.
    startCompedTxn.mockRejectedValue(new Error("neon down"));

    const res = await claim();

    expect(res).toEqual({ ok: false, reason: "storage" });
    // The rejecting mock never records "ledger" — what matters is that the
    // release happened, and that it happened AFTER the claim.
    expect(order).toEqual(["claim", "release"]);
    expect(releaseVoucherClaim).toHaveBeenCalledWith(
      "89895632",
      expect.any(String),
      "ledger row insert failed",
    );
  });

  it("refuses when the card leg is already taken", async () => {
    spentItemIndexes.mockResolvedValue(new Set([0]));

    expect(await claim()).toEqual({ ok: false, reason: "used" });
    expect(claimVoucher).not.toHaveBeenCalled();
  });

  it("reports 'used' when it LOSES the CAS to another kiosk", async () => {
    // Two kiosks scanned the same Groupon; exactly one may take the card.
    claimVoucher.mockResolvedValue({ ok: false });

    expect(await claim()).toEqual({ ok: false, reason: "used" });
    expect(startCompedTxn).not.toHaveBeenCalled();
  });

  it("says not_redeemable — not 'used' — for a laser-tag-only voucher", async () => {
    // The guest still HAS value, just not on this rail. Saying "used" would
    // send them away believing the voucher is finished.
    findGrouponUnit.mockResolvedValue({ ...ROW, items: DEAL.slice(1) });

    expect(await claim()).toEqual({ ok: false, reason: "not_redeemable" });
  });

  it("never reaches out to Groupon for an unknown code", async () => {
    // A claim is for a voucher already validated and written down. An unknown
    // code means the scan step was skipped, which is a bug, not a fetch.
    findGrouponUnit.mockResolvedValue(null);

    expect(await claim()).toEqual({ ok: false, reason: "unknown" });
    expect(claimVoucher).not.toHaveBeenCalled();
  });

  it("credits a card the guest already holds (WEB leg) without looking like a fresh blank", async () => {
    // clear-on-encode would wipe their existing balance if this said "voucher".
    // The web leg (voucher-to-card.ts) always claims with source "web".
    await claim({ accountNumber: "1038091", source: "web" });

    expect(startCompedTxn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "voucher_reload", accountNumber: "1038091" }),
    );
  });

  it("a SWIPE kiosk's blank rides the claim as a `voucher` row that already knows its card", async () => {
    // No dispenser: the guest swiped the blank BEFORE the claim (persist-first).
    // Still fresh stock (`voucher`), not the web leg — load-card never clears a
    // fresh-blank row that carries its account, and the reconcile cron gives
    // `voucher` rows the kiosk's grace window.
    await claim({ accountNumber: "0000000001037356", source: "kiosk" });

    expect(startCompedTxn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "voucher", accountNumber: "0000000001037356" }),
    );
  });

  it("stages a fresh blank as kind 'voucher'", async () => {
    await claim();

    expect(startCompedTxn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "voucher", accountNumber: "" }),
    );
  });
});
