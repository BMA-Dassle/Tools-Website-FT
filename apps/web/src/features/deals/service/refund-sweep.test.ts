/**
 * The sweep.
 *
 * The load-bearing property is a NEGATIVE one: it must never re-issue money. A
 * sweep that decides to retry a refund is the only component in this feature
 * capable of paying twice, so most of these tests assert that it looked rather
 * than acted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listStalledDealRefunds: vi.fn(),
  updateDealRefund: vi.fn(),
  recomputeDealRefundTotals: vi.fn(),
}));

vi.mock("../data/deal-refunds-db", () => ({
  listStalledDealRefunds: mocks.listStalledDealRefunds,
  updateDealRefund: mocks.updateDealRefund,
  recomputeDealRefundTotals: mocks.recomputeDealRefundTotals,
}));

const { ESCALATE_AFTER_MINUTES, sweepDealRefunds } = await import("./refund-sweep");

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

interface RowPatch {
  [k: string]: unknown;
}
const row = (patch: RowPatch = {}) => ({
  id: 7,
  purchaseId: 412,
  seq: 1,
  refundKey: "0123456789abcdef-rf1",
  destination: "card",
  packs: 1,
  packIndexes: [0],
  plannedCents: 3621,
  refundedCents: 3621,
  reason: "bought twice",
  actor: "admin",
  state: "crediting",
  squareReturnOrderId: "RET1",
  squareRefundId: "RFND1",
  squareRefundStatus: "PENDING",
  destinationGiftCardId: null,
  destinationGiftCardGan: null,
  heldLegs: { HPWAAA: [0, 1, 2, 3] },
  holdTxnId: "dealrf-0123456789abcdef-rf1",
  voidedCodes: [],
  planHash: "h".repeat(64),
  spentOverride: false,
  lastError: null,
  createdAt: minutesAgo(5),
  settledAt: null,
  ...patch,
});

function deps(patch: RefundSweepDepsPatch = {}) {
  return {
    giftCardBalanceCents: vi.fn<(id: string) => Promise<number | null>>(async () => 3621),
    refundStatus: vi.fn<(id: string) => Promise<{ status: string; amountCents: number } | null>>(
      async () => ({ status: "COMPLETED", amountCents: 3621 }),
    ),
    ...patch,
  };
}
interface RefundSweepDepsPatch {
  giftCardBalanceCents?: unknown;
  refundStatus?: unknown;
}

const sweep = (rows: unknown[], d = deps()) => {
  mocks.listStalledDealRefunds.mockResolvedValue(rows);
  return sweepDealRefunds({ deps: d as never, now: NOW });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateDealRefund.mockResolvedValue(undefined);
  mocks.recomputeDealRefundTotals.mockResolvedValue(undefined);
});

describe("card destination", () => {
  it("settles an attempt Square says COMPLETED", async () => {
    const res = await sweep([row({ state: "returning" })]);
    expect(res.settled).toBe(1);
    expect(mocks.updateDealRefund).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ state: "settled", settledAt: true }),
    );
    // The projection has to catch up or the board understates the refund.
    expect(mocks.recomputeDealRefundTotals).toHaveBeenCalledWith(412);
  });

  it("records Square's amount rather than trusting the ledger's", async () => {
    await sweep([row({ refundedCents: 0 })], deps({
      refundStatus: vi.fn(async () => ({ status: "COMPLETED", amountCents: 3599 })),
    }));
    expect(mocks.updateDealRefund).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ refundedCents: 3599 }),
    );
  });

  it("fails an attempt Square rejected, and says to check the legs", async () => {
    const res = await sweep([row()], deps({
      refundStatus: vi.fn(async () => ({ status: "REJECTED", amountCents: 0 })),
    }));
    expect(res.failed).toBe(1);
    expect(res.outcomes[0].detail).toMatch(/voucher legs/i);
    expect(mocks.recomputeDealRefundTotals).not.toHaveBeenCalled();
  });

  it("leaves a young PENDING attempt alone", async () => {
    const res = await sweep([row()], deps({
      refundStatus: vi.fn(async () => ({ status: "PENDING", amountCents: 3621 })),
    }));
    expect(res.stillPending).toBe(1);
    expect(mocks.updateDealRefund).not.toHaveBeenCalled();
  });

  it("escalates a long-PENDING attempt to a human instead of retrying", async () => {
    const d = deps({ refundStatus: vi.fn(async () => ({ status: "PENDING", amountCents: 3621 })) });
    const res = await sweep([row({ createdAt: minutesAgo(ESCALATE_AFTER_MINUTES + 1) })], d);
    expect(res.needsHuman).toBe(1);
    expect(mocks.updateDealRefund).not.toHaveBeenCalled();
  });
});

describe("gift-card destination", () => {
  const gc = (patch: RowPatch = {}) =>
    row({ destination: "gift_card", destinationGiftCardId: "GC1", ...patch });

  it("settles on the CARD BALANCE, not the refund status", async () => {
    // A live smoke showed a credit landed while the refund still read PENDING.
    // Gating on status would park a refund whose money is already there.
    const res = await sweep([gc()], deps({
      refundStatus: vi.fn(async () => ({ status: "PENDING", amountCents: 3621 })),
      giftCardBalanceCents: vi.fn(async () => 3621),
    }));
    expect(res.settled).toBe(1);
    expect(mocks.updateDealRefund).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ state: "settled" }),
    );
  });

  it("keeps waiting while the balance is short", async () => {
    const res = await sweep([gc()], deps({
      refundStatus: vi.fn(async () => ({ status: "PENDING", amountCents: 3621 })),
      giftCardBalanceCents: vi.fn(async () => 0),
    }));
    expect(res.stillPending).toBe(1);
    expect(mocks.updateDealRefund).not.toHaveBeenCalled();
  });

  it("escalates a stale uncredited card and says DO NOT re-refund", async () => {
    // The one instruction that matters if a human is about to intervene.
    const res = await sweep(
      [gc({ createdAt: minutesAgo(ESCALATE_AFTER_MINUTES + 5) })],
      deps({
        refundStatus: vi.fn(async () => ({ status: "PENDING", amountCents: 3621 })),
        giftCardBalanceCents: vi.fn(async () => 0),
      }),
    );
    expect(res.needsHuman).toBe(1);
    expect(res.outcomes[0].detail).toMatch(/do not re-refund/i);
  });

  it("does not settle on an unreadable balance", async () => {
    const res = await sweep([gc()], deps({
      giftCardBalanceCents: vi.fn(async () => null),
      refundStatus: vi.fn(async () => ({ status: "PENDING", amountCents: 3621 })),
    }));
    expect(res.settled).toBe(0);
  });
});

describe("an attempt that never reached Square", () => {
  const noId = (patch: RowPatch = {}) =>
    row({ state: "held", squareRefundId: null, squareRefundStatus: null, ...patch });

  it("waits while it is young", async () => {
    const res = await sweep([noId()]);
    expect(res.stillPending).toBe(1);
    expect(mocks.updateDealRefund).not.toHaveBeenCalled();
  });

  it("fails it for a re-plan once stale, WITHOUT replaying anything", async () => {
    // A blind replay here is precisely how you refund twice: we do not know
    // whether Square was asked. A human verifies and re-plans.
    const d = deps();
    const res = await sweep([noId({ createdAt: minutesAgo(ESCALATE_AFTER_MINUTES + 1) })], d);
    expect(res.failed).toBe(1);
    expect(res.outcomes[0].detail).toMatch(/verify in square/i);
    expect(d.refundStatus).not.toHaveBeenCalled();
    expect(d.giftCardBalanceCents).not.toHaveBeenCalled();
  });
});

describe("reporting", () => {
  it("reports every row it looked at, even when it resolved nothing", async () => {
    // A sweep that goes quiet when it gives up is indistinguishable from a sweep
    // with nothing to do.
    const res = await sweep([row(), row({ id: 8 })], deps({
      refundStatus: vi.fn(async () => ({ status: "PENDING", amountCents: 3621 })),
    }));
    expect(res.scanned).toBe(2);
    expect(res.outcomes).toHaveLength(2);
  });

  it("survives a Square read that throws", async () => {
    const res = await sweep([row()], deps({
      refundStatus: vi.fn(async () => {
        throw new Error("square down");
      }),
    }));
    // Unreadable is not terminal — it parks rather than inventing an outcome.
    expect(res.stillPending + res.needsHuman).toBe(1);
    expect(res.failed).toBe(0);
  });

  it("returns an empty result when there is nothing stalled", async () => {
    const res = await sweep([]);
    expect(res).toMatchObject({ scanned: 0, settled: 0, failed: 0, needsHuman: 0 });
  });
});
