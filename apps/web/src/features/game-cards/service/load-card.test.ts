import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubEnv("INTERCARD_MAC", "TESTMAC");

const order: string[] = [];

vi.mock("../data/intercard", () => ({
  // loadCard credits through credit-plan.ts → creditAccountValues (one call for
  // tokens + bonus tokens + bonus cash). creditTokens stays mocked because the
  // module is also imported elsewhere.
  creditTokens: vi.fn(),
  creditAccountValues: vi.fn(),
  verifyAccount: vi.fn(),
  clearAccount: vi.fn(),
}));

vi.mock("../data/voucher-claims-db", () => ({
  getLiveClaimForTxn: vi.fn(),
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
  const claims = await import("../data/voucher-claims-db");
  return { intercard, log, claims };
}

/** A comped row: no money, authorised by a held BMI voucher claim. */
const voucherRow = {
  ...chargedRow,
  kind: "voucher",
  packageId: "gzv-100",
  tokens: 0,
  bonusTokens: 100,
  amountCents: 0,
  voucherCode: "D3X5Q4Z8M5C3Z4D3H6S3T4G3",
  tpiTransactionId: "gzvoucher-abc",
};

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe("loadCard (buy: per-card load after charge)", () => {
  it("attaches the account, credits tokens, marks loaded, returns balance", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
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
    expect(intercard.creditAccountValues).toHaveBeenCalledWith(
      expect.objectContaining({
        accountNumber: "1038091",
        tokens: 500,
        tokenBonus: 100,
        cashBonus: 0,
        tpiTransactionID: "newcard-abc",
      }),
    );
    expect(order).toContain("markLoadState:loaded");
  });

  it("leaves the row pending (not loaded) when Intercard returns a non-zero code", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({ code: -1 });
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
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
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
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
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
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("creditAccountValues");
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
    expect(order.indexOf("clearAccount")).toBeLessThan(order.indexOf("creditAccountValues"));
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
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
    expect(order).toContain("markLoadState:load_failed");
  });

  it("never clears a SWIPED new card — the guest chose it, so it only ever gains value", async () => {
    // MSR-only kiosk (2026-08-28): the blank came off the holder under the
    // screen and was swiped, not pulled from the stacker. If the client's
    // blank check were wrong and the card carried value, a clear would wipe a
    // guest's balance to add the tokens they just paid for — stacking is the
    // harmless outcome, clearing is not.
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 500, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard({ ...input, swiped: true });
    expect(res.loaded).toBe(true);
    expect(intercard.clearAccount).not.toHaveBeenCalled();
    // Still a fresh-blank row: the swiped account is attached and credited once.
    expect(log.setTxnAccount).toHaveBeenCalledWith(input.txnId, input.accountNumber);
    expect(intercard.creditAccountValues).toHaveBeenCalledTimes(1);
    expect(order).toContain("markLoadState:loaded");
  });

  it("never clears a reload (would wipe the guest's own balance)", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({ ...chargedRow, kind: "reload" });
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
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

describe("loadCard (comp voucher: free load, authorised by the claim)", () => {
  it("credits the grant's BONUS bucket when the claim is live", async () => {
    const { intercard, log, claims } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(voucherRow);
    (claims.getLiveClaimForTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: voucherRow.voucherCode,
      packageId: "gzv-100",
      status: "claimed",
    });
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 0, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);
    expect(res.loaded).toBe(true);
    // Comped value NEVER lands in the purchased-token bucket.
    expect(intercard.creditAccountValues).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: 0, tokenBonus: 100, cashBonus: 0 }),
    );
    expect(order).toContain("markLoadState:loaded");
  });

  it("refuses to credit when no live claim backs the row (orphan row)", async () => {
    // The claim is the authorisation. A row whose claim was lost to a race, or
    // already released, must dispense no value — this is the free-card path.
    const { intercard, log, claims } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(voucherRow);
    (claims.getLiveClaimForTxn as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { loadCard } = await import("./load-card");

    await expect(loadCard(input)).rejects.toMatchObject({ code: "VOUCHER_NOT_CLAIMED" });
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
  });

  it("refuses when the claim and the row disagree about the grant", async () => {
    const { intercard, log, claims } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(voucherRow);
    (claims.getLiveClaimForTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: voucherRow.voucherCode,
      packageId: "gzv-1000", // ten times the value the row was written with
      status: "claimed",
    });
    const { loadCard } = await import("./load-card");

    await expect(loadCard(input)).rejects.toMatchObject({ code: "VOUCHER_MISMATCH" });
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
  });

  it("credits nothing for an off-allowlist grant id", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...voucherRow,
      packageId: "gzv-99999",
    });
    const { loadCard } = await import("./load-card");

    await expect(loadCard(input)).rejects.toMatchObject({ code: "UNKNOWN_PACKAGE" });
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
  });

  it("clears a comped blank before crediting (recycled stock, same as a paid new card)", async () => {
    vi.stubEnv("GC_CLEAR_ON_ENCODE", "1");
    const { intercard, log, claims } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(voucherRow);
    (claims.getLiveClaimForTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: voucherRow.voucherCode,
      packageId: "gzv-100",
      status: "claimed",
    });
    (intercard.clearAccount as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("clearAccount");
      return { code: 0 };
    });
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("creditAccountValues");
      return { code: 0 };
    });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 0, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);
    expect(res.loaded).toBe(true);
    expect(order.indexOf("clearAccount")).toBeLessThan(order.indexOf("creditAccountValues"));
    vi.stubEnv("GC_CLEAR_ON_ENCODE", "");
  });

  it("a comped card the guest SWIPED (no-dispenser kiosk) is credited without a clear", async () => {
    vi.stubEnv("GC_CLEAR_ON_ENCODE", "1");
    const { intercard, log, claims } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(voucherRow);
    (claims.getLiveClaimForTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: voucherRow.voucherCode,
      packageId: "gzv-100",
      status: "claimed",
    });
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 0, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard({ ...input, swiped: true });
    expect(res.loaded).toBe(true);
    expect(intercard.clearAccount).not.toHaveBeenCalled();
    expect(intercard.creditAccountValues).toHaveBeenCalledTimes(1);
    vi.stubEnv("GC_CLEAR_ON_ENCODE", "");
  });
});
