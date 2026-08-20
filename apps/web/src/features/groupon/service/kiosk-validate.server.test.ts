import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";

const resolveGrouponCode = vi.fn();

vi.mock("./resolve.server", () => ({
  resolveGrouponCode: (...a: unknown[]) => resolveGrouponCode(...(a as [])),
}));

async function validate(code: string) {
  const m = await import("./kiosk-validate.server");
  return m.validateGrouponForKiosk(code);
}

/** The real deal: the $25 lands whole on ONE card, plus four laser tag entries. */
const DEAL: VoucherItem[] = [
  { kind: "gamezone", tokens: 0, bonusTokens: 250, bonusCashDollars: 0 },
  { kind: "attraction", slug: "laser-tag", qty: 1 },
  { kind: "attraction", slug: "laser-tag", qty: 1 },
  { kind: "attraction", slug: "laser-tag", qty: 1 },
  { kind: "attraction", slug: "laser-tag", qty: 1 },
];

const resolution = (spent: number[] = [], firstScan = true) => ({
  ok: true,
  code: "89895632",
  row: {},
  items: DEAL.map((item, itemIndex) => ({ item, itemIndex, spent: spent.includes(itemIndex) })),
  fullySpent: spent.length === DEAL.length,
  firstScan,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateGrouponForKiosk", () => {
  it("routes the card to the gamezone rail and each laser tag to the cart", async () => {
    resolveGrouponCode.mockResolvedValue(resolution());

    const res = await validate("89895632");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(5);
    expect(res.items[0]).toMatchObject({ index: 0, redeemVia: "gamezone", tokens: 250 });
    for (const i of res.items.slice(1)) {
      // "Laser Tag" is the exact string voucherTarget() keys off. A second
      // issuer spelling it differently would validate, show the guest a laser
      // tag line, then cover nothing at checkout.
      expect(i).toMatchObject({ redeemVia: "cart", coverageName: "Laser Tag" });
    }
  });

  it("PRESERVES itemIndex — it is the claim identity in voucher_claims", async () => {
    // If the mapping renumbered legs, a claim would be recorded against the
    // wrong one and a guest could take the same leg twice.
    resolveGrouponCode.mockResolvedValue(resolution([0, 2]));

    const res = await validate("89895632");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.map((i) => i.index)).toEqual([1, 3, 4]);
    expect(res.spentItems.map((i) => i.index)).toEqual([0, 2]);
  });

  it("is the return-visit case: card taken, four laser tag entries still live", async () => {
    // Exactly the scenario the ledger exists for — the guest took the $25 card
    // on Wednesday and comes back Saturday with three friends.
    resolveGrouponCode.mockResolvedValue(resolution([0], false));

    const res = await validate("89895632");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.firstScan).toBe(false);
    expect(res.items).toHaveLength(4);
    expect(res.items.every((i) => i.redeemVia === "cart")).toBe(true);
    expect(res.spentItems).toEqual([{ index: 0, label: "250 bonus tokens" }]);
  });

  it("says 'used' — not 'unknown' — when every leg is gone", async () => {
    // The voucher WAS real. Telling the guest it does not exist would be a lie
    // and would send them to Guest Services with the wrong question.
    resolveGrouponCode.mockResolvedValue(resolution([0, 1, 2, 3, 4]));

    expect(await validate("89895632")).toEqual({ ok: false, reason: "used" });
  });

  it("passes a refusal straight through", async () => {
    resolveGrouponCode.mockResolvedValue({ ok: false, refusal: "already_redeemed" });

    expect(await validate("89895632")).toEqual({ ok: false, reason: "already_redeemed" });
  });

  it("labels the first unspent leg for the toast", async () => {
    resolveGrouponCode.mockResolvedValue(resolution());

    const res = await validate("89895632");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.label).toBe("250 bonus tokens");
  });
});
