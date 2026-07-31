/**
 * Kiosk split-tender service (v1: one gift card + one tap) — mocked Redis /
 * Neon / Square-module, exercising the money-ordering rules from the
 * 2026-07-29 adversarial review: persist-first, splitToken gating, verified
 * cancels, paymentIds pruning (remove→re-add→capture must WORK), positive
 * terminal-tender identification, attempt bump on every unwind, idempotent
 * capture replay, honest ledger on anchor loss.
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
  getSplitAttempt: vi.fn(async () => null),
}));

vi.mock("~/features/booking/service/deposit", () => ({
  getSquarePayment: vi.fn(),
}));

vi.mock("./square-terminal", () => ({
  dismissTerminalCheckout: vi.fn(async () => true),
}));

import {
  cancelSquarePayment,
  createTenderAuth,
  getGiftCardFromGan,
  payOrder,
  retrieveGiftCardById,
} from "@/lib/square-gift-card";
import { getSquarePayment } from "~/features/booking/service/deposit";
import { setSplitState, setSplitTenders, upsertSplitAttempt } from "../data/split-tenders-db";
import { dismissTerminalCheckout } from "./square-terminal";
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
function stampTap(paymentId: string) {
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
  mockGetPayment.mockImplementation(async (id: string) => ({
    id,
    status: canceledIds.has(id) ? "CANCELED" : "APPROVED",
    amountCents: id.startsWith("pay_term") ? 3_000 : 2_000,
    orderId: "ord_1",
  }));
  mockPayOrder.mockResolvedValue({ orderState: "COMPLETED" });
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
    expect(res.tender).toEqual({ ganLast4: "1234", amountCents: 2_000 });
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

  it("rejects a second gift card in v1", async () => {
    seedAnchor();
    await applyGiftCard();
    const again = await applyGiftCard();
    expect(!again.ok && again.error).toBe("gc-limit");
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

describe("splitRemainingCents", () => {
  it("counts only AUTHORIZED gift-card tenders and includes Game Zone lines", () => {
    const anchor = {
      ...baseAnchor,
      gameCards: { totalCents: 1_000 },
      tenders: [
        { index: 0, kind: "gift_card", amountCents: 2_000, status: "canceled" },
        { index: 1, kind: "gift_card", amountCents: 1_500, status: "authorized" },
        { index: 2, kind: "terminal", amountCents: 999, status: "authorized" },
      ],
    } as never;
    expect(splitRemainingCents(anchor)).toBe(4_500); // 6000 − 1500 (GC only)
  });
});
