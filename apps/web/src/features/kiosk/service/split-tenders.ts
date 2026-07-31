/**
 * Kiosk split-tender service (v1 — "match web": ONE gift card + ONE reader
 * tap; owner 2026-07-29). Server-side only.
 *
 * Sequence:
 *   1. Client scans/swipes/types a GAN → lookupGiftCardForSplit → single-use
 *      lookupToken (the raw GAN / gftc: id never round-trips to the client).
 *   2. addGiftCardTender: persist-first (Neon ledger row) → authorize the gift
 *      card against the PREPARED deposit order (autocomplete:false, exact
 *      amount = min(balance, remaining)) → stamp anchor + ledger.
 *   3. The reader tap for the remainder rides the terminal-checkout route's
 *      split fork (auth-only; the tap lands on the anchor as a POSITIVE
 *      kind:"terminal" tender via the poll's stamp).
 *   4. captureSplit: verify every tender APPROVED + sum === total → PayOrder
 *      (atomic; order state authoritative — probe #1) → reserve-all finalizes
 *      with paymentIds[].
 *
 * Trust model (review 2026-07-29): the seed is a sequential, client-visible
 * bill id — NOT a secret. Every mutating call requires the per-session
 * splitToken minted at PREPARE (TerminalAnchor.splitToken). Money amounts are
 * always server-derived (anchor + Square), never the client's claim.
 *
 * Unwind honesty (review 2026-07-29): cancels are VERIFIED (Square re-read) —
 * a failed void is recorded as `cancel-failed` + ledger `needs_review`, never
 * silently marked canceled. Canceled payment ids are PRUNED from the anchor
 * union, and the attempt salt bumps so re-adds never replay a burned key.
 * Post-capture there is NO rollback — forward recovery, as everywhere else.
 */
import { randomUUID } from "crypto";
import redis from "@/lib/redis";
import {
  cancelSquarePayment,
  createTenderAuth,
  isInternalDepositGan,
  getGiftCardFromGan,
  payOrder,
  retrieveGiftCardById,
  SquarePaymentError,
} from "@/lib/square-gift-card";
import { cancelKey, gcAuthKey, payOrderKey } from "~/features/booking/service/tenders";
import { getSquarePayment } from "~/features/booking/service/deposit";
import {
  readTerminalAnchor,
  updateTerminalAnchor,
  type TerminalAnchor,
  type TerminalAnchorTender,
} from "~/features/booking/service/unified-reserve";
import { dismissTerminalCheckout } from "./square-terminal";
import {
  setSplitState,
  setSplitTenders,
  upsertSplitAttempt,
  type SplitTenderEntry,
} from "../data/split-tenders-db";

const LOOKUP_TOKEN_TTL_S = 15 * 60;
const lookupTokenKey = (token: string) => `kiosk:gclookup:${token}`;
const addLockKey = (seed: string) => `kiosk:split:lock:${seed}`;
/** v1 cap — lift with the multi-tender UI PRs (MAX_GIFT_CARD_TENDERS). */
const MAX_GIFT_CARDS_V1 = 1;

export type SplitError =
  | "not-enabled"
  | "no-session"
  | "bad-token" // splitToken missing/mismatched — treat exactly like no-session outward
  | "already-captured"
  | "busy"
  | "card-unusable" // internal / inactive / not found — deliberately vague outward
  | "zero-balance"
  | "gc-limit"
  | "token-invalid"
  | "nothing-to-capture"
  | "sum-mismatch"
  | "square-error";

export interface SplitStatus {
  totalCents: number;
  remainingCents: number;
  tenders: Array<{ kind: "gift_card"; ganLast4?: string; amountCents: number }>;
  capturedAt?: string;
}

/** The checkout's full charge: booking deposit + any Game Zone card lines. */
function anchorTotalCents(anchor: TerminalAnchor): number {
  return anchor.depositCents + (anchor.gameCards?.totalCents ?? 0);
}

function authorizedTenders(
  anchor: TerminalAnchor,
  kind?: TerminalAnchorTender["kind"],
): TerminalAnchorTender[] {
  return (anchor.tenders ?? []).filter(
    (t) => t.status === "authorized" && (kind ? t.kind === kind : true),
  );
}

/** Cents still owed after the authorized gift-card tender(s). */
export function splitRemainingCents(anchor: TerminalAnchor): number {
  const gc = authorizedTenders(anchor, "gift_card").reduce((s, t) => s + t.amountCents, 0);
  return Math.max(0, anchorTotalCents(anchor) - gc);
}

