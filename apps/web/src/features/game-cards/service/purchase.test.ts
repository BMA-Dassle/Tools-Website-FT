import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PurchaseInput } from "../schemas";

vi.stubEnv("INTERCARD_MAC", "TESTMAC");

const order: string[] = [];

vi.mock("../data/intercard", () => {
  class IntercardError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  }
  return { IntercardError, verifyAccount: vi.fn(), creditTokens: vi.fn() };
});

vi.mock("../data/square-order", () => ({
  createReloadOrder: vi.fn(async () => {
    order.push("order");
    return "order-1";
  }),
}));

vi.mock("../data/transactions-log", () => ({
  startTxn: vi.fn(async () => {
    order.push("startTxn");
  }),
  markCharged: vi.fn(async () => {
    order.push("markCharged");
  }),
  markChargeFailed: vi.fn(async () => {
    order.push("markChargeFailed");
  }),
  markLoadState: vi.fn(async (_id: string, state: string) => {
    order.push("markLoadState:" + state);
  }),
}));

vi.mock("@/lib/square-gift-card", () => {
  class SquarePaymentError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  }
  return {
    SquarePaymentError,
    authorizeMultiTender: vi.fn(async () => {
      order.push("charge");
      return {
        gcPaymentId: null,
        cardPaymentId: "pay-1",
        gcApprovedCents: 0,
        cardApprovedCents: 6000,
      };
    }),
  };
});

const single: PurchaseInput = {
  kind: "reload",
  locationCode: 12,
  items: [{ accountNumber: "1038010", packageId: "tok-500" }],
  cardNonce: "cnon-1",
};

async function loadMocks() {
  const intercard = await import("../data/intercard");
  const sq = await import("@/lib/square-gift-card");
  return { intercard, sq };
}

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe("purchase order engine (cart)", () => {
  it("blocks when any card doesn't verify — never charges", async () => {
    const { intercard, sq } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: false,
      accountNumber: "1038010",
    });
    const { purchase } = await import("./purchase");

    await expect(purchase(single)).rejects.toMatchObject({ code: "CARD_NOT_FOUND" });
    expect(sq.authorizeMultiTender).not.toHaveBeenCalled();
    expect(order).not.toContain("charge");
  });

  it("persists all rows BEFORE charging, then loads (single card)", async () => {
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 10, bonusTokens: 0, timeMinutes: 0 },
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    const { purchase } = await import("./purchase");

    const res = await purchase(single);
    expect(res.charged).toBe(true);
    expect(res.anyPending).toBe(false);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ accountNumber: "1038010", loaded: true, tokens: 500 });
    expect(order.indexOf("startTxn")).toBeLessThan(order.indexOf("charge"));
  });

  it("multi-card: one charge, per-card load; a single card failing leaves only it pending", async () => {
    const { intercard, sq } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "x",
      balance: { tokens: 0, bonusTokens: 0, timeMinutes: 0 },
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ accountNumber }: { accountNumber: string }) =>
        accountNumber === "222" ? { code: -1 } : { code: 0 },
    );
    const { purchase } = await import("./purchase");

    const res = await purchase({
      kind: "reload",
      locationCode: 12,
      items: [
        { accountNumber: "111", packageId: "tok-500" },
        { accountNumber: "222", packageId: "tok-100" },
      ],
      cardNonce: "cnon-1",
    });

    // exactly ONE Square charge for the whole cart
    expect(sq.authorizeMultiTender).toHaveBeenCalledTimes(1);
    // two ledger rows persisted before the charge
    expect(order.filter((o) => o === "startTxn")).toHaveLength(2);
    expect(order.lastIndexOf("startTxn")).toBeLessThan(order.indexOf("charge"));
    // per-card outcome
    const byAcct = Object.fromEntries(res.results.map((r) => [r.accountNumber, r]));
    expect(byAcct["111"].loaded).toBe(true);
    expect(byAcct["222"].creditPending).toBe(true);
    expect(res.anyPending).toBe(true);
    expect(order).toContain("markLoadState:loaded");
    expect(order).toContain("markLoadState:pending");
  });
});
