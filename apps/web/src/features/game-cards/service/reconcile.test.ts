import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TxnRow } from "../data/transactions-log";

const calls: string[] = [];

vi.mock("../data/transactions-log", () => ({
  listPendingLoads: vi.fn(async () => {
    calls.push("listPendingLoads");
    return [];
  }),
  markLoadState: vi.fn(async (_id: string, state: string) => {
    calls.push("markLoadState:" + state);
  }),
  incrementAttempt: vi.fn(async () => 1),
  sweepStaleQueued: vi.fn(async () => {
    calls.push("sweepStaleQueued");
    return [];
  }),
  sweepStaleClaimed: vi.fn(async () => {
    calls.push("sweepStaleClaimed");
    return [];
  }),
  listVerifyRows: vi.fn(async () => []),
  markVerifiedLoaded: vi.fn(async () => {
    calls.push("markVerifiedLoaded");
    return true;
  }),
  markVerifyManual: vi.fn(async () => {
    calls.push("markVerifyManual");
    return true;
  }),
}));

// Keep the REAL parseIntercardTimestamp (the matcher's behavior under odd
// vendor formats is part of what's under test); mock only the SOAP calls.
vi.mock("../data/intercard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/intercard")>();
  // The SOAP replay now goes through credit-plan.ts → creditAccountValues.
  return {
    ...actual,
    creditTokens: vi.fn(),
    creditAccountValues: vi.fn(),
    verifyAccount: vi.fn(),
  };
});

function row(overrides: Partial<TxnRow>): TxnRow {
  return {
    id: 1,
    txnId: "txn-1",
    groupId: "g-1",
    kind: "reload",
    locationCode: 13,
    accountNumber: "1038010",
    packageId: "not-a-real-package", // force row token counts, not catalog lookups
    tokens: 500,
    bonusTokens: 100,
    amountCents: 5000,
    tpiTransactionId: "reload-txn-1",
    squareOrderId: "o-1",
    squarePaymentIds: null,
    state: "charged",
    loadState: "pending",
    attempt: 0,
    error: null,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    completedAt: null,
    queueState: null,
    queuedAt: null,
    claimedBy: null,
    claimedAt: null,
    ackedAt: null,
    eisCode: null,
    eisDescription: null,
    loadedVia: null,
    voucherCode: null,
    ...overrides,
  };
}

async function loadMocks() {
  const tlog = await import("../data/transactions-log");
  const intercard = await import("../data/intercard");
  return { tlog, intercard };
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe("reconcile phases", () => {
  it("sweeps the queue BEFORE building the SOAP replay list", async () => {
    const { reconcilePendingLoads } = await import("./reconcile");
    await reconcilePendingLoads();
    expect(calls.indexOf("sweepStaleQueued")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("sweepStaleQueued")).toBeLessThan(calls.indexOf("listPendingLoads"));
    expect(calls.indexOf("sweepStaleClaimed")).toBeLessThan(calls.indexOf("listPendingLoads"));
  });

  it("dryRun mutates nothing (no sweeps, no credits, no verify writes)", async () => {
    const { tlog, intercard } = await loadMocks();
    (tlog.listPendingLoads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([row({})]);
    (tlog.listVerifyRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      row({ queueState: "verify" }),
    ]);
    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads(true);
    expect(summary.stillPending).toBe(1);
    expect(summary.verifyScanned).toBe(1);
    expect(tlog.sweepStaleQueued).not.toHaveBeenCalled();
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
    expect(intercard.verifyAccount).not.toHaveBeenCalled();
  });

  it("SOAP-replays eligible pending rows with the stored tpi id", async () => {
    const { tlog, intercard } = await loadMocks();
    (tlog.listPendingLoads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([row({})]);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ code: 0 });
    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads();
    expect(intercard.creditAccountValues).toHaveBeenCalledWith(
      expect.objectContaining({ tpiTransactionID: "reload-txn-1", tokens: 500, tokenBonus: 100 }),
    );
    expect(calls).toContain("markLoadState:loaded");
    expect(summary.loaded).toBe(1);
  });
});