/** Session gate shared by every mutating entry point: anchor must exist AND
 *  the caller must present the prepare-minted splitToken (the seed alone is
 *  guessable). Both failures read identically outward. */
async function loadAuthorizedAnchor(
  seed: string,
  splitToken: string | undefined,
): Promise<{ anchor: TerminalAnchor } | { error: SplitError }> {
  const anchor = await readTerminalAnchor(seed);
  if (!anchor) return { error: "no-session" };
  if (!anchor.splitToken || !splitToken || anchor.splitToken !== splitToken) {
    return { error: "no-session" };
  }
  return { anchor };
}

// ── 1. GAN lookup → single-use token ────────────────────────────────────────

export async function lookupGiftCardForSplit(params: {
  seed: string;
  splitToken: string;
  gan: string;
}): Promise<
  | { ok: true; lookupToken: string; balanceCents: number; last4: string }
  | { ok: false; error: SplitError }
> {
  const gate = await loadAuthorizedAnchor(params.seed, params.splitToken);
  if ("error" in gate) return { ok: false, error: gate.error };
  if (gate.anchor.capturedAt) return { ok: false, error: "already-captured" };

  const gan = params.gan.replace(/[^A-Za-z0-9]/g, "");
  if (gan.length < 8 || gan.length > 20) return { ok: false, error: "card-unusable" };
  // Local prefix block BEFORE any Square call — internal deposit cards are
  // never a tender, and the error is deliberately generic (no oracle).
  if (isInternalDepositGan(gan)) return { ok: false, error: "card-unusable" };

  const info = await getGiftCardFromGan(gan);
  if (!info) return { ok: false, error: "card-unusable" };
  // Re-check on the RESOLVED gan too (defense in depth), plus state/balance.
  if (isInternalDepositGan(info.gan) || info.state !== "ACTIVE") {
    return { ok: false, error: "card-unusable" };
  }
  if ((info.balanceCents ?? 0) <= 0) return { ok: false, error: "zero-balance" };

  const lookupToken = randomUUID();
  try {
    await redis.set(
      lookupTokenKey(lookupToken),
      JSON.stringify({ giftCardId: info.id, gan: info.gan, seed: params.seed }),
      "EX",
      LOOKUP_TOKEN_TTL_S,
    );
  } catch {
    return { ok: false, error: "square-error" }; // can't mint a token — fail closed
  }
  return {
    ok: true,
    lookupToken,
    balanceCents: info.balanceCents,
    last4: info.gan.slice(-4),
  };
}

// ── 2. Apply (authorize) the gift card ──────────────────────────────────────

export async function addGiftCardTender(params: {
  seed: string;
  splitToken: string;
  lookupToken: string;
}): Promise<
  | {
      ok: true;
      tender: { ganLast4: string; amountCents: number };
      remainingCents: number;
    }
  | { ok: false; error: SplitError; detail?: string }
> {
  // Cheap mutex — two concurrent adds on one session must not double-auth
  // (the v1 single-GC guard below is read-then-write on Redis).
  let locked = false;
  try {
    locked = (await redis.set(addLockKey(params.seed), "1", "EX", 15, "NX")) === "OK";
  } catch {
    locked = true; // Redis down → loadAuthorizedAnchor will fail closed anyway
  }
  if (!locked) return { ok: false, error: "busy" };
  try {
    return await addGiftCardTenderLocked(params);
  } finally {
    try {
      await redis.del(addLockKey(params.seed));
    } catch {
      /* lock expires on its own */
    }
  }
}

async function addGiftCardTenderLocked(params: {
  seed: string;
  splitToken: string;
  lookupToken: string;
}): Promise<
  | { ok: true; tender: { ganLast4: string; amountCents: number }; remainingCents: number }
  | { ok: false; error: SplitError; detail?: string }
