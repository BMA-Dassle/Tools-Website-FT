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
  countStuckLegacyQueueRows: vi.fn(async () => 0),
}));

// credit-plan (real, unmocked) replays credits through the router, so that is
// the seam to intercept.
vi.mock("../data/intercard-router", () => ({
  creditTokens: vi.fn(),
  creditAccountValues: vi.fn(),
  verifyAccount: vi.fn(),
}));

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
  // The router is what credit-plan replays credits through.
  const intercard = await import("../data/intercard-router");
  return { tlog, intercard };
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe("reconcile (recover-forward replay)", () => {
  it("dryRun mutates nothing — no credits", async () => {
    const { tlog, intercard } = await loadMocks();
    (tlog.listPendingLoads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([row({})]);
    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads(true);
    expect(summary.stillPending).toBe(1);
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
  });

  it("replays eligible pending rows with the stored tpi id (dedup-safe)", async () => {
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

  it("a non-zero Intercard code leaves the row pending (never marks loaded)", async () => {
    const { tlog, intercard } = await loadMocks();
    (tlog.listPendingLoads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([row({})]);
    (intercard.creditAccountValues as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ code: -1 });
    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads();
    expect(calls).not.toContain("markLoadState:loaded");
    expect(summary.loaded).toBe(0);
    expect(summary.stillPending).toBe(1);
  });
});

describe("reconcile — legacy queue alarm (money safety)", () => {
  it("counts stuck 'claimed'/'verify' rows and surfaces them, without crediting", async () => {
    const { tlog, intercard } = await loadMocks();
    (tlog.countStuckLegacyQueueRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce(3);
    (tlog.listPendingLoads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads();

    expect(summary.stuckLegacy).toBe(3);
    // The alarm is NOT an auto-fix: ambiguous EIS rows are never re-credited
    // (that would double-charge — neither EIS nor the proxy dedups).
    expect(intercard.creditAccountValues).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("MANUAL INTERVENTION REQUIRED"));
    err.mockRestore();
  });

  it("stays quiet when nothing is stuck (the drained steady state)", async () => {
    const { tlog } = await loadMocks();
    (tlog.countStuckLegacyQueueRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
    (tlog.listPendingLoads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const { reconcilePendingLoads } = await import("./reconcile");
    const summary = await reconcilePendingLoads();

    expect(summary.stuckLegacy).toBe(0);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