describe("verify resolution (unknown EIS outcome)", () => {
  it("matching history credit → verified loaded, and SOAP is NEVER called", async () => {
    const { tlog, intercard } = await loadMocks();
    const queuedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    (tlog.listVerifyRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      row({ queueState: "verify", queuedAt }),
    ]);
    // History renders ET wall time; hand the matcher the row's own moment.
    const et = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(queuedAt));
    const p: Record<string, string> = {};
    for (const part of et) p[part.type] = part.value;
    const ts = `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exists: true,
      accountNumber: "1038010",
      transactions: [
        {
          device: "Web",
          transType: "Credit",
          tokens: 500,
          bonusTokens: 100,
          points: 0,
          cash: 0,
          timeStamp: ts,
          location: "FastTrax",
        },
      ],
    });
    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads();
    expect(calls).toContain("markVerifiedLoaded");
    expect(summary.verified).toBe(1);
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
  });

  it("no match + old row → manual (never SOAP)", async () => {
    const { tlog, intercard } = await loadMocks();
    (tlog.listVerifyRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      row({ queueState: "verify", queuedAt: new Date(Date.now() - 40 * 60_000).toISOString() }),
    ]);
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exists: true,
      accountNumber: "1038010",
      transactions: [
        // Same tokens but unparseable timestamp — must NOT count as a match.
        {
          device: "",
          transType: "",
          tokens: 500,
          bonusTokens: 100,
          points: 0,
          cash: 0,
          timeStamp: "garbage",
          location: "",
        },
        // Parseable but wrong amounts.
        {
          device: "",
          transType: "",
          tokens: 100,
          bonusTokens: 0,
          points: 0,
          cash: 0,
          timeStamp: "2026-07-20 10:00:00",
          location: "",
        },
      ],
    });
    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads();
    expect(calls).toContain("markVerifyManual");
    expect(summary.manual).toBe(1);
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
  });

  it("no match + young row → left for the next run", async () => {
    const { tlog, intercard } = await loadMocks();
    (tlog.listVerifyRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      row({ queueState: "verify", queuedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
    ]);
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exists: true,
      accountNumber: "1038010",
      transactions: [],
    });
    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads();
    expect(calls).not.toContain("markVerifyManual");
    expect(calls).not.toContain("markVerifiedLoaded");
    expect(summary.manual).toBe(0);
    expect(summary.verified).toBe(0);
  });

  it("history lookup failure leaves the row untouched", async () => {
    const { tlog, intercard } = await loadMocks();
    (tlog.listVerifyRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      row({ queueState: "verify", queuedAt: new Date(Date.now() - 90 * 60_000).toISOString() }),
    ]);
    (intercard.verifyAccount as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("down"));
    const { reconcilePendingLoads } = await import("./reconcile");
    await reconcilePendingLoads();
    expect(calls).not.toContain("markVerifyManual");
    expect(calls).not.toContain("markVerifiedLoaded");
  });
});

describe("parseIntercardTimestamp", () => {
  it("parses ISO-ish and US formats as Eastern wall time; rejects garbage", async () => {
    const { parseIntercardTimestamp } = await import("../data/intercard");
    // 2026-07-20 is EDT (UTC-4): 14:33 ET == 18:33Z.
    expect(parseIntercardTimestamp("2026-07-20 14:33:05")).toBe(Date.UTC(2026, 6, 20, 18, 33, 5));
    expect(parseIntercardTimestamp("2026-07-20T14:33:05")).toBe(Date.UTC(2026, 6, 20, 18, 33, 5));
    expect(parseIntercardTimestamp("7/20/2026 2:33:05 PM")).toBe(Date.UTC(2026, 6, 20, 18, 33, 5));
    // 2026-01-20 is EST (UTC-5).
    expect(parseIntercardTimestamp("2026-01-20 14:33:00")).toBe(Date.UTC(2026, 0, 20, 19, 33, 0));
    expect(parseIntercardTimestamp("garbage")).toBeNull();
    expect(parseIntercardTimestamp("")).toBeNull();
  });
});