> {
  const gate = await loadAuthorizedAnchor(params.seed, params.splitToken);
  if ("error" in gate) return { ok: false, error: gate.error };
  const anchor = gate.anchor;
  if (anchor.capturedAt) return { ok: false, error: "already-captured" };
  if (authorizedTenders(anchor, "gift_card").length >= MAX_GIFT_CARDS_V1) {
    return { ok: false, error: "gc-limit" };
  }

  // Consume the token — read then delete (GETDEL needs Redis ≥6.2; the token
  // is seed-bound and the add-lock serializes callers).
  let tokenRaw: string | null = null;
  try {
    tokenRaw = (await redis.get(lookupTokenKey(params.lookupToken))) as string | null;
    if (tokenRaw) await redis.del(lookupTokenKey(params.lookupToken));
  } catch {
    return { ok: false, error: "token-invalid" };
  }
  if (!tokenRaw) return { ok: false, error: "token-invalid" };
  let token: { giftCardId: string; gan: string; seed: string };
  try {
    token = JSON.parse(tokenRaw) as typeof token;
  } catch {
    return { ok: false, error: "token-invalid" };
  }
  if (token.seed !== params.seed) return { ok: false, error: "token-invalid" };

  // Re-resolve at auth time (balance may have moved since lookup).
  const info = await retrieveGiftCardById(token.giftCardId);
  if (!info || info.blocked || info.state !== "ACTIVE") {
    return { ok: false, error: "card-unusable" };
  }
  if (info.balanceCents <= 0) return { ok: false, error: "zero-balance" };

  const total = anchorTotalCents(anchor);
  const amountCents = Math.min(info.balanceCents, splitRemainingCents(anchor));
  if (amountCents <= 0) return { ok: false, error: "sum-mismatch" };
  const attempt = anchor.attempt ?? 0;

  // PERSIST-FIRST: the ledger row exists before any Square auth, so a crash
  // between auth and stamp still leaves a findable record for the sweep.
  await upsertSplitAttempt({
    seed: params.seed,
    baseKey: anchor.baseKey,
    depositOrderId: anchor.depositOrderId,
    locationId: anchor.locationId,
    totalCents: total,
  });

  let auth: Awaited<ReturnType<typeof createTenderAuth>>;
  try {
    auth = await createTenderAuth({
      orderId: anchor.depositOrderId,
      locationId: anchor.locationId,
      sourceId: info.id, // gftc: id as source — probe #2's shape
      amountCents,
      idempotencyKey: gcAuthKey(anchor.baseKey, 0, info.id, attempt),
      errCode: "GIFT_CARD_AUTH_FAILED",
      note: "Kiosk split tender — gift card",
    });
  } catch (err) {
    if (err instanceof SquarePaymentError) {
      return { ok: false, error: "square-error", detail: err.message };
    }
    throw err;
  }

  const tender: TerminalAnchorTender = {
    index: 0,
    kind: "gift_card",
    paymentId: auth.paymentId,
    amountCents,
    ganLast4: info.gan.slice(-4),
    status: "authorized",
  };
  // Keep the historical record: canceled tenders stay in the array; the new
  // one replaces any prior AUTHORIZED gc slot (there is none — v1 guard).
  const nextTenders = [...(anchor.tenders ?? []).filter((t) => t.status !== "authorized"), tender];
  // Ledger first (durable), anchor second (fast pointer).
  await setSplitTenders(anchor.baseKey, nextTenders as SplitTenderEntry[], attempt);
  const updated = await updateTerminalAnchor(params.seed, (a) => ({
    ...a,
    split: true as const,
    tenders: nextTenders,
    paymentIds: [...new Set([...(a.paymentIds ?? []), auth.paymentId])],
  }));
  if (!updated) {
    // Anchor write failed (Redis blip / TTL). The auth is live but unanchored —
    // void it now (verified), record honestly, and burn the attempt in the
    // LEDGER too so a later retry (if the anchor still exists) never replays
    // this key. Best-effort on the anchor as well.
    const outcome = await verifiedCancel(anchor.baseKey, auth.paymentId);
    await setSplitTenders(
      anchor.baseKey,
      [{ ...tender, status: outcome } as SplitTenderEntry],
      attempt + 1,
    );
    await setSplitState(anchor.baseKey, outcome === "canceled" ? "canceled" : "needs_review");
    await updateTerminalAnchor(params.seed, (a) => ({
      ...a,
      attempt: Math.max((a.attempt ?? 0) + 1, attempt + 1),
    }));
    return { ok: false, error: "no-session" };
  }

  return {
    ok: true,
    tender: { ganLast4: tender.ganLast4 as string, amountCents },
    remainingCents: splitRemainingCents(updated),
  };
}

// ── 3. Remove / abandon (verified unwind + attempt bump) ────────────────────

/** Void an auth and VERIFY the outcome — cancelSquarePayment swallows errors,
 *  and a failed void must never be recorded as a successful one. */
