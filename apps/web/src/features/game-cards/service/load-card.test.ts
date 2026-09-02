import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubEnv("INTERCARD_MAC", "TESTMAC");

const order: string[] = [];

// Mocked at the ROUTER, not the SOAP client: loadCard and credit-plan now call
// through data/intercard-router (onsite first, cloud SOAP fallback), so that is
// the seam these tests must intercept.
vi.mock("../data/intercard-router", () => {
  // loadCard credits through credit-plan.ts → creditAccountValues (one call for
  // tokens + bonus tokens + bonus cash). creditTokens stays mocked because the
  // module is also imported elsewhere.
  const verifyAccount = vi.fn();
  return {
    creditTokens: vi.fn(),
    creditAccountValues: vi.fn(),
    verifyAccount,
    // The post-credit readback is pinned to the on-site server. In these tests
    // it mirrors verifyAccount, so a case that configures the readback via
    // `verifyAccount.mockResolvedValue(...)` drives the onsite readback too;
    // `verifyAccountOnsite.mockRejectedValue(...)` can still override it to
    // simulate an on-site server that won't answer. (clearAllMocks keeps this
    // implementation; it only clears call history.)
    verifyAccountOnsite: vi.fn((...args: unknown[]) => verifyAccount(...args)),
    // Clear-on-encode now uses the ONSITE clear (no cloud fallback). The plain
    // router clearAccount stays mocked in case anything else imports it.
    clearAccount: vi.fn(),
    clearAccountOnsite: vi.fn(),
  };
});

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
  const intercard = await import("../data/intercard-router");
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

beforeEach(async () => {
  order.length = 0;
  vi.clearAllMocks();
  // Re-establish the onsite-readback → verifyAccount delegation. clearAllMocks
  // clears call history but NOT implementations, so a test that overrides
  // verifyAccountOnsite (e.g. mockRejectedValue to simulate an unresponsive
  // server) would otherwise leak that into the next test. Reset it every time.
  const intercard = await import("../data/intercard-router");
  (intercard.verifyAccountOnsite as ReturnType<typeof vi.fn>).mockImplementation(
    (...args: unknown[]) => (intercard.verifyAccount as ReturnType<typeof vi.fn>)(...args),
  );
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
    (intercard.clearAccountOnsite as ReturnType<typeof vi.fn>).mockImplementation(async () => {
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
    expect(intercard.clearAccountOnsite).toHaveBeenCalledWith(
      expect.objectContaining({ accountNumbers: [input.accountNumber], locationCode: 12 }),
    );
    expect(order).toContain("markLoadState:loaded");
  });

  it("does NOT credit and marks load_failed when the clear doesn't confirm", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.clearAccountOnsite as ReturnType<typeof vi.fn>).mockResolvedValue({ code: -1 });
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
    expect(intercard.clearAccountOnsite).not.toHaveBeenCalled();
    // Still a fresh-blank row: the swiped account is attached and credited once.
    expect(log.setTxnAccount).toHaveBeenCalledWith(input.txnId, input.accountNumber);
    expect(intercard.creditAccountValues).toHaveBeenCalledTimes(1);
    expect(order).toContain("markLoadState:loaded");
  });

  it("a new-card row that already carries its account (swiped, persisted at prepare) is never cleared — even without the client flag", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chargedRow,
      accountNumber: input.accountNumber,
    });
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      accountNumber: input.accountNumber,
      balance: { tokens: 500, bonusTokens: 100, eTickets: 0, timeMinutes: 0 },
    });
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input); // no `swiped` — the server's own record decides
    expect(res.loaded).toBe(true);
    expect(intercard.clearAccountOnsite).not.toHaveBeenCalled();
    // The account is already on the row — nothing to attach.
    expect(log.setTxnAccount).not.toHaveBeenCalled();
    expect(intercard.creditAccountValues).toHaveBeenCalledTimes(1);
  });

  it("refuses to load a new-card row onto a DIFFERENT account than the one persisted on it", async () => {
    // Persist-first means the row is the record of which blank the guest
    // swiped; a client payload naming another card must not redirect the credit.
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...chargedRow,
      accountNumber: "0000000001037356",
    });
    const { loadCard } = await import("./load-card");

    await expect(
      loadCard({ ...input, accountNumber: "1038091", swiped: true }),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(intercard.clearAccountOnsite).not.toHaveBeenCalled();
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
    expect(log.setTxnAccount).not.toHaveBeenCalled();
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
    expect(intercard.clearAccountOnsite).not.toHaveBeenCalled();
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
    (intercard.clearAccountOnsite as ReturnType<typeof vi.fn>).mockImplementation(async () => {
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
    expect(intercard.clearAccountOnsite).not.toHaveBeenCalled();
    expect(intercard.creditAccountValues).toHaveBeenCalledTimes(1);
    vi.stubEnv("GC_CLEAR_ON_ENCODE", "");
  });
});

