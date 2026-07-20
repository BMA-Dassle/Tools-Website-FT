import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  markChargedQueued: vi.fn(async () => {
    order.push("markChargedQueued");
  }),
  markChargeFailed: vi.fn(async () => {
    order.push("markChargeFailed");
  }),
  markLoadState: vi.fn(async (_id: string, state: string) => {
    order.push("markLoadState:" + state);
  }),
  getGroupQueueStates: vi.fn(async () => []),
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

vi.mock("../data/customer-cards", () => ({
  linkCard: vi.fn(async () => {
    order.push("link");
  }),
}));

vi.mock("~/features/account/data/cards", () => ({
  saveCardOnFile: vi.fn(async () => {
    order.push("saveCard");
    return { ok: true };
  }),
}));

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

  it("signed-in: auto-links each card and saves the payment card when opted in", async () => {
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    const cards = await import("~/features/account/data/cards");
    const link = await import("../data/customer-cards");
    const { purchase } = await import("./purchase");

    await purchase(
      { ...single, saveCard: true, squareCustomerId: "cust_1" },
      {
        verifiedCustomerId: "cust_1",
      },
    );

    expect(link.linkCard).toHaveBeenCalledTimes(1);
    expect(cards.saveCardOnFile).toHaveBeenCalledTimes(1);
    // link/save happen after the charge
    expect(order.indexOf("charge")).toBeLessThan(order.indexOf("link"));
  });

  it("anonymous (no session): never links or saves a card", async () => {
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    const cards = await import("~/features/account/data/cards");
    const link = await import("../data/customer-cards");
    const { purchase } = await import("./purchase");

    await purchase({ ...single, saveCard: true }); // saveCard true but no verified session
    expect(link.linkCard).not.toHaveBeenCalled();
    expect(cards.saveCardOnFile).not.toHaveBeenCalled();
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

describe("bridge-queue mode (GAME_CARD_EIS_QUEUE_CENTERS flag)", () => {
  beforeEach(async () => {
    vi.stubEnv("GAME_CARD_EIS_QUEUE_CENTERS", "12");
    // Re-pin the default: clearAllMocks doesn't undo a prior test's
    // mockImplementation, and a leaked "loaded" queue poisons later tests.
    const tlog = await import("../data/transactions-log");
    (tlog.getGroupQueueStates as ReturnType<typeof vi.fn>).mockImplementation(async () => []);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("INTERCARD_MAC", "TESTMAC");
    vi.useRealTimers();
  });

  it("queued center: charge+enqueue fused, bridge-loaded rows report loaded, SOAP never called", async () => {
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });
    const tlog = await import("../data/transactions-log");
    // The bridge loads the row before the wait loop's first poll.
    (tlog.getGroupQueueStates as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const txnId = (tlog.startTxn as ReturnType<typeof vi.fn>).mock.calls[0][0].txnId as string;
      return [{ txnId, loadState: "loaded", queueState: "done" }];
    });
    const { purchase } = await import("./purchase");

    const res = await purchase(single);
    expect(res.results[0]).toMatchObject({ loaded: true, creditPending: false });
    expect(res.anyPending).toBe(false);
    // Queue mode NEVER credits via SOAP in the request.
    expect(intercard.creditTokens).not.toHaveBeenCalled();
    expect(order).toContain("markChargedQueued");
    expect(order).not.toContain("markCharged");
    // No balance re-read for queue-loaded rows (cloud history lags the EIS).
    expect(res.results[0].balance).toBeUndefined();
    expect(intercard.verifyAccount).toHaveBeenCalledTimes(1); // pre-charge verify only
  });

  it("queued center: no bridge pickup → creditPending, never credits inline (cron owns fallback)", async () => {
    vi.useFakeTimers();
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });
    const { purchase } = await import("./purchase");

    const pending = purchase(single);
    await vi.advanceTimersByTimeAsync(15_000); // past the 12s observation window
    const res = await pending;

    expect(res.results[0]).toMatchObject({ loaded: false, creditPending: true });
    expect(res.anyPending).toBe(true);
    expect(intercard.creditTokens).not.toHaveBeenCalled();
    // Queue rows are never markLoadState'd by the request — the row is already
    // 'queued' and the reconcile cron owns every transition from here.
    expect(order.filter((o) => o.startsWith("markLoadState"))).toHaveLength(0);
  });

  it("non-queued center: byte-for-byte v1 behavior (markCharged + inline SOAP)", async () => {
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    const { purchase } = await import("./purchase");

    // Flag lists center 12 only; this reload is at 13 (FastTrax FM).
    const res = await purchase({ ...single, locationCode: 13 });
    expect(res.results[0].loaded).toBe(true);
    expect(intercard.creditTokens).toHaveBeenCalledTimes(1);
    expect(order).toContain("markCharged");
    expect(order).not.toContain("markChargedQueued");
  });
});

describe("chargeNewCardOrder (buy: charge upfront, no verify/load)", () => {
  it("charges once for the basket, persists a row per card, never verifies or loads", async () => {
    const { intercard, sq } = await loadMocks();
    const { chargeNewCardOrder } = await import("./purchase");

    const res = await chargeNewCardOrder({
      kind: "new_card",
      locationCode: 12,
      items: [{ packageId: "tok-500" }, { packageId: "tok-100" }],
      cardNonce: "cnon-1",
    });

    expect(res.ok).toBe(true);
    expect(res.charged).toBe(true);
    expect(res.groupId).toBeTruthy();
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ packageId: "tok-500", tokens: 500, bonusTokens: 100 });
    // Exactly one charge; two rows persisted BEFORE it.
    expect(sq.authorizeMultiTender).toHaveBeenCalledTimes(1);
    expect(order.filter((o) => o === "startTxn")).toHaveLength(2);
    expect(order.lastIndexOf("startTxn")).toBeLessThan(order.indexOf("charge"));
    // New-card charge NEVER verifies or loads — that happens per card via loadCard.
    expect(intercard.verifyAccount).not.toHaveBeenCalled();
    expect(intercard.creditTokens).not.toHaveBeenCalled();
    expect(order).not.toContain("markLoadState:loaded");
  });

  it("marks every row charge-failed and throws on a decline", async () => {
    const { sq } = await loadMocks();
    (sq.authorizeMultiTender as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new sq.SquarePaymentError("CARD_DECLINED", "declined"),
    );
    const { chargeNewCardOrder } = await import("./purchase");

    await expect(
      chargeNewCardOrder({
        kind: "new_card",
        locationCode: 12,
        items: [{ packageId: "tok-100" }],
        cardNonce: "cnon-1",
      }),
    ).rejects.toMatchObject({ code: "CARD_DECLINED" });
    expect(order).toContain("markChargeFailed");
  });
});