async function verifiedCancel(
  baseKey: string,
  paymentId: string,
): Promise<"canceled" | "cancel-failed"> {
  await cancelSquarePayment(paymentId, baseKey, "gc", {
    idempotencyKey: cancelKey(baseKey, paymentId),
  });
  const after = await getSquarePayment(paymentId);
  // CANCELED = voided; FAILED = never usable; unknown (null) = can't confirm.
  if (after && (after.status === "CANCELED" || after.status === "FAILED")) return "canceled";
  return "cancel-failed";
}

async function unwindTenders(
  seed: string,
  anchor: TerminalAnchor,
): Promise<{ allReleased: boolean }> {
  // 1. Dismiss any armed reader checkout FIRST — a tap must not land while
  //    (or after) we void the software auths.
  if (anchor.pendingCheckoutId) {
    try {
      await dismissTerminalCheckout(anchor.pendingCheckoutId);
    } catch {
      /* checkout may already be done/expired — the payment loop below covers it */
    }
  }
  // 2. Void every authorized tender (gift card AND any terminal tap that
  //    already landed — both are auth-only until capture) with verification.
  const results = new Map<string, "canceled" | "cancel-failed">();
  for (const t of authorizedTenders(anchor)) {
    if (!t.paymentId) continue;
    results.set(t.paymentId, await verifiedCancel(anchor.baseKey, t.paymentId));
  }
  const allReleased = [...results.values()].every((r) => r === "canceled");

  // 3. Record honestly: canceled ids are PRUNED from the union (capture must
  //    never see them again); failed voids stay visible as cancel-failed.
  const canceledIds = [...results.entries()].filter(([, r]) => r === "canceled").map(([id]) => id);
  const next = await updateTerminalAnchor(seed, (a) => ({
    ...a,
    tenders: (a.tenders ?? []).map((t) =>
      t.paymentId && results.has(t.paymentId)
        ? { ...t, status: results.get(t.paymentId) as TerminalAnchorTender["status"] }
        : t,
    ),
    paymentIds: (a.paymentIds ?? []).filter((id) => !canceledIds.includes(id)),
    pendingCheckoutId: undefined,
    // Fresh keys for everything that comes after this unwind.
    attempt: (a.attempt ?? 0) + 1,
  }));
  if (next) {
    await setSplitTenders(anchor.baseKey, (next.tenders ?? []) as SplitTenderEntry[], next.attempt);
  } else {
    // Anchor gone — DO NOT wipe the ledger (it is the only durable record);
    // flag for review instead.
    await setSplitState(anchor.baseKey, "needs_review");
  }
  if (!allReleased) await setSplitState(anchor.baseKey, "needs_review");
  return { allReleased };
}

export async function removeGiftCardTender(params: {
  seed: string;
  splitToken: string;
}): Promise<{ ok: true; remainingCents: number } | { ok: false; error: SplitError }> {
  const gate = await loadAuthorizedAnchor(params.seed, params.splitToken);
  if ("error" in gate) return { ok: false, error: gate.error };
  if (gate.anchor.capturedAt) return { ok: false, error: "already-captured" };
  await unwindTenders(params.seed, gate.anchor);
  const after = await readTerminalAnchor(params.seed);
  return {
    ok: true,
    remainingCents: after ? splitRemainingCents(after) : anchorTotalCents(gate.anchor),
  };
}

/** Idle-reset / cancel-everything hook: void every un-captured auth NOW
 *  (Square's ~36h auto-void is the backstop, not the mechanism). */
export async function abandonSplit(params: {
  seed: string;
  splitToken: string;
}): Promise<{ ok: true } | { ok: false; error: SplitError }> {
  const anchor = await readTerminalAnchor(params.seed);
  if (!anchor) return { ok: true }; // nothing to release
  if (!anchor.splitToken || anchor.splitToken !== params.splitToken) {
    return { ok: false, error: "no-session" };
  }
  if (anchor.capturedAt) return { ok: false, error: "already-captured" };
  const { allReleased } = await unwindTenders(params.seed, anchor);
  if (allReleased) await setSplitState(anchor.baseKey, "canceled");
  return { ok: true };
}

// ── 4. Capture (atomic PayOrder over the whole set) ─────────────────────────

export async function captureSplit(params: {
  seed: string;
  splitToken: string;
}): Promise<
  | { ok: true; paymentIds: string[]; primaryPaymentId: string; alreadyCaptured?: boolean }
  | { ok: false; error: SplitError; detail?: string }
