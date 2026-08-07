/**
 * Kiosk split-tender service — mocked Redis / Neon / Square-module,
 * exercising the money-ordering rules from the 2026-07-29 adversarial review
 * (persist-first, splitToken gating, verified cancels, paymentIds pruning,
 * positive terminal-tender identification, attempt bump on every unwind,
 * idempotent capture replay, honest ledger on anchor loss) plus the ambient
 * gift-card primitives (2026-08-06): multi-tender caps via isGiftCardTender,
 * monotonic tenderSeq slots, append-only tenders, per-tender remove, and the
 * upsertTerminalAnchor merge-writer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const redisStore = new Map<string, string>();
vi.mock("@/lib/redis", () => ({
  default: {
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
      // Honor SET ... NX (the add lock)
      if (args.includes("NX") && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
  },
}));

vi.mock("@/lib/square-gift-card", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/square-gift-card")>();
  return {
    ...actual,
    getGiftCardFromGan: vi.fn(),
    retrieveGiftCardById: vi.fn(),
    createTenderAuth: vi.fn(),
    cancelSquarePayment: vi.fn(),
    payOrder: vi.fn(),
  };
});

vi.mock("../data/split-tenders-db", () => ({
  upsertSplitAttempt: vi.fn(async () => {}),
  setSplitTenders: vi.fn(async () => {}),
  setSplitState: vi.fn(async () => {}),
  setSplitCaptured: vi.fn(async () => ({ persisted: true })),
  touchSplitAttempt: vi.fn(async () => {}),
  getSplitAttempt: vi.fn(async () => null),
}));

vi.mock("~/features/booking/service/deposit", () => ({
  getSquarePayment: vi.fn(),
}));

vi.mock("./square-terminal", () => ({
  dismissTerminalCheckout: vi.fn(async () => true),
  getTerminalCheckout: vi.fn(async () => null),
  getOrderPaymentInfo: vi.fn(async () => null),
}));

import redis from "@/lib/redis";
import {
  cancelSquarePayment,
  createTenderAuth,
  getGiftCardFromGan,
  payOrder,
  retrieveGiftCardById,
} from "@/lib/square-gift-card";
import { getSquarePayment } from "~/features/booking/service/deposit";
import {
  stampVerifiedTerminalTender,
  upsertTerminalAnchor,
} from "~/features/booking/service/unified-reserve";
import { setSplitState, setSplitTenders, upsertSplitAttempt } from "../data/split-tenders-db";
import {
  dismissTerminalCheckout,
  getOrderPaymentInfo,
  getTerminalCheckout,
} from "./square-terminal";
import {
  abandonSplit,
  addGiftCardTender,
  captureSplit,
  lookupGiftCardForSplit,
  removeGiftCardTender,
  splitRemainingCents,
} from "./split-tenders";

const mockFromGan = getGiftCardFromGan as unknown as ReturnType<typeof vi.fn>;
const mockById = retrieveGiftCardById as unknown as ReturnType<typeof vi.fn>;
const mockAuth = createTenderAuth as unknown as ReturnType<typeof vi.fn>;
const mockCancel = cancelSquarePayment as unknown as ReturnType<typeof vi.fn>;
const mockPayOrder = payOrder as unknown as ReturnType<typeof vi.fn>;
const mockGetPayment = getSquarePayment as unknown as ReturnType<typeof vi.fn>;
const mockDismiss = dismissTerminalCheckout as unknown as ReturnType<typeof vi.fn>;
const mockGetCheckout = getTerminalCheckout as unknown as ReturnType<typeof vi.fn>;
const mockOrderInfo = getOrderPaymentInfo as unknown as ReturnType<typeof vi.fn>;

const SEED = "seed-abc";
const TOKEN = "secret-split-token";
const anchorKey = `kiosk:terminal:anchor:${SEED}`;
const baseAnchor = {
  depositOrderId: "ord_1",
  depositCents: 5_000,
  locationId: "LAB52GY480CJF",
  baseKey: "0123456789abcdef",
  splitToken: TOKEN,
};
const GC = {
  id: "gftc:g1",
  gan: "7783300000001234",
  balanceCents: 2_000,
  state: "ACTIVE",
  blocked: false,
};

function seedAnchor(extra: Record<string, unknown> = {}) {
  redisStore.set(anchorKey, JSON.stringify({ ...baseAnchor, ...extra }));
}
function readAnchor() {
  return JSON.parse(redisStore.get(anchorKey) as string);
}
/** What the terminal-checkout GET's stamp does for split anchors. */
function stampTap(paymentId: string, extra: Record<string, unknown> = {}) {
  const a = readAnchor();
  a.paymentIds = [...new Set([...(a.paymentIds ?? []), paymentId])];
  a.tenders = [
    ...(a.tenders ?? []),
    {
      index: (a.tenders ?? []).length,
      kind: "terminal",
      paymentId,
      amountCents: 0,
      status: "authorized",
      ...extra,
    },
  ];
  a.pendingCheckoutId = undefined;
  redisStore.set(anchorKey, JSON.stringify(a));
}