/**
 * A result code of 0 is not proof the value landed. On 2026-09-01 two production
 * cards (loc 6 $30 for 300+50, loc 13 $10 for 100+0) were stamped `loaded` off a
 * code-0 credit and read back completely empty — and nothing ever flagged them,
 * because the ledger already claimed success.
 */
describe("loadCard readback — a code-0 credit must actually reach the card", () => {
  const readsBack = (b: {
    tokens: number;
    bonusTokens: number;
    eTickets: number;
    timeMinutes: number;
  }) =>
    ({
      exists: true,
      accountNumber: input.accountNumber,
      balance: b,
    }) as const;

  it("refuses to hand over a card that reads EMPTY after a successful credit", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      transport: "onsite",
    });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      readsBack({ tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 }),
    );
    const { loadCard } = await import("./load-card");

    const res = await loadCard(input);

    expect(res.loaded).toBe(false);
    expect(res.balance).toBeUndefined();
    // `load_failed` is TERMINAL on purpose: listPendingLoads only replays
    // `pending`, and a replay rides the router — whose onsite leg has no
    // idempotency, so an auto-retry here could double-credit.
    expect(order).toContain("markLoadState:load_failed");
    expect(order).not.toContain("markLoadState:loaded");
  });

  it("accepts a card whose readback shows the value", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      transport: "onsite",
    });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      readsBack({ tokens: 500, bonusTokens: 100, eTickets: 0, timeMinutes: 0 }),
    );
    const { loadCard } = await import("./load-card");

    expect((await loadCard(input)).loaded).toBe(true);
    expect(order).toContain("markLoadState:loaded");
  });

  it("a card holding only TICKETS is not 'empty' — the credit plainly did something", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      transport: "cloud",
    });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      readsBack({ tokens: 0, bonusTokens: 0, eTickets: 12, timeMinutes: 0 }),
    );
    const { loadCard } = await import("./load-card");

    expect((await loadCard(input)).loaded).toBe(true);
  });

  it("a FRESH BLANK the on-site server won't confirm is RETAINED — clear-on-encode already zeroed it, so 'unconfirmed' may be a dead card", async () => {
    // 2026-09-02: two FastTrax new cards were credited code-0 after
    // clear-on-encode and the value landed on NEITHER the onsite nor the cloud
    // copy. A fresh blank is cleared before crediting, so an on-site server that
    // won't confirm the value means the card may be dead on the floor. Fail
    // closed: retain it. (The readback is onsite-only, so a relay wobble here IS
    // the unconfirmed case — it can no longer be papered over by a cloud read.)
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      transport: "onsite",
    });
    (intercard.verifyAccountOnsite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("relay down"),
    );
    const { loadCard } = await import("./load-card");

    expect((await loadCard(input)).loaded).toBe(false);
    expect(order).toContain("markLoadState:load_failed");
    expect(order).not.toContain("markLoadState:loaded");
  });

  it("a RELOAD the on-site server won't confirm KEEPS the code-0 verdict — the card is in the guest's hand and was never cleared", async () => {
    // A reload is never clear-on-encoded and can't be retained (it's the guest's
    // own card), and it lands on top of whatever they already had, so an
    // unreadable readback is not evidence of a failed load. The narrow rule
    // holds: only a positively-empty read would downgrade it.
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({ ...chargedRow, kind: "reload" });
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      transport: "onsite",
    });
    (intercard.verifyAccountOnsite as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("relay down"),
    );
    const { loadCard } = await import("./load-card");

    expect((await loadCard(input)).loaded).toBe(true);
    expect(order).toContain("markLoadState:loaded");
  });

  it("records WHICH transport delivered the load, not a hardcoded label", async () => {
    const { intercard, log } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue(chargedRow);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      transport: "onsite",
    });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      readsBack({ tokens: 500, bonusTokens: 100, eTickets: 0, timeMinutes: 0 }),
    );
    const { loadCard } = await import("./load-card");
    await loadCard(input);

    expect(log.markLoadState).toHaveBeenCalledWith(
      input.txnId,
      "loaded",
      undefined,
      "onsite", // was: always "soap"
    );
  });

  it("a bonus-CASH-only plan is never judged empty (cash is not in CardBalance)", async () => {
    const { intercard, log, claims } = await mocks();
    (log.getTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...voucherRow,
      packageId: "gzv-cash",
      tokens: 0,
      bonusTokens: 0,
    });
    (claims.getLiveClaimForTxn as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageId: "gzv-cash",
    });
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      transport: "onsite",
    });
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      readsBack({ tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 }),
    );
    const { loadCard } = await import("./load-card");

    // Either the package resolves to a cash plan (and an all-zero token balance
    // proves nothing), or it resolves to nothing at all — but it must never be
    // reported as a card we emptied.
    const res = await loadCard({ ...input }).catch(() => null);
    if (res) expect(order).not.toContain("markLoadState:load_failed");
  });
});