> {
  const gate = await loadAuthorizedAnchor(params.seed, params.splitToken);
  if ("error" in gate) return { ok: false, error: gate.error };
  const anchor = gate.anchor;

  // The payment set comes from POSITIVE tender entries only (gift-card auths
  // added by this service; terminal taps stamped by the poll route) — never
  // inferred by set-difference on the paymentIds union (review 2026-07-29:
  // a canceled auth left in the union must not read as a tap).
  const gcTenders = authorizedTenders(anchor, "gift_card");
  const termTenders = authorizedTenders(anchor, "terminal");
  const gcPaymentIds = gcTenders.map((t) => t.paymentId as string).filter(Boolean);
  const terminalPaymentIds = termTenders.map((t) => t.paymentId as string).filter(Boolean);
  const paymentIds = [...gcPaymentIds, ...terminalPaymentIds];
  if (paymentIds.length === 0) return { ok: false, error: "nothing-to-capture" };

  if (anchor.capturedAt) {
    // Idempotent replay (double-tap of the capture call).
    return {
      ok: true,
      paymentIds,
      primaryPaymentId: terminalPaymentIds[0] ?? gcPaymentIds[0],
      alreadyCaptured: true,
    };
  }

  // Verify the SET covers the total exactly before capturing — the GC amounts
  // come from the anchor; the terminal amounts are re-read from Square (never
  // trust the client's claim; the stamp records amount 0).
  const total = anchorTotalCents(anchor);
  let sum = gcTenders.reduce((s, t) => s + t.amountCents, 0);
  const verifiedTermAmounts = new Map<string, number>();
  for (const pid of terminalPaymentIds) {
    const pay = await getSquarePayment(pid);
    if (!pay || (pay.status !== "APPROVED" && pay.status !== "COMPLETED")) {
      return { ok: false, error: "square-error", detail: `payment ${pid} not capturable` };
    }
    if (pay.orderId && pay.orderId !== anchor.depositOrderId) {
      return { ok: false, error: "square-error", detail: `payment ${pid} paid a different order` };
    }
    verifiedTermAmounts.set(pid, pay.amountCents);
    sum += pay.amountCents;
  }
  if (sum !== total) {
    return {
      ok: false,
      error: "sum-mismatch",
      detail: `tenders cover ${sum}¢ of ${total}¢ — arm the reader for the remainder first`,
    };
  }

  // Ledger reflects the FULL verified set before the capture call.
  const ledgerTenders = (anchor.tenders ?? []).map((t) =>
    t.kind === "terminal" && t.paymentId && verifiedTermAmounts.has(t.paymentId)
      ? { ...t, amountCents: verifiedTermAmounts.get(t.paymentId) as number }
      : t,
  );
  await setSplitTenders(anchor.baseKey, ledgerTenders as SplitTenderEntry[], anchor.attempt);

  try {
    const { orderState } = await payOrder({
      orderId: anchor.depositOrderId,
      paymentIds,
      baseKey: anchor.baseKey,
      idempotencyKey: payOrderKey(anchor.baseKey, paymentIds),
    });
    if (orderState && orderState !== "COMPLETED") {
      return {
        ok: false,
        error: "square-error",
        detail: `PayOrder returned order state ${orderState}`,
      };
    }
  } catch (err) {
    // Do NOT cancel here: the reader tap may already be APPROVED and the guest
    // is standing there — the client retries capture; abandon/idle unwinds.
    return {
      ok: false,
      error: "square-error",
      detail: err instanceof SquarePaymentError ? err.message : String(err),
    };
  }

  await updateTerminalAnchor(params.seed, (a) => ({
    ...a,
    tenders: ledgerTenders,
    capturedAt: new Date().toISOString(),
  }));
  await setSplitState(anchor.baseKey, "captured");
  return { ok: true, paymentIds, primaryPaymentId: terminalPaymentIds[0] ?? gcPaymentIds[0] };
}

// ── Status (client resume after refresh/crash) ──────────────────────────────

export async function getSplitStatus(params: {
  seed: string;
  splitToken: string;
}): Promise<{ ok: true; status: SplitStatus } | { ok: false; error: SplitError }> {
  const gate = await loadAuthorizedAnchor(params.seed, params.splitToken);
  if ("error" in gate) return { ok: false, error: gate.error };
  const anchor = gate.anchor;
  return {
    ok: true,
    status: {
      totalCents: anchorTotalCents(anchor),
      remainingCents: splitRemainingCents(anchor),
      tenders: authorizedTenders(anchor, "gift_card").map((t) => ({
        kind: "gift_card" as const,
        ganLast4: t.ganLast4,
        amountCents: t.amountCents,
      })),
      ...(anchor.capturedAt ? { capturedAt: anchor.capturedAt } : {}),
    },
  };
}