let paySeq = 0;
const canceledIds = new Set<string>();

beforeEach(() => {
  redisStore.clear();
  canceledIds.clear();
  paySeq = 0;
  vi.clearAllMocks();
  mockFromGan.mockResolvedValue(GC);
  mockById.mockResolvedValue(GC);
  // Real Square mints a NEW payment id per auth — model that (the review's
  // must-fix was masked by a same-id mock).
  mockAuth.mockImplementation(async () => ({
    paymentId: `pay_gc_${++paySeq}`,
    sourceType: "GIFT_CARD",
    cardBrand: "",
  }));
  // Verified cancel: cancelSquarePayment marks; getSquarePayment reads it back.
  mockCancel.mockImplementation(async (paymentId: string) => {
    canceledIds.add(paymentId);
  });
  mockGetPayment.mockImplementation(async (id: string) => {
    const amountCents = id.startsWith("pay_term") ? 3_000 : 2_000;
    return {
      id,
      status: canceledIds.has(id) ? "CANCELED" : "APPROVED",
      amountCents,
      effectiveCents: amountCents,
      orderId: "ord_1",
    };
  });
  mockPayOrder.mockResolvedValue({ orderState: "COMPLETED" });
  // clearAllMocks clears CALLS, not implementations — pin the defaults so a
  // per-test mockResolvedValue never leaks into its neighbors.
  mockGetCheckout.mockResolvedValue(null);
  mockOrderInfo.mockResolvedValue(null);
});

async function applyGiftCard() {
  const lookup = await lookupGiftCardForSplit({ seed: SEED, splitToken: TOKEN, gan: GC.gan });
  if (!lookup.ok) throw new Error(`lookup failed: ${lookup.error}`);
  return addGiftCardTender({ seed: SEED, splitToken: TOKEN, lookupToken: lookup.lookupToken });
}

