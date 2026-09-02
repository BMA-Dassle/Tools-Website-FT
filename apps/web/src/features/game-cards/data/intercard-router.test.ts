import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Real IntercardError class — the router does `instanceof` checks on it.
class IntercardError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntercardError";
  }
}

vi.mock("./intercard", () => ({
  IntercardError,
  verifyAccount: vi.fn(),
  creditTokens: vi.fn(),
  creditAccountValues: vi.fn(),
  clearAccount: vi.fn(),
  consolidateAccounts: vi.fn(),
}));

vi.mock("./intercard-onsite", () => ({
  verifyAccount: vi.fn(),
  accountHistory: vi.fn(),
  creditTokens: vi.fn(),
  creditAccountValues: vi.fn(),
  clearAccount: vi.fn(),
  consolidateAccounts: vi.fn(),
}));

async function mocks() {
  const cloud = await import("./intercard");
  const onsite = await import("./intercard-onsite");
  return { cloud, onsite } as unknown as {
    cloud: Record<string, ReturnType<typeof vi.fn>>;
    onsite: Record<string, ReturnType<typeof vi.fn>>;
  };
}

const CREDIT = {
  locationCode: 12,
  accountNumber: "1098379",
  tokens: 500,
  bonusTokens: 100,
  tpiTransactionID: "reload-abc",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("intercard router — onsite takes priority", () => {
  it("reads from onsite and never touches the cloud when onsite answers", async () => {
    const { cloud, onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue({
      exists: true,
      accountNumber: "1098379",
      balance: { tokens: 200, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });
    // Onsite history present, so the history failover (empty→cloud) doesn't fire
    // and the read stays entirely onsite.
    onsite.accountHistory.mockResolvedValue([
      {
        device: "x",
        transType: "Game Play",
        tokens: -10,
        bonusTokens: 0,
        points: 0,
        cash: 0,
        timeStamp: "",
        location: "",
      },
    ]);

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 12);

    expect(res.transport).toBe("onsite");
    expect(res.balance?.tokens).toBe(200);
    expect(onsite.verifyAccount).toHaveBeenCalledTimes(1);
    expect(cloud.verifyAccount).not.toHaveBeenCalled();
  });

  it("credits through onsite and never touches the cloud when onsite succeeds", async () => {
    const { cloud, onsite } = await mocks();
    onsite.creditTokens.mockResolvedValue({ code: 0 });

    const { creditTokens } = await import("./intercard-router");
    const res = await creditTokens(CREDIT);

    expect(res).toMatchObject({ code: 0, transport: "onsite" });
    expect(cloud.creditTokens).not.toHaveBeenCalled();
  });
});

describe("intercard router — READS fall back freely", () => {
  it("falls back to cloud when onsite throws (a stale read beats no read)", async () => {
    const { cloud, onsite } = await mocks();
    onsite.verifyAccount.mockRejectedValue(new IntercardError("RELAY_TIMEOUT", "timeout"));
    cloud.verifyAccount.mockResolvedValue({ exists: true, accountNumber: "1098379" });

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 12);

    expect(res.transport).toBe("cloud");
    expect(cloud.verifyAccount).toHaveBeenCalledTimes(1);
  });

  it("does NOT trust an ambiguous onsite 'not found' — the cloud settles it", async () => {
    // A blank-card sale keys off notFound === "confirmed". Reporting a card as
    // absent because the onsite service errored would sell a loaded card as new.
    const { cloud, onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue({
      exists: false,
      accountNumber: "1098379",
      notFound: "ambiguous",
    });
    cloud.verifyAccount.mockResolvedValue({
      exists: true,
      accountNumber: "1098379",
      balance: { tokens: 500, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 12);

    expect(cloud.verifyAccount).toHaveBeenCalledTimes(1);
    expect(res.exists).toBe(true);
    expect(res.transport).toBe("cloud");
  });

  it("DOES trust a confirmed onsite 'not found' (real-time truth, no cloud call)", async () => {
    const { cloud, onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue({
      exists: false,
      accountNumber: "1098379",
      notFound: "confirmed",
    });

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 12);

    expect(res.notFound).toBe("confirmed");
    expect(res.transport).toBe("onsite");
    expect(cloud.verifyAccount).not.toHaveBeenCalled();
  });
});

describe("intercard router — WRITES only fall back when provably un-started", () => {
  it("falls back on RELAY_OFFLINE (404: the relay never accepted the work)", async () => {
    const { cloud, onsite } = await mocks();
    onsite.creditTokens.mockRejectedValue(new IntercardError("RELAY_OFFLINE", "no relay"));
    cloud.creditTokens.mockResolvedValue({ code: 0 });

    const { creditTokens } = await import("./intercard-router");
    const res = await creditTokens(CREDIT);

    expect(res.transport).toBe("cloud");
    expect(cloud.creditTokens).toHaveBeenCalledTimes(1);
  });

  it("falls back on NOT_LICENSED (401: rejected at the gate, before dispatch)", async () => {
    const { cloud, onsite } = await mocks();
    onsite.creditTokens.mockRejectedValue(new IntercardError("NOT_LICENSED", "licence"));
    cloud.creditTokens.mockResolvedValue({ code: 0 });

    const { creditTokens } = await import("./intercard-router");
    expect((await creditTokens(CREDIT)).transport).toBe("cloud");
  });

  it("NEVER falls back on RELAY_TIMEOUT — the credit may already be applied", async () => {
    // THE money-safety test. A timeout means the site may have applied the
    // credit; re-sending it via cloud would double-credit the guest's card.
    const { cloud, onsite } = await mocks();
    onsite.creditTokens.mockRejectedValue(new IntercardError("RELAY_TIMEOUT", "timeout"));

    const { creditTokens } = await import("./intercard-router");
    await expect(creditTokens(CREDIT)).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
    expect(cloud.creditTokens).not.toHaveBeenCalled();
  });

  it("NEVER falls back on a mid-flight NETWORK error (ambiguous)", async () => {
    const { cloud, onsite } = await mocks();
    onsite.creditTokens.mockRejectedValue(new IntercardError("NETWORK", "socket hang up"));

    const { creditTokens } = await import("./intercard-router");
    await expect(creditTokens(CREDIT)).rejects.toMatchObject({ code: "NETWORK" });
    expect(cloud.creditTokens).not.toHaveBeenCalled();
  });

  it("NEVER falls back on an HTTP 5xx (ambiguous)", async () => {
    const { cloud, onsite } = await mocks();
    onsite.creditTokens.mockRejectedValue(new IntercardError("HTTP_500", "server error"));

    const { creditTokens } = await import("./intercard-router");
    await expect(creditTokens(CREDIT)).rejects.toMatchObject({ code: "HTTP_500" });
    expect(cloud.creditTokens).not.toHaveBeenCalled();
  });

  it("applies the same asymmetry to consolidate (value movement, not just credit)", async () => {
    const { cloud, onsite } = await mocks();
    const params = {
      locationCode: 12,
      targetAccount: "1098379",
      sourceAccounts: ["1038010"],
      tpiTransactionID: "consol-1",
    };

    onsite.consolidateAccounts.mockRejectedValue(new IntercardError("RELAY_TIMEOUT", "t"));
    const { consolidateAccounts } = await import("./intercard-router");
    await expect(consolidateAccounts(params)).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
    expect(cloud.consolidateAccounts).not.toHaveBeenCalled();

    onsite.consolidateAccounts.mockRejectedValue(new IntercardError("RELAY_OFFLINE", "o"));
    cloud.consolidateAccounts.mockResolvedValue({ code: 0 });
    expect((await consolidateAccounts(params)).transport).toBe("cloud");
  });

  it("applies the same asymmetry to clearAccount (a clear REMOVES an account)", async () => {
    const { cloud, onsite } = await mocks();
    const params = { locationCode: 12, accountNumbers: ["1038010"], tpiTransactionID: "clr-1" };

    onsite.clearAccount.mockRejectedValue(new IntercardError("RELAY_TIMEOUT", "t"));
    const { clearAccount } = await import("./intercard-router");
    await expect(clearAccount(params)).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
    expect(cloud.clearAccount).not.toHaveBeenCalled();
  });
});

describe("intercard router — kill switch", () => {
  it("INTERCARD_ONSITE_ENABLED=false forces every call back to the proven cloud path", async () => {
    // Repo rule: flags are kill switches only — default ON, `!== "false"`.
    vi.stubEnv("INTERCARD_ONSITE_ENABLED", "false");
    const { cloud, onsite } = await mocks();
    cloud.creditTokens.mockResolvedValue({ code: 0 });
    cloud.verifyAccount.mockResolvedValue({ exists: true, accountNumber: "1098379" });

    const { creditTokens, verifyAccount } = await import("./intercard-router");
    expect((await creditTokens(CREDIT)).transport).toBe("cloud");
    expect((await verifyAccount("1098379", 12)).transport).toBe("cloud");
    expect(onsite.creditTokens).not.toHaveBeenCalled();
    expect(onsite.verifyAccount).not.toHaveBeenCalled();
  });

  it("the SOAP revert also reroutes the load-confirm read and the encode clear to cloud", async () => {
    // verifyAccountOnsite / clearAccountOnsite are onsite-only by default, but a
    // full SOAP revert (kill switch) must leave NOTHING on onsite — including the
    // clear. With the switch off they go cloud SOAP too.
    vi.stubEnv("INTERCARD_ONSITE_ENABLED", "false");
    const { cloud, onsite } = await mocks();
    cloud.verifyAccount.mockResolvedValue({
      exists: true,
      accountNumber: "1098379",
      balance: { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
    });
    cloud.clearAccount.mockResolvedValue({ code: 0 });

    const { verifyAccountOnsite, clearAccountOnsite } = await import("./intercard-router");
    const v = await verifyAccountOnsite("1098379", 13);
    const c = await clearAccountOnsite({
      accountNumbers: ["1098379"],
      locationCode: 13,
      tpiTransactionID: "x",
    });

    expect(v.transport).toBe("cloud");
    expect(c.transport).toBe("cloud");
    expect(onsite.verifyAccount).not.toHaveBeenCalled();
    expect(onsite.clearAccount).not.toHaveBeenCalled();
    // tpiTransactionID is dropped for the cloud clear (SOAP doesn't take it).
    expect(cloud.clearAccount).toHaveBeenCalledWith({
      locationCode: 13,
      accountNumbers: ["1098379"],
    });
  });

  it("is ON by default (absent env var = onsite priority)", async () => {
    const { onsite } = await mocks();
    onsite.creditTokens.mockResolvedValue({ code: 0 });
    const { creditTokens } = await import("./intercard-router");
    expect((await creditTokens(CREDIT)).transport).toBe("onsite");
  });
});

describe("intercard router — independent of the retired LOAD_MODE vars", () => {
  // INTERCARD_LOAD_MODE / NEXT_PUBLIC_INTERCARD_LOAD_MODE are being deleted from
  // Vercel. Removing an env var must never change which card system we talk to,
  // so the router must ignore them in EVERY state they could be left in.
  it("ignores INTERCARD_LOAD_MODE entirely — set, unset, or any value", async () => {
    const { cloud, onsite } = await mocks();
    onsite.creditTokens.mockResolvedValue({ code: 0 });
    const { creditTokens } = await import("./intercard-router");

    for (const mode of ["cloud", "local", "auto", ""]) {
      vi.stubEnv("INTERCARD_LOAD_MODE", mode);
      expect((await creditTokens(CREDIT)).transport).toBe("onsite");
    }
    vi.unstubAllEnvs(); // and with the var absent altogether
    expect((await creditTokens(CREDIT)).transport).toBe("onsite");
    expect(cloud.creditTokens).not.toHaveBeenCalled();
  });

  it("the kill switch still wins over anything LOAD_MODE says", async () => {
    vi.stubEnv("INTERCARD_LOAD_MODE", "local");
    vi.stubEnv("INTERCARD_ONSITE_ENABLED", "false");
    const { cloud, onsite } = await mocks();
    cloud.creditTokens.mockResolvedValue({ code: 0 });
    const { creditTokens } = await import("./intercard-router");
    expect((await creditTokens(CREDIT)).transport).toBe("cloud");
    expect(onsite.creditTokens).not.toHaveBeenCalled();
  });
});

/**
 * SOAP returned balance and history from ONE operation; the onsite proxy splits
 * them, and `onsite.verifyAccount` only does the balance half. Until 2026-09-01
 * the router shipped that half straight through, so `transactions` was
 * `undefined` on every onsite read in production (measured: 0 of 36).
 */
describe("intercard router — onsite reads carry history, not just balance", () => {
  const BAL = {
    exists: true,
    accountNumber: "1098379",
    balance: { tokens: 0, bonusTokens: 0, eTickets: 0, timeMinutes: 0 },
  };
  const TXN = {
    device: "Hot Wheels",
    transType: "Game Play",
    tokens: -20,
    bonusTokens: 0,
    points: 0,
    cash: 0,
    timeStamp: "2026-09-01 22:26:08",
    location: "FastTrax Fort Myers",
  };

  it("attaches the onsite account history to an onsite balance read", async () => {
    const { cloud, onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue(BAL);
    onsite.accountHistory.mockResolvedValue([TXN]);

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 13);

    expect(res.transport).toBe("onsite");
    expect(res.transactions).toEqual([TXN]);
    expect(onsite.accountHistory).toHaveBeenCalledWith("1098379", 13);
    expect(cloud.verifyAccount).not.toHaveBeenCalled();
  });

  it("defaults the history location the same way the balance call does", async () => {
    const { onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue(BAL);
    onsite.accountHistory.mockResolvedValue([]);

    const { verifyAccount } = await import("./intercard-router");
    await verifyAccount("1098379");

    expect(onsite.accountHistory).toHaveBeenCalledWith("1098379", 12);
  });

  it("fails an EMPTY onsite history over to the cloud SOAP copy (FastTrax serves none)", async () => {
    const { cloud, onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue(BAL);
    onsite.accountHistory.mockResolvedValue([]); // on-site says "none"
    cloud.verifyAccount.mockResolvedValue({ ...BAL, transactions: [TXN] });

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 12);

    expect(res.transport).toBe("onsite"); // balance is still the onsite one
    expect(res.transactions).toEqual([TXN]); // history came from cloud
    expect(res.historyFromCloud).toBe(true);
    expect(cloud.verifyAccount).toHaveBeenCalledTimes(1);
  });

  it("a FAILED onsite history fails over to cloud but KEEPS the onsite balance", async () => {
    const { cloud, onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue(BAL);
    onsite.accountHistory.mockRejectedValue(new IntercardError("RELAY_TIMEOUT", "no answer"));
    cloud.verifyAccount.mockResolvedValue({ ...BAL, transactions: [TXN] });

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 12);

    // The balance stays the real-time onsite one; only the history is sourced
    // from the datacenter copy.
    expect(res.transport).toBe("onsite");
    expect(res.balance?.tokens).toBe(0);
    expect(res.transactions).toEqual([TXN]);
    expect(res.historyFromCloud).toBe(true);
  });

  it("a history call that throws SYNCHRONOUSLY is contained, then fails over to cloud", async () => {
    const { cloud, onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue(BAL);
    onsite.accountHistory.mockImplementation(() => {
      throw new TypeError("boom");
    });
    cloud.verifyAccount.mockResolvedValue({ ...BAL, transactions: [TXN] });

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 12);

    expect(res.transport).toBe("onsite");
    expect(res.transactions).toEqual([TXN]);
    expect(res.historyFromCloud).toBe(true);
  });

  it("does not chase history for an account that does not exist", async () => {
    const { onsite } = await mocks();
    onsite.verifyAccount.mockResolvedValue({
      exists: false,
      accountNumber: "1098379",
      notFound: "confirmed",
    });
    onsite.accountHistory.mockResolvedValue([]);

    const { verifyAccount } = await import("./intercard-router");
    const res = await verifyAccount("1098379", 12);

    expect(res.exists).toBe(false);
    expect(res.transactions).toBeUndefined();
  });
});
