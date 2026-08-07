/**
 * Tender-sweep classifier — fixtures of (ledger row, anchor, Square state) →
 * expected action, with the money rules pinned: forward-capture covered sets
 * (never silently void committed money), record captured-but-unfinalized,
 * void abandoned holds via the rail's own unwind, dry run mutates nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({
  default: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
  },
}));
vi.mock("@/lib/teams-bot", () => ({
  sendAdaptiveCardToChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock("~/features/refund-alerts/config", () => ({
  refundAlertsChatId: vi.fn(() => "chat-1"),
}));
vi.mock("~/features/booking/service/unified-reserve", () => ({
  readTerminalAnchor: vi.fn(async () => null),
}));
vi.mock("./square-terminal", () => ({
  getOrderPaymentInfo: vi.fn(async () => null),
}));
vi.mock("./split-tenders", () => ({
  abandonSplit: vi.fn(async () => ({ ok: true })),
  captureSplit: vi.fn(async () => ({ ok: true, paymentIds: ["p1"], primaryPaymentId: "p1" })),
  harvestAndDismissPending: vi.fn(async (_seed: string, anchor: unknown) => anchor),
  splitRemainingCents: vi.fn(
    (a: {
      totalCents?: number;
      depositCents: number;
      tenders?: Array<{ status: string; amountCents: number }>;
    }) =>
      Math.max(
        0,
        (a.totalCents ?? a.depositCents) -
          (a.tenders ?? [])
            .filter((t) => t.status === "authorized")
            .reduce((s, t) => s + t.amountCents, 0),
      ),
  ),
  verifiedCancel: vi.fn(async () => "canceled"),
}));
vi.mock("../data/split-tenders-db", () => ({
  listStaleOpenSplitAttempts: vi.fn(async () => []),
  setSplitCaptured: vi.fn(async () => ({ persisted: true })),
  setSplitState: vi.fn(async () => {}),
}));

import { readTerminalAnchor } from "~/features/booking/service/unified-reserve";
import { getOrderPaymentInfo } from "./square-terminal";
import { abandonSplit, captureSplit, verifiedCancel } from "./split-tenders";
import {
  listStaleOpenSplitAttempts,
  setSplitCaptured,
  setSplitState,
} from "../data/split-tenders-db";
import { runKioskTenderSweep } from "./tender-sweep.server";

const mockRows = listStaleOpenSplitAttempts as unknown as ReturnType<typeof vi.fn>;
const mockAnchor = readTerminalAnchor as unknown as ReturnType<typeof vi.fn>;
const mockOrder = getOrderPaymentInfo as unknown as ReturnType<typeof vi.fn>;
const mockCapture = captureSplit as unknown as ReturnType<typeof vi.fn>;
const mockAbandon = abandonSplit as unknown as ReturnType<typeof vi.fn>;
const mockCancel = verifiedCancel as unknown as ReturnType<typeof vi.fn>;
const mockSetCaptured = setSplitCaptured as unknown as ReturnType<typeof vi.fn>;
const mockSetState = setSplitState as unknown as ReturnType<typeof vi.fn>;

const row = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  seed: "seed-1",
  baseKey: "bk-1",
  surface: "kiosk",
  depositOrderId: "ord_1",
  locationId: "LOC",
  totalCents: 5000,
  tenders: [],
  paymentIds: [],
  state: "open",
  attempt: 0,
  capturedAt: null,
  createdAt: "",
  updatedAt: "",
  ...extra,
});

const anchor = (extra: Record<string, unknown> = {}) => ({
  depositOrderId: "ord_1",
  depositCents: 5000,
  totalCents: 5000,
  locationId: "LOC",
  baseKey: "bk-1",
  splitToken: "tok",
  tenders: [],
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRows.mockResolvedValue([]);
  mockAnchor.mockResolvedValue(null);
  mockOrder.mockResolvedValue(null);
  mockCapture.mockResolvedValue({ ok: true, paymentIds: ["p1"], primaryPaymentId: "p1" });
  mockAbandon.mockResolvedValue({ ok: true });
  mockCancel.mockResolvedValue("canceled");
  mockSetCaptured.mockResolvedValue({ persisted: true });
});

describe("kiosk tender sweep", () => {
  it("anchor lost + order COMPLETED → captured-not-finalized, full set persisted", async () => {
    mockRows.mockResolvedValue([row()]);
    mockOrder.mockResolvedValue({ state: "COMPLETED", paymentId: "p1", paymentIds: ["p1", "p2"] });
    const res = await runKioskTenderSweep();
    expect(res.outcomes[0].action).toBe("captured-not-finalized");
    expect(mockSetCaptured).toHaveBeenCalledWith(
      "bk-1",
      expect.objectContaining({ paymentIds: ["p1", "p2"] }),
    );
  });

  it("anchor lost + order OPEN → voids the ledger's authorized holds, closes the row", async () => {
    mockRows.mockResolvedValue([
      row({
        tenders: [
          {
            index: 0,
            kind: "gift_card",
            paymentId: "gc1",
            amountCents: 2000,
            status: "authorized",
          },
          { index: 1, kind: "terminal", paymentId: "t1", amountCents: 0, status: "canceled" },
        ],
      }),
    ]);
    mockOrder.mockResolvedValue({ state: "OPEN", paymentId: null, paymentIds: [] });
    const res = await runKioskTenderSweep();
    expect(res.outcomes[0].action).toBe("canceled");
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith("bk-1", "gc1");
    expect(mockSetState).toHaveBeenCalledWith("bk-1", "canceled");
  });

  it("anchor lost + a void that does not stick → needs-review", async () => {
    mockRows.mockResolvedValue([
      row({
        tenders: [
          {
            index: 0,
            kind: "gift_card",
            paymentId: "gc1",
            amountCents: 2000,
            status: "authorized",
          },
        ],
      }),
    ]);
    mockCancel.mockResolvedValue("cancel-failed");
    const res = await runKioskTenderSweep();
    expect(res.outcomes[0].action).toBe("needs-review");
    expect(mockSetState).toHaveBeenCalledWith("bk-1", "needs_review");
  });

  it("holds cover the total → forward-CAPTURE (never silently void committed money)", async () => {
    mockRows.mockResolvedValue([row()]);
    mockAnchor.mockResolvedValue(
      anchor({
        tenders: [
          {
            index: 0,
            kind: "gift_card",
            paymentId: "gc1",
            amountCents: 5000,
            status: "authorized",
          },
        ],
      }),
    );
    const res = await runKioskTenderSweep();
    expect(res.outcomes[0].action).toBe("forward-captured");
    expect(mockCapture).toHaveBeenCalledWith({ seed: "seed-1", splitToken: "tok" });
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it("partial holds → unwound via the rail's own abandon", async () => {
    mockRows.mockResolvedValue([row()]);
    mockAnchor.mockResolvedValue(
      anchor({
        tenders: [
          {
            index: 0,
            kind: "gift_card",
            paymentId: "gc1",
            amountCents: 2000,
            status: "authorized",
          },
        ],
      }),
    );
    const res = await runKioskTenderSweep();
    expect(res.outcomes[0].action).toBe("canceled");
    expect(mockAbandon).toHaveBeenCalledWith({ seed: "seed-1", splitToken: "tok" });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("capturedAt on the anchor → captured-not-finalized (row was left open)", async () => {
    mockRows.mockResolvedValue([row()]);
    mockAnchor.mockResolvedValue(
      anchor({ capturedAt: "2026-08-06T00:00:00Z", paymentIds: ["p1", "p2"] }),
    );
    const res = await runKioskTenderSweep();
    expect(res.outcomes[0].action).toBe("captured-not-finalized");
    expect(mockSetCaptured).toHaveBeenCalledWith(
      "bk-1",
      expect.objectContaining({ paymentIds: ["p1", "p2"], capturedAt: "2026-08-06T00:00:00Z" }),
    );
  });

  it("a busy lock (live capture in flight) → skipped, untouched", async () => {
    mockRows.mockResolvedValue([row()]);
    mockAnchor.mockResolvedValue(
      anchor({
        tenders: [
          {
            index: 0,
            kind: "gift_card",
            paymentId: "gc1",
            amountCents: 5000,
            status: "authorized",
          },
        ],
      }),
    );
    mockCapture.mockResolvedValue({ ok: false, error: "busy" });
    const res = await runKioskTenderSweep();
    expect(res.outcomes[0].action).toBe("skipped-locked");
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it("dry run classifies without mutating ANYTHING", async () => {
    mockRows.mockResolvedValue([
      row({
        tenders: [
          {
            index: 0,
            kind: "gift_card",
            paymentId: "gc1",
            amountCents: 2000,
            status: "authorized",
          },
        ],
      }),
    ]);
    mockAnchor.mockResolvedValue(
      anchor({
        tenders: [
          {
            index: 0,
            kind: "gift_card",
            paymentId: "gc1",
            amountCents: 2000,
            status: "authorized",
          },
        ],
      }),
    );
    const res = await runKioskTenderSweep({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.outcomes[0].action).toBe("canceled");
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockAbandon).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockSetCaptured).not.toHaveBeenCalled();
    expect(mockSetState).not.toHaveBeenCalled();
  });

  it("a row that throws is flagged needs_review and the sweep keeps going", async () => {
    mockRows.mockResolvedValue([row(), row({ id: 2, seed: "seed-2", baseKey: "bk-2" })]);
    mockAnchor.mockRejectedValueOnce(new Error("redis exploded"));
    mockOrder.mockResolvedValue({ state: "COMPLETED", paymentId: "p1", paymentIds: ["p1"] });
    const res = await runKioskTenderSweep();
    expect(res.outcomes[0].action).toBe("needs-review");
    expect(res.outcomes[1].action).toBe("captured-not-finalized");
  });
});