describe("splitToken gating (the seed is guessable — the token is the secret)", () => {
  it("rejects every entry point without the prepare-minted token", async () => {
    seedAnchor();
    const bad = await lookupGiftCardForSplit({ seed: SEED, splitToken: "wrong", gan: GC.gan });
    expect(!bad.ok && bad.error).toBe("no-session");
    const add = await addGiftCardTender({
      seed: SEED,
      splitToken: "wrong",
      lookupToken: "x".repeat(20),
    });
    expect(!add.ok && add.error).toBe("no-session");
    const cap = await captureSplit({ seed: SEED, splitToken: "wrong" });
    expect(!cap.ok && cap.error).toBe("no-session");
    const ab = await abandonSplit({ seed: SEED, splitToken: "wrong" });
    expect(!ab.ok && ab.error).toBe("no-session");
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("rejects an anchor that has no splitToken at all (pre-split prepare)", async () => {
    seedAnchor({ splitToken: undefined });
    const res = await lookupGiftCardForSplit({ seed: SEED, splitToken: TOKEN, gan: GC.gan });
    expect(!res.ok && res.error).toBe("no-session");
  });
});

describe("lookup + add gift card", () => {
  it("mints a token, authorizes min(balance, total) with the anchor attempt, persists first", async () => {
    seedAnchor();
    const res = await applyGiftCard();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tender).toEqual({ paymentId: "pay_gc_1", ganLast4: "1234", amountCents: 2_000 });
    expect(res.remainingCents).toBe(3_000);
    expect(
      (upsertSplitAttempt as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeLessThan(mockAuth.mock.invocationCallOrder[0]);
    const authArgs = mockAuth.mock.calls[0][0];
    expect(authArgs.idempotencyKey).toMatch(/^pay-gc-0123456789abcdef-0-[0-9a-f]{8}-a0$/);
    const anchor = readAnchor();
    expect(anchor.split).toBe(true);
    expect(anchor.paymentIds).toEqual(["pay_gc_1"]);
  });

  it("stacks gift cards up to MAX_GIFT_CARD_TENDERS, then rejects", async () => {
    seedAnchor();
    const first = await applyGiftCard(); // 2000 of 5000
    const second = await applyGiftCard(); // 2000 of 3000
    const third = await applyGiftCard(); // 1000 of 1000 (min(balance, remaining))
    expect(first.ok && first.remainingCents).toBe(3_000);
    expect(second.ok && second.remainingCents).toBe(1_000);
    expect(third.ok && third.remainingCents).toBe(0);
    const fourth = await applyGiftCard();
    expect(!fourth.ok && fourth.error).toBe("gc-limit");
    // Monotonic slots, each auth under its own index salt.
    expect(mockAuth.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([
      expect.stringMatching(/-0-[0-9a-f]{8}-a0$/),
      expect.stringMatching(/-1-[0-9a-f]{8}-a0$/),
      expect.stringMatching(/-2-[0-9a-f]{8}-a0$/),
    ]);
    expect(readAnchor().tenderSeq).toBe(3);
  });

  it("counts a Terminal-swiped gift card (brand SQUARE_GIFT_CARD) toward the GC cap", async () => {
    seedAnchor();
    await applyGiftCard();
    await applyGiftCard();
    stampTap("pay_term_gc", { sourceType: "CARD", cardBrand: "SQUARE_GIFT_CARD" });
    const fourth = await applyGiftCard();
    expect(!fourth.ok && fourth.error).toBe("gc-limit");
  });

  it("rejects any tender past MAX_TOTAL_TENDERS", async () => {
    seedAnchor({ depositCents: 50_000 });
    await applyGiftCard();
    await applyGiftCard(); // 2 gift cards — under the GC cap
    stampTap("pay_term_1");
    stampTap("pay_term_2");
    stampTap("pay_term_3"); // 5 authorized tenders total
    const sixth = await applyGiftCard();
    expect(!sixth.ok && sixth.error).toBe("tender-limit");
  });

  it("append-only: an add never drops a prior authorized tender", async () => {
    seedAnchor();
    await applyGiftCard();
    stampTap("pay_term_1");
    await applyGiftCard();
    const anchor = readAnchor();
    expect(anchor.tenders).toHaveLength(3);
    expect(
      anchor.tenders.filter((t: { status: string }) => t.status === "authorized"),
    ).toHaveLength(3);
    expect(anchor.tenders.find((t: { kind: string }) => t.kind === "terminal").paymentId).toBe(
      "pay_term_1",
    );
  });

  it("consumes the lookup token (replay fails)", async () => {
    seedAnchor();
    const lookup = await lookupGiftCardForSplit({ seed: SEED, splitToken: TOKEN, gan: GC.gan });
    if (!lookup.ok) throw new Error("lookup failed");
    await addGiftCardTender({ seed: SEED, splitToken: TOKEN, lookupToken: lookup.lookupToken });
    await removeGiftCardTender({ seed: SEED, splitToken: TOKEN });
    const replay = await addGiftCardTender({
      seed: SEED,
      splitToken: TOKEN,
      lookupToken: lookup.lookupToken,
    });
    expect(!replay.ok && replay.error).toBe("token-invalid");
  });

  it("voids the auth, bumps the ledger attempt, and flags review when the anchor vanishes mid-add", async () => {
    seedAnchor();
    const lookup = await lookupGiftCardForSplit({ seed: SEED, splitToken: TOKEN, gan: GC.gan });
    if (!lookup.ok) throw new Error("lookup failed");
    mockAuth.mockImplementationOnce(async () => {
      redisStore.delete(anchorKey);
      return { paymentId: "pay_orphan", sourceType: "GIFT_CARD", cardBrand: "" };
    });
    const res = await addGiftCardTender({
      seed: SEED,
      splitToken: TOKEN,
      lookupToken: lookup.lookupToken,
    });
    expect(!res.ok && res.error).toBe("no-session");
    expect(mockCancel).toHaveBeenCalledWith(
      "pay_orphan",
      baseAnchor.baseKey,
      "gc",
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^cxl-/) }),
    );
    // Ledger attempt burned even though the anchor was unreachable.
    const ledgerCalls = (setSplitTenders as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(ledgerCalls[ledgerCalls.length - 1][2]).toBe(1);
  });
});

describe("remove / re-add / capture — the review's must-fix path", () => {
  it("prunes canceled ids so a re-added gift card captures cleanly", async () => {
    seedAnchor();
    await applyGiftCard(); // pay_gc_1
    await removeGiftCardTender({ seed: SEED, splitToken: TOKEN }); // voids pay_gc_1, attempt→1
    const readd = await applyGiftCard(); // pay_gc_2 under -a1
    expect(readd.ok).toBe(true);
    expect(mockAuth.mock.calls[1][0].idempotencyKey).toMatch(/-a1$/);

    const anchor = readAnchor();
    // The canceled id is PRUNED from the union — capture must never see it.
    expect(anchor.paymentIds).toEqual(["pay_gc_2"]);

    stampTap("pay_term_1");
    const res = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.paymentIds).toEqual(["pay_gc_2", "pay_term_1"]);
    // The dead pay_gc_1 was never consulted or captured.
    expect(mockPayOrder.mock.calls[0][0].paymentIds).not.toContain("pay_gc_1");
  });

  it("records cancel-failed + needs_review when the void doesn't stick", async () => {
    seedAnchor();
    await applyGiftCard();
    // The cancel call "succeeds" but Square still reports APPROVED.
    mockCancel.mockImplementationOnce(async () => {});
    const res = await removeGiftCardTender({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(true);
    const anchor = readAnchor();
    expect(anchor.tenders[0].status).toBe("cancel-failed");
    // NOT pruned — the payment is still live out there.
    expect(anchor.paymentIds).toContain("pay_gc_1");
    expect(setSplitState).toHaveBeenCalledWith(baseAnchor.baseKey, "needs_review");
  });
});

describe("per-tender remove (multi-tender board's Remove button)", () => {
  it("voids ONLY the named gift card — other holds survive, attempt bumps", async () => {
    seedAnchor();
    await applyGiftCard(); // pay_gc_1
    await applyGiftCard(); // pay_gc_2
    stampTap("pay_term_1");
    const res = await removeGiftCardTender({
      seed: SEED,
      splitToken: TOKEN,
      paymentId: "pay_gc_1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 5000 total − pay_gc_2's 2000 (terminal amounts don't count in PR-1 math)
    expect(res.remainingCents).toBe(3_000);
    expect(mockCancel.mock.calls.map((c) => c[0])).toEqual(["pay_gc_1"]);
    const anchor = readAnchor();
    expect(
      anchor.tenders.find((t: { paymentId: string }) => t.paymentId === "pay_gc_1").status,
    ).toBe("canceled");
    expect(
      anchor.tenders.find((t: { paymentId: string }) => t.paymentId === "pay_gc_2").status,
    ).toBe("authorized");
    expect(
      anchor.tenders.find((t: { paymentId: string }) => t.paymentId === "pay_term_1").status,
    ).toBe("authorized");
    expect(anchor.paymentIds).toEqual(["pay_gc_2", "pay_term_1"]);
    expect(anchor.attempt).toBe(1);
  });

  it("dismisses the armed checkout first (its amount is stale once the remainder moves)", async () => {
    seedAnchor();
    await applyGiftCard();
    const a = readAnchor();
    a.pendingCheckout = { id: "chk_armed", attempt: 0, termArm: 1 };
    redisStore.set(anchorKey, JSON.stringify(a));
    await removeGiftCardTender({ seed: SEED, splitToken: TOKEN, paymentId: "pay_gc_1" });
    expect(mockDismiss).toHaveBeenCalledWith("chk_armed");
    expect(readAnchor().pendingCheckout).toBeUndefined();
  });

  it("refuses to remove a terminal tender or an unknown payment", async () => {
    seedAnchor();
    await applyGiftCard();
    stampTap("pay_term_1");
    const term = await removeGiftCardTender({
      seed: SEED,
      splitToken: TOKEN,
      paymentId: "pay_term_1",
    });
    expect(!term.ok && term.error).toBe("tender-not-found");
    const unknown = await removeGiftCardTender({
      seed: SEED,
      splitToken: TOKEN,
      paymentId: "pay_nope",
    });
    expect(!unknown.ok && unknown.error).toBe("tender-not-found");
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("records cancel-failed + needs_review and keeps the id in the union when the void doesn't stick", async () => {
    seedAnchor();
    await applyGiftCard();
    mockCancel.mockImplementationOnce(async () => {}); // Square still reports APPROVED
    const res = await removeGiftCardTender({
      seed: SEED,
      splitToken: TOKEN,
      paymentId: "pay_gc_1",
    });
    expect(!res.ok && res.error).toBe("square-error");
    const anchor = readAnchor();
    expect(anchor.tenders[0].status).toBe("cancel-failed");
    expect(anchor.paymentIds).toContain("pay_gc_1");
    expect(setSplitState).toHaveBeenCalledWith(baseAnchor.baseKey, "needs_review");
  });
});

describe("abandon — releases the reader side too", () => {
  it("dismisses the pending checkout and voids terminal auths", async () => {
    seedAnchor();
    await applyGiftCard();
    // Reader armed + a tap landed.
    let a = readAnchor();
    a.pendingCheckoutId = "chk_1";
    redisStore.set(anchorKey, JSON.stringify(a));
    stampTap("pay_term_1");
    a = readAnchor();
    a.pendingCheckoutId = "chk_1"; // stamp cleared it; restore to prove dismiss runs
    redisStore.set(anchorKey, JSON.stringify(a));

    const res = await abandonSplit({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(true);
    expect(mockDismiss).toHaveBeenCalledWith("chk_1");
    // BOTH the gift card and the tap auth were voided.
    const canceled = mockCancel.mock.calls.map((c) => c[0]);
    expect(canceled).toContain("pay_gc_1");
    expect(canceled).toContain("pay_term_1");
    expect(setSplitState).toHaveBeenCalledWith(baseAnchor.baseKey, "canceled");
    expect(readAnchor().paymentIds).toEqual([]);
  });
});

describe("capture", () => {
  it("derives the set from POSITIVE tender entries, verifies tap amount from Square, salted PayOrder", async () => {
    seedAnchor();
    await applyGiftCard();
    stampTap("pay_term_1");
    const res = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.paymentIds).toEqual(["pay_gc_1", "pay_term_1"]);
    expect(res.primaryPaymentId).toBe("pay_term_1");
    const poArgs = mockPayOrder.mock.calls[0][0];
    expect(poArgs.idempotencyKey).toMatch(/^payord2-/);
    expect(readAnchor().capturedAt).toBeTruthy();
    // Ledger got the verified tap amount before capture.
    const ledgerCalls = (setSplitTenders as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastTenders = ledgerCalls[ledgerCalls.length - 1][1];
    expect(lastTenders.find((t: { kind: string }) => t.kind === "terminal").amountCents).toBe(
      3_000,
    );
  });

  it("refuses when the tenders underpay the total", async () => {
    seedAnchor();
    await applyGiftCard(); // 2000 of 5000, no tap
    const res = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(!res.ok && res.error).toBe("sum-mismatch");
    expect(mockPayOrder).not.toHaveBeenCalled();
  });

  it("captures a GC-covers-all checkout and replays idempotently", async () => {
    seedAnchor({ depositCents: 1_500 });
    mockById.mockResolvedValue({ ...GC, balanceCents: 2_000 });
    await applyGiftCard();
    const first = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(first.ok && first.paymentIds).toEqual(["pay_gc_1"]);
    mockPayOrder.mockClear();
    const replay = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(replay.ok && replay.alreadyCaptured).toBe(true);
    expect(mockPayOrder).not.toHaveBeenCalled();
  });

  it("does NOT mark captured when PayOrder reports a non-COMPLETED order", async () => {
    seedAnchor({ depositCents: 1_500 });
    await applyGiftCard();
    mockPayOrder.mockResolvedValue({ orderState: "OPEN" });
    const res = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(false);
    expect(readAnchor().capturedAt).toBeUndefined();
    expect(setSplitState).not.toHaveBeenCalledWith(baseAnchor.baseKey, "captured");
  });
});

describe("ambient rail — capture math + races (2026-08)", () => {
  it("sums terminal tenders at EFFECTIVE (approved) cents, not the requested amount", async () => {
    seedAnchor();
    await applyGiftCard(); // 2000 of 5000
    stampTap("pay_term_partial");
    // A partial approval: Square kept amount_money at the requested 3000 but
    // approved only 1200 — capture must see 2000+1200, never 2000+3000.
    mockGetPayment.mockImplementation(async (id: string) => ({
      id,
      status: canceledIds.has(id) ? "CANCELED" : "APPROVED",
      amountCents: id === "pay_term_partial" ? 3_000 : 2_000,
      approvedCents: id === "pay_term_partial" ? 1_200 : undefined,
      effectiveCents: id === "pay_term_partial" ? 1_200 : 2_000,
      orderId: "ord_1",
    }));
    const res = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(!res.ok && res.error).toBe("sum-mismatch");
    expect(!res.ok && "detail" in res && res.detail).toContain("3200");
    expect(mockPayOrder).not.toHaveBeenCalled();
  });

  it("over-collection voids the NEWEST tap, recomputes, and captures the corrected set", async () => {
    seedAnchor();
    await applyGiftCard(); // 2000
    stampTap("pay_term_1"); // verified 3000 → exactly covers
    stampTap("pay_term_2"); // a second 3000 tap raced in → over-collected
    const res = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The newest (higher index) tap was voided; the set that captured is exact.
    expect(mockCancel.mock.calls.map((c) => c[0])).toContain("pay_term_2");
    expect(res.paymentIds).toEqual(["pay_gc_1", "pay_term_1"]);
    expect(mockPayOrder.mock.calls[0][0].paymentIds).toEqual(["pay_gc_1", "pay_term_1"]);
    const anchor = readAnchor();
    expect(
      anchor.tenders.find((t: { paymentId: string }) => t.paymentId === "pay_term_2").status,
    ).toBe("canceled");
  });

  it("tolerates PayOrder failing against an ALREADY-COMPLETED order whose tenders cover ours", async () => {
    seedAnchor({ depositCents: 2_000 });
    await applyGiftCard(); // 2000 — covers all
    mockPayOrder.mockRejectedValue(new Error("order must be OPEN, instead COMPLETED"));
    mockOrderInfo.mockResolvedValue({
      state: "COMPLETED",
      paymentId: "pay_gc_1",
      paymentIds: ["pay_gc_1"],
    });
    const res = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(true);
    expect(readAnchor().capturedAt).toBeTruthy();
  });

  it("does NOT tolerate a completed order that lacks our payments", async () => {
    seedAnchor({ depositCents: 2_000 });
    await applyGiftCard();
    mockPayOrder.mockRejectedValue(new Error("boom"));
    mockOrderInfo.mockResolvedValue({
      state: "COMPLETED",
      paymentId: "pay_other",
      paymentIds: ["pay_other"],
    });
    const res = await captureSplit({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(false);
    expect(readAnchor().capturedAt).toBeUndefined();
  });

  it("add harvests a tap that raced onto the armed checkout BEFORE sizing the gift card", async () => {
    seedAnchor({ pendingCheckoutId: "chk_x" });
    mockGetCheckout.mockResolvedValue({
      checkoutId: "chk_x",
      status: "COMPLETED",
      paymentIds: ["pay_term_raced"],
    });
    const res = await applyGiftCard();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The 3000¢ harvested tap shrank the remainder: min(2000, 5000−3000) = 2000 → 0 left.
    expect(res.tender.amountCents).toBe(2_000);
    expect(res.remainingCents).toBe(0);
    expect(mockDismiss).toHaveBeenCalledWith("chk_x");
    const anchor = readAnchor();
    const harvested = anchor.tenders.find(
      (t: { paymentId: string }) => t.paymentId === "pay_term_raced",
    );
    expect(harvested).toMatchObject({ kind: "terminal", amountCents: 3_000, status: "authorized" });
  });

  it("abandon voids an UNPOLLED tap sitting on the armed checkout (the 36h-strand fix)", async () => {
    seedAnchor({ pendingCheckoutId: "chk_lost" });
    mockGetCheckout.mockResolvedValue({
      checkoutId: "chk_lost",
      status: "COMPLETED",
      paymentIds: ["pay_term_lost"],
    });
    const res = await abandonSplit({ seed: SEED, splitToken: TOKEN });
    expect(res.ok).toBe(true);
    expect(mockCancel.mock.calls.map((c) => c[0])).toContain("pay_term_lost");
  });

  it("stampVerifiedTerminalTender dedups a double-poll and refreshes verified fields", async () => {
    seedAnchor();
    await stampVerifiedTerminalTender(SEED, {
      paymentId: "pay_t",
      amountCents: 1_000,
      sourceType: "CARD",
      cardBrand: "SQUARE_GIFT_CARD",
      last4: "9876",
      checkoutId: "chk_1",
    });
    const again = await stampVerifiedTerminalTender(SEED, {
      paymentId: "pay_t",
      amountCents: 1_100, // Square settled on a corrected figure
      checkoutId: "chk_1",
    });
    expect(again?.tenders).toHaveLength(1);
    expect(again?.tenders?.[0]).toMatchObject({ paymentId: "pay_t", amountCents: 1_100 });
    expect(again?.paymentIds).toEqual(["pay_t"]);
    expect(again?.tenderSeq).toBe(1);
  });
});

describe("splitRemainingCents", () => {
  it("counts EVERY authorized tender at verified amounts (ambient partials) and includes Game Zone lines", () => {
    const anchor = {
      ...baseAnchor,
      gameCards: { totalCents: 1_000 },
      tenders: [
        { index: 0, kind: "gift_card", amountCents: 2_000, status: "canceled" },
        { index: 1, kind: "gift_card", amountCents: 1_500, status: "authorized" },
        { index: 2, kind: "terminal", amountCents: 999, status: "authorized" },
      ],
    } as never;
    expect(splitRemainingCents(anchor)).toBe(3_501); // 6000 − 1500 − 999
  });

  it("treats a legacy zero-amount terminal stamp as not-counted (old behavior)", () => {
    const anchor = {
      ...baseAnchor,
      tenders: [
        { index: 0, kind: "gift_card", amountCents: 1_500, status: "authorized" },
        { index: 1, kind: "terminal", amountCents: 0, status: "authorized" },
      ],
    } as never;
    expect(splitRemainingCents(anchor)).toBe(3_500); // 5000 − 1500 − 0
  });

  it("prefers the writer-stamped explicit totalCents over the legacy derivation", () => {
    const anchor = {
      ...baseAnchor,
      totalCents: 7_500,
      gameCards: { totalCents: 1_000 },
      tenders: [{ index: 0, kind: "gift_card", amountCents: 1_500, status: "authorized" }],
    } as never;
    expect(splitRemainingCents(anchor)).toBe(6_000); // 7500 − 1500
  });
});

describe("upsertTerminalAnchor (the shared merge-writer)", () => {
  it("creates a fresh anchor with attempt 0 / tenderSeq 0 and returns it", async () => {
    const written = await upsertTerminalAnchor(SEED, {
      depositOrderId: "ord_9",
      depositCents: 4_000,
      locationId: "LOC",
      baseKey: "bk9",
      splitToken: "tok-new",
      totalCents: 4_500,
      source: "unified",
    });
    expect(written).toMatchObject({
      depositOrderId: "ord_9",
      splitToken: "tok-new",
      totalCents: 4_500,
      attempt: 0,
      tenderSeq: 0,
      source: "unified",
    });
    expect(readAnchor()).toMatchObject({ splitToken: "tok-new" });
  });

  it("merges over a prior anchor: tender bookkeeping and the ORIGINAL splitToken survive a re-prepare", async () => {
    seedAnchor({
      tenders: [
        { index: 0, kind: "gift_card", paymentId: "p1", amountCents: 500, status: "authorized" },
      ],
      paymentIds: ["p1"],
      attempt: 2,
      tenderSeq: 1,
      capturedAt: undefined,
    });
    const written = await upsertTerminalAnchor(SEED, {
      depositOrderId: "ord_2",
      depositCents: 9_000,
      locationId: "LOC2",
      baseKey: baseAnchor.baseKey,
      splitToken: "tok-second-prepare",
      totalCents: 9_000,
      source: "bowling",
    });
    expect(written).toMatchObject({
      depositOrderId: "ord_2", // descriptive fields updated
      splitToken: TOKEN, // the session's existing trust root wins
      attempt: 2,
      tenderSeq: 1,
    });
    expect(written?.tenders).toHaveLength(1);
    expect(written?.paymentIds).toEqual(["p1"]);
  });

  it("returns null when Redis is down (callers fail closed on the token)", async () => {
    (redis.get as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("redis down");
    });
    const written = await upsertTerminalAnchor(SEED, {
      depositOrderId: "ord_9",
      depositCents: 4_000,
      locationId: "LOC",
      baseKey: "bk9",
      splitToken: "tok",
      totalCents: 4_000,
      source: "gamezone",
    });
    expect(written).toBeNull();
  });
});
