import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubEnv("INTERCARD_MAC", "TESTMAC");

const order: string[] = [];

vi.mock("../data/intercard", () => ({
  creditTokens: vi.fn(),
  verifyAccount: vi.fn(),
  clearAccount: vi.fn(),
}));

vi.mock("../data/transactions-log", () => ({
  getTxn: vi.fn(),
  setTxnAccount: vi.fn(async () => {
    order.push("setTxnAccount");
  }),
  markLoadState: vi.fn(async (_id: string, state: string) => {
    order.push("markLoadState:" + state);
  }),
}));

const chargedRow = {
  txnId: "11111111-1111-1111-1111-111111111111",
  groupId: "22222222-2222-2222-2222-222222222222",
  kind: "new_card",
  packageId: "tok-500",
  tokens: 500,
  bonusTokens: 100,
  tpiTransactionId: "newcard-abc",
  state: "charged",
  loadState: "pending",
};

const input = {
  groupId: chargedRow.groupId,
  txnId: chargedRow.txnId,
  accountNumber: "1038091",
  locationCode: 12,
};

async function mocks() {
  const intercard = await import("../data/intercard");
  const log = await import("../data/transactions-log");
  return { intercard, log };
}

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe("loadCard (buy: per-card load after charge)", () => {
  it("attaches the account, credits tokens, marks loaded, returns balance", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 500, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);
    expect(res.loaded).toBe(true);
    expect(res.tokens).toBe(500);
    expect(res.balance?.tokens).toBe(500);
    expect(log.setTxnAccount).toHaveBeenCalledWith(input.txnId, input.accountNumber);
    expect(intercard.creditTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        accountNumber: "1038091",
        tokens: 500,
        bonusTokens: 100,
        tpiTransactionID: "newcard-abc",
      }),
    );
    expect(order).toContain("markLoadState:loaded");
  });

  it("leaves the row pending (not loaded) when Intercard returns a non-zero code", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: -1 });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);
    expect(res.loaded).toBe(false);
    expect(order).toContain("markLoadState:pending");
    // Never re-reads balance on a failed load.
    expect(intercard.verifyAccount).not.toHaveBeenCalled();
  });

  it("rejects a load for a row that hasn't been charged (no free loads)", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({ ...chargedRow, state: "started" });
    const { loadCard } = await import("./load-card");

    await expect(loadCard(input)).rejects.toMatchObject({ code: "NOT_CHARGED" });
    expect(intercard.creditTokens).not.toHaveBeenCalled();
  });

  it("rejects when the txn doesn't belong to the group", async () => {
    const { log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({ ...chargedRow, groupId: "other" });
    const { loadCard } = await import("./load-card");
    await expect(loadCard(input)).rejects.toMatchObject({ code: "TXN_NOT_FOUND" });
  });

  it("is idempotent — an already-loaded row returns balance without re-crediting", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chargedRow,
      state: "completed",
      loadState: "loaded",
    });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 500, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);
    expect(res.loaded).toBe(true);
    expect(intercard.creditTokens).not.toHaveBeenCalled();
  });
});

describe("loadCard clear-on-encode (GC_CLEAR_ON_ENCODE=1)", () => {
  beforeEach(() => {
    vi.stubEnv("GC_CLEAR_ON_ENCODE", "1");
  });
  afterEach(() => {
    // Turn the flag back off without disturbing INTERCARD_MAC (stubbed at module load).
    vi.stubEnv("GC_CLEAR_ON_ENCODE", "");
  });

  it("clears the new card FIRST, then credits, when the clear confirms (code 0)", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.clearAccount as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("clearAccount");
      return { code: 0 };
    });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("creditTokens");
      return { code: 0 };
    });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 500, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);
    expect(res.loaded).toBe(true);
    // Clear must run strictly before the credit.
    expect(order.indexOf("clearAccount")).toBeLessThan(order.indexOf("creditTokens"));
    expect(intercard.clearAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountNumbers: [input.accountNumber], locationCode: 12 }),
    );
    expect(order).toContain("markLoadState:loaded");
  });

  it("does NOT credit and marks load_failed when the clear doesn't confirm", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.clearAccount as ReturnType<typeof vi.fn>).mockResolvedValue({ code: -1 });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);
    expect(res.loaded).toBe(false);
    // Never credit an uncleared card (would stack residual + new value).
    expect(intercard.creditTokens).not.toHaveBeenCalled();
    expect(order).toContain("markLoadState:load_failed");
  });

  it("never clears a reload (would wipe the guest's own balance)", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({ ...chargedRow, kind: "reload" });
    (intercard.creditTokens as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 500, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);
    expect(res.loaded).toBe(true);
    expect(intercard.clearAccount).not.toHaveBeenCalled();
  });
});
