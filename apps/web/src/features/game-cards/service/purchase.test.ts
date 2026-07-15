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
        cardApprovedCents: 5000,
      };
    }),
  };
});

const base: PurchaseInput = {
  kind: "reload",
  locationCode: 12,
  packageId: "tok-500",
  accountNumber: "1038010",
  cardNonce: "cnon-1",
};

async function loadMocks() {
  const intercard = await import("../data/intercard");
  const log = await import("../data/transactions-log");
  const sq = await import("@/lib/square-gift-card");
  return { intercard, log, sq };
}

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe("purchase order engine", () => {
  it("blocks a card that doesn't verify — never charges", async () => {
    const { intercard, sq } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: false,
      accountNumber: "1038010",
    });
    const { purchase } = await import("./purchase");

    await expect(purchase(base)).rejects.toMatchObject({ code: "CARD_NOT_FOUND" });
    expect(sq.authorizeMultiTender).not.toHaveBeenCalled();
    expect(order).not.toContain("charge");
  });

  it("persists the ledger row BEFORE charging (persist-first)", async () => {
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 10, bonusTokens: 0, timeMinutes: 0 },
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    const { purchase } = await import("./purchase");

    const res = await purchase(base);
    expect(res.loaded).toBe(true);
    expect(res.creditPending).toBe(false);
    expect(order.indexOf("startTxn")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("startTxn")).toBeLessThan(order.indexOf("charge"));
    expect(order).toContain("markLoadState:loaded");
  });

  it("leaves the load pending (recover forward) when Intercard doesn't confirm", async () => {
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 10, bonusTokens: 0, timeMinutes: 0 },
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: -1 });
    const { purchase } = await import("./purchase");

    const res = await purchase(base);
    expect(res.charged).toBe(true);
    expect(res.loaded).toBe(false);
    expect(res.creditPending).toBe(true);
    expect(order).toContain("markLoadState:pending");
  });
});
