import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PurchaseInput } from "../schemas";

vi.stubEnv("INTERCARD_MAC", "TESTMAC");

vi.mock("@/lib/redis", () => ({
  default: { set: vi.fn(async () => "OK"), mget: vi.fn(async () => []) },
}));

const order: string[] = [];

// Mocked at the ROUTER — purchase calls through data/intercard-router
// (onsite first, cloud SOAP fallback), so that is the seam to intercept.
vi.mock("../data/intercard-router", () => {
  class IntercardError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  }
  return {
    IntercardError,
    verifyAccount: vi.fn(),
    // Post-credit readback, pinned to the on-site server. Separate from
    // verifyAccount: the pre-charge blank check legitimately reads a zero
    // balance, whereas an all-zero readback here means the credit did not land.
    // Defaulted to a confirming (non-empty) balance in beforeEach.
    verifyAccountOnsite: vi.fn(),
    creditTokens: vi.fn(),
  };
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
  const intercard = await import("../data/intercard-router");
  const sq = await import("@/lib/square-gift-card");
  return { intercard, sq };
}

beforeEach(async () => {
  order.length = 0;
  vi.clearAllMocks();
  // Default: the on-site readback confirms the credit landed. A test that needs
  // to simulate a code-0 credit that reached nothing overrides this.
  const intercard = await import("../data/intercard-router");
  (intercard.verifyAccountOnsite as ReturnType<typeof vi.fn>).mockResolvedValue({
    exists: true,
    accountNumber: "x",
    balance: { tokens: 500, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
  });
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

  it("web reload: a code-0 credit that the on-site server reads EMPTY is NOT reported loaded", async () => {
    // The web-reload twin of the kiosk empty-card fix. creditTokens returns
    // success, but the on-site server (the copy the games read) shows the card
    // still empty, so the value never landed — must not tell the guest it did.
    const { intercard } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "555",
      balance: { tokens: 0, bonusTokens: 0, timeMinutes: 0 },
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      transport: "onsite",
    });
    // On-site reads the card back empty despite the code-0 credit.
    (intercard.verifyAccountOnsite as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "555",
      balance: { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });
    const { purchase } = await import("./purchase");

    const res = await purchase({
      kind: "reload",
      locationCode: 12,
      items: [{ accountNumber: "555", packageId: "tok-500" }],
      cardNonce: "cnon-1",
    });

    const r = res.results.find((x) => x.accountNumber === "555")!;
    expect(r.loaded).toBe(false);
    expect(res.anyPending).toBe(true);
    expect(order).toContain("markLoadState:load_failed");
    expect(order).not.toContain("markLoadState:loaded");
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

  it("persists a SWIPED blank's account on its row before the charge (no-dispenser kiosk)", async () => {
    // MSR-only kiosk: the guest swiped each blank BEFORE paying, so the row is
    // durable WITH its account — a browser death after the charge leaves a row
    // the reconcile cron can still credit (persist-first).
    const { intercard, sq } = await loadMocks();
    const tlog = await import("../data/transactions-log");
    // The server re-checks a swiped account itself: Intercard has never seen
    // it (live signature: result 1 → notFound "confirmed") — a true blank.
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: false,
      accountNumber: "0000000001037356",
      notFound: "confirmed",
    });
    const { chargeNewCardOrder } = await import("./purchase");

    const res = await chargeNewCardOrder({
      kind: "new_card",
      locationCode: 12,
      items: [
        { packageId: "tok-500", accountNumber: "0000000001037356" },
        { packageId: "tok-100" }, // dispenser-style row: account attached at load
      ],
      cardNonce: "cnon-1",
    });

    expect(res.rows).toHaveLength(2);
    const startCalls = (tlog.startTxn as ReturnType<typeof vi.fn>).mock.calls;
    expect(startCalls[0][0]).toMatchObject({ kind: "new_card", accountNumber: "0000000001037356" });
    expect(startCalls[1][0]).toMatchObject({ kind: "new_card", accountNumber: "" });
    // Only the swiped item is checked; the dispenser item has no account yet.
    expect(intercard.verifyAccount).toHaveBeenCalledTimes(1);
    expect(sq.authorizeMultiTender).toHaveBeenCalledTimes(1);
  });

  it("refuses to sell a 'new card' against a swiped account that already carries value", async () => {
    // The kiosk's blank check is a claim the server must not take on faith:
    // an active card gets a 409 BEFORE any row is persisted or money moves.
    const { intercard, sq } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: "1038010",
      balance: { tokens: 20, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
      transactions: [],
    });
    const { chargeNewCardOrder } = await import("./purchase");

    await expect(
      chargeNewCardOrder({
        kind: "new_card",
        locationCode: 12,
        items: [{ packageId: "tok-500", accountNumber: "1038010" }],
        cardNonce: "cnon-1",
      }),
    ).rejects.toMatchObject({ code: "CARD_NOT_BLANK" });
    expect(order).not.toContain("startTxn");
    expect(sq.authorizeMultiTender).not.toHaveBeenCalled();
  });

  it("will not sell a swiped card as new when Intercard could not confirm it is blank", async () => {
    // -1 (server exception) is AMBIGUOUS, not proof of absence → 503, retry.
    const { intercard, sq } = await loadMocks();
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: false,
      accountNumber: "1038010",
      notFound: "ambiguous",
    });
    const { chargeNewCardOrder } = await import("./purchase");

    await expect(
      chargeNewCardOrder({
        kind: "new_card",
        locationCode: 12,
        items: [{ packageId: "tok-500", accountNumber: "1038010" }],
        cardNonce: "cnon-1",
      }),
    ).rejects.toMatchObject({ code: "VERIFY_UNAVAILABLE" });
    expect(order).not.toContain("startTxn");
    expect(sq.authorizeMultiTender).not.toHaveBeenCalled();
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
