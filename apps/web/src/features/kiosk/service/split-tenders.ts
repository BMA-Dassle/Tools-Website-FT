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
import {
  cancelKey,
  gcAuthKey,
  MAX_GIFT_CARD_TENDERS,
  MAX_TOTAL_TENDERS,
  payOrderKey,
} from "~/features/booking/service/tenders";
import { getSquarePayment } from "~/features/booking/service/deposit";
import {
  readTerminalAnchor,
  stampVerifiedTerminalTender,
  updateTerminalAnchor,
  type TerminalAnchor,
  type TerminalAnchorTender,
} from "~/features/booking/service/unified-reserve";
import {
  dismissTerminalCheckout,
  getOrderPaymentInfo,
  getTerminalCheckout,
} from "./square-terminal";
import {
  setSplitCaptured,
  setSplitState,
  setSplitTenders,
  upsertSplitAttempt,
  type SplitTenderEntry,
} from "../data/split-tenders-db";

const LOOKUP_TOKEN_TTL_S = 15 * 60;
const lookupTokenKey = (token: string) => `kiosk:gclookup:${token}`;
const addLockKey = (seed: string) => `kiosk:split:lock:${seed}`;

export type SplitError =
  | "not-enabled"
  | "no-session"
  | "bad-token" // splitToken missing/mismatched — treat exactly like no-session outward
  | "already-captured"
  | "busy"
  | "card-unusable" // internal / inactive / not found — deliberately vague outward
  | "zero-balance"
  | "gc-limit"
  | "tender-limit" // MAX_TOTAL_TENDERS reached — remove one or pay the rest by card
  | "tender-not-found" // per-tender remove named a payment this session doesn't hold
  | "token-invalid"
  | "nothing-to-capture"
  | "sum-mismatch"
  | "square-error";

export interface SplitStatus {
  totalCents: number;
  remainingCents: number;
  /** EVERY authorized tender — the ambient board renders these rows. */
  tenders: Array<{
    kind: "gift_card" | "terminal";
    isGiftCard: boolean;
    paymentId?: string;
    /** ganLast4 for GAN-rail cards; card last4 for terminal payments. */
    last4?: string;
    amountCents: number;
  }>;
  capturedAt?: string;
}

/** The checkout's full charge. Prefers the writer-stamped explicit total
 *  (anchor.totalCents — the writers disagree about depositCents' meaning);
 *  legacy anchors fall back to deposit + Game Zone card lines. */
function anchorTotalCents(anchor: TerminalAnchor): number {
  return anchor.totalCents ?? anchor.depositCents + (anchor.gameCards?.totalCents ?? 0);
}

/**
 * A tender counts against the gift-card cap whether it entered via the GAN
 * rail (kind gift_card, source_type GIFT_CARD) or was swiped at the Terminal
 * (kind terminal, card brand SQUARE_GIFT_CARD).
 */
export function isGiftCardTender(
  t: Pick<TerminalAnchorTender, "kind" | "sourceType" | "cardBrand">,
): boolean {
  return (
    t.kind === "gift_card" || t.sourceType === "GIFT_CARD" || t.cardBrand === "SQUARE_GIFT_CARD"
  );
}

function authorizedTenders(
  anchor: TerminalAnchor,
  kind?: TerminalAnchorTender["kind"],
): TerminalAnchorTender[] {
  return (anchor.tenders ?? []).filter(
    (t) => t.status === "authorized" && (kind ? t.kind === kind : true),
  );
}

/**
 * Cents still owed after EVERY authorized tender — gift-card auths and
 * verified terminal payments alike (the ambient rail's partial approvals make
 * a terminal tender smaller than the amount it was armed for). Legacy stamps
 * recorded terminal tenders at amountCents 0, which sums as "not counted" —
 * exactly the old behavior, so a mid-deploy anchor computes identically.
 */
export function splitRemainingCents(anchor: TerminalAnchor): number {
  const covered = authorizedTenders(anchor).reduce((s, t) => s + t.amountCents, 0);
  return Math.max(0, anchorTotalCents(anchor) - covered);
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
      /** paymentId keys the board row's per-tender Remove. */
      tender: { paymentId: string; ganLast4: string; amountCents: number };
      remainingCents: number;
    }
  | { ok: false; error: SplitError; detail?: string }
> {
  // Cheap mutex — two concurrent adds on one session must not double-auth
  // (the caps guard below is read-then-write on Redis).
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
  | {
      ok: true;
      tender: { paymentId: string; ganLast4: string; amountCents: number };
      remainingCents: number;
    }
  | { ok: false; error: SplitError; detail?: string }
> {
  const gate = await loadAuthorizedAnchor(params.seed, params.splitToken);
  if ("error" in gate) return { ok: false, error: gate.error };
  // Harvest-then-dismiss BEFORE sizing: a tap that landed on the armed
  // checkout shrinks the remainder this gift card is sized against — and if
  // it covered everything, the guest already paid.
  const anchor = await harvestAndDismissPending(params.seed, gate.anchor);
  if (anchor.capturedAt) return { ok: false, error: "already-captured" };
  const authorized = authorizedTenders(anchor);
  if (authorized.filter(isGiftCardTender).length >= MAX_GIFT_CARD_TENDERS) {
    return { ok: false, error: "gc-limit" };
  }
  if (authorized.length >= MAX_TOTAL_TENDERS) {
    return { ok: false, error: "tender-limit" };
  }
  // A harvested tap already covers the total — the guest paid while this scan
  // was in flight. Capture the existing set instead of applying the card
  // (BEFORE consuming the lookup token, so nothing is burned), and report
  // already-captured; the client's idempotent capture call returns the set.
  if (authorized.length > 0 && splitRemainingCents(anchor) === 0) {
    const cap = await captureSplit({ seed: params.seed, splitToken: params.splitToken });
    if (cap.ok) return { ok: false, error: "already-captured" };
    return { ok: false, error: cap.error, detail: "detail" in cap ? cap.detail : undefined };
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
  // Monotonic slot — never re-used after a cancel (the auth idempotency key
  // salts on it; a re-used slot would replay a burned key).
  const index = anchor.tenderSeq ?? anchor.tenders?.length ?? 0;

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
      idempotencyKey: gcAuthKey(anchor.baseKey, index, info.id, attempt),
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
    index,
    kind: "gift_card",
    paymentId: auth.paymentId,
    amountCents,
    ganLast4: info.gan.slice(-4),
    sourceType: "GIFT_CARD",
    status: "authorized",
  };
  // APPEND-ONLY: canceled tenders stay as history, and a prior AUTHORIZED
  // tender (another gift card, or a partial terminal tap) must survive an
  // add — dropping it would inflate the remainder and over-arm the reader.
  const nextTenders = [...(anchor.tenders ?? []), tender];
  // Ledger first (durable), anchor second (fast pointer).
  await setSplitTenders(anchor.baseKey, nextTenders as SplitTenderEntry[], attempt);
  const updated = await updateTerminalAnchor(params.seed, (a) => ({
    ...a,
    split: true as const,
    tenders: nextTenders,
    tenderSeq: index + 1,
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
      [...(anchor.tenders ?? []), { ...tender, status: outcome }] as SplitTenderEntry[],
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
    tender: { paymentId: auth.paymentId, ganLast4: tender.ganLast4 as string, amountCents },
    remainingCents: splitRemainingCents(updated),
  };
}

// ── Harvest-then-dismiss (the ambient rail's arm interlock) ─────────────────

/**
 * Retire the currently-armed reader checkout WITHOUT losing a tap that raced
 * in: harvest its payments (verified re-read → stamp) BEFORE dismissing, then
 * re-read once after — a tap can land in the dismiss's settling window. Every
 * caller that changes the remainder (add / remove / re-arm) runs this first,
 * so an armed amount can never go stale with money attached to it. Returns
 * the freshest anchor (or the input when nothing changed).
 */
export async function harvestAndDismissPending(
  seed: string,
  anchor: TerminalAnchor,
): Promise<TerminalAnchor> {
  const pending = anchor.pendingCheckout?.id ?? anchor.pendingCheckoutId;
  if (!pending) return anchor;
  let latest = anchor;
  const harvest = async () => {
    try {
      const ck = await getTerminalCheckout(pending);
      for (const pid of ck?.paymentIds ?? []) {
        const pay = await getSquarePayment(pid);
        const usable =
          pay &&
          (pay.status === "APPROVED" || pay.status === "COMPLETED") &&
          (!pay.orderId || pay.orderId === anchor.depositOrderId);
        if (!usable) continue;
        const stamped = await stampVerifiedTerminalTender(seed, {
          paymentId: pid,
          amountCents: pay.effectiveCents,
          sourceType: pay.sourceType,
          cardBrand: pay.cardBrand,
          last4: pay.last4,
          checkoutId: pending,
        });
        if (stamped) latest = stamped;
      }
    } catch {
      /* checkout unfetchable — the dismiss below + unwind's void loop cover it */
    }
  };
  await harvest();
  try {
    await dismissTerminalCheckout(pending);
  } catch {
    /* already done/expired */
  }
  await harvest();
  // A checkout that produced no payment leaves pendingCheckout set — clear it
  // (the stamp clears it only when a payment actually arrived on it).
  const cleared = await updateTerminalAnchor(seed, (a) =>
    (a.pendingCheckout?.id ?? a.pendingCheckoutId) === pending
      ? { ...a, pendingCheckout: undefined, pendingCheckoutId: undefined }
      : a,
  );
  return cleared ?? latest;
}

// ── 3. Remove / abandon (verified unwind + attempt bump) ────────────────────

/** Void an auth and VERIFY the outcome — cancelSquarePayment swallows errors,
 *  and a failed void must never be recorded as a successful one. Exported for
 *  the poll driver's stray-arm guard (a tap on a pre-unwind checkout). */
export async function verifiedCancel(
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
  // 1. Harvest-then-dismiss the armed checkout FIRST — a tap must not land
  //    while (or after) we void the software auths, and a tap that ALREADY
  //    landed but was never polled must enter the void loop below (before the
  //    harvest, such an auth was invisible to abandon and sat live for 36h).
  anchor = await harvestAndDismissPending(seed, anchor);
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
    pendingCheckout: undefined,
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
  /**
   * Void ONLY this tender (the multi-tender board's per-row Remove). Only a
   * GIFT-CARD tender is removable — a guest's tapped card hold is undone by
   * cancel-everything, never by a row button. Absent = the legacy full unwind
   * (every authorized tender voided), which the v1 board still calls.
   */
  paymentId?: string;
}): Promise<{ ok: true; remainingCents: number } | { ok: false; error: SplitError }> {
  const gate = await loadAuthorizedAnchor(params.seed, params.splitToken);
  if ("error" in gate) return { ok: false, error: gate.error };
  if (gate.anchor.capturedAt) return { ok: false, error: "already-captured" };
  if (params.paymentId) return removeSingleTender(params.seed, gate.anchor, params.paymentId);
  await unwindTenders(params.seed, gate.anchor);
  const after = await readTerminalAnchor(params.seed);
  return {
    ok: true,
    remainingCents: after ? splitRemainingCents(after) : anchorTotalCents(gate.anchor),
  };
}

/**
 * Per-tender unwind: dismiss the armed checkout (its amount is stale the
 * moment the remainder changes — the client re-arms), void the ONE named
 * payment with verification, record honestly, bump the attempt salt.
 */
async function removeSingleTender(
  seed: string,
  anchor: TerminalAnchor,
  paymentId: string,
): Promise<{ ok: true; remainingCents: number } | { ok: false; error: SplitError }> {
  const target = authorizedTenders(anchor).find((t) => t.paymentId === paymentId);
  if (!target || !isGiftCardTender(target)) return { ok: false, error: "tender-not-found" };

  // Harvest-then-dismiss: the armed amount is stale the moment the remainder
  // changes, and a tap racing this Remove must be stamped, not lost.
  anchor = await harvestAndDismissPending(seed, anchor);

  const outcome = await verifiedCancel(anchor.baseKey, paymentId);
  const nextTenders = (anchor.tenders ?? []).map((t) =>
    t.paymentId === paymentId ? { ...t, status: outcome } : t,
  );
  const next = await updateTerminalAnchor(seed, (a) => ({
    ...a,
    tenders: nextTenders,
    // A verified void leaves the union (capture must never see it again); a
    // failed void stays visible as cancel-failed.
    paymentIds:
      outcome === "canceled"
        ? (a.paymentIds ?? []).filter((id) => id !== paymentId)
        : (a.paymentIds ?? []),
    pendingCheckoutId: undefined,
    pendingCheckout: undefined,
    attempt: (a.attempt ?? 0) + 1,
  }));
  if (next) {
    await setSplitTenders(anchor.baseKey, (next.tenders ?? []) as SplitTenderEntry[], next.attempt);
  } else {
    // Anchor gone — the ledger is the only durable record; flag for review.
    await setSplitState(anchor.baseKey, "needs_review");
  }
  if (outcome === "cancel-failed") {
    await setSplitState(anchor.baseKey, "needs_review");
    return { ok: false, error: "square-error" };
  }
  return {
    ok: true,
    remainingCents: next ? splitRemainingCents(next) : anchorTotalCents(anchor),
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
  // Same lock as capture: a guest who taps in the instant the idle reset
  // fires must end up either captured or unwound — never a verifiedCancel
  // racing PayOrder. If a capture holds the lock, wait it out; if it won,
  // report already-captured (honest — the sweep/ops path owns what follows).
  let locked = false;
  for (let i = 0; i < 3 && !locked; i++) {
    try {
      locked = (await redis.set(captureLockKey(params.seed), "1", "EX", 30, "NX")) === "OK";
    } catch {
      locked = true; // Redis down — unwind still runs; Square's 36h auto-cancel backstops
    }
    if (!locked) await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!locked) return { ok: false, error: "busy" };
  try {
    const fresh = (await readTerminalAnchor(params.seed)) ?? anchor;
    if (fresh.capturedAt) return { ok: false, error: "already-captured" };
    const { allReleased } = await unwindTenders(params.seed, fresh);
    if (allReleased) await setSplitState(fresh.baseKey, "canceled");
    return { ok: true };
  } finally {
    try {
      await redis.del(captureLockKey(params.seed));
    } catch {
      /* lock expires on its own */
    }
  }
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

  // Capture lock: the GET poll, the add route's inline capture, and the
  // capture route can all observe "remainder hit 0" in the same beat — one
  // PayOrder runs; the losers re-read capturedAt and converge. abandonSplit
  // takes the SAME lock, so a capture in flight can never race an unwind.
  let locked = false;
  try {
    locked = (await redis.set(captureLockKey(params.seed), "1", "EX", 30, "NX")) === "OK";
  } catch {
    locked = true; // Redis down → loadAuthorizedAnchor above already failed closed if the anchor is gone
  }
  if (!locked) {
    // Someone else is capturing — give them a beat, then report their result.
    await new Promise((r) => setTimeout(r, 1_500));
    const after = await readTerminalAnchor(params.seed);
    if (after?.capturedAt) {
      const ids = authorizedTenders(after)
        .map((t) => t.paymentId as string)
        .filter(Boolean);
      return {
        ok: true,
        paymentIds: ids,
        primaryPaymentId: primaryOf(after),
        alreadyCaptured: true,
      };
    }
    return { ok: false, error: "busy" };
  }
  try {
    // Fresh read UNDER the lock — the gate's snapshot may predate a stamp.
    const anchor = (await readTerminalAnchor(params.seed)) ?? gate.anchor;
    return await captureLocked(params.seed, anchor);
  } finally {
    try {
      await redis.del(captureLockKey(params.seed));
    } catch {
      /* lock expires on its own */
    }
  }
}

const captureLockKey = (seed: string) => `kiosk:split:capture:${seed}`;

/** Reader tap first (the guest's "real" payment), else the first gift card. */
function primaryOf(anchor: TerminalAnchor): string {
  const auth = authorizedTenders(anchor);
  return (auth.find((t) => t.kind === "terminal")?.paymentId ??
    auth.find((t) => t.paymentId)?.paymentId) as string;
}

async function captureLocked(
  seed: string,
  anchor: TerminalAnchor,
): Promise<
  | { ok: true; paymentIds: string[]; primaryPaymentId: string; alreadyCaptured?: boolean }
  | { ok: false; error: SplitError; detail?: string }
> {
  // The payment set comes from POSITIVE tender entries only (gift-card auths
  // added by this service; terminal taps stamped by the poll route) — never
  // inferred by set-difference on the paymentIds union (review 2026-07-29:
  // a canceled auth left in the union must not read as a tap).
  const gcTenders = authorizedTenders(anchor, "gift_card");
  let termTenders = authorizedTenders(anchor, "terminal");
  const gcPaymentIds = gcTenders.map((t) => t.paymentId as string).filter(Boolean);
  let terminalPaymentIds = termTenders.map((t) => t.paymentId as string).filter(Boolean);
  let paymentIds = [...gcPaymentIds, ...terminalPaymentIds];
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
  // come from the anchor; the terminal amounts are re-read from Square at
  // their EFFECTIVE (approved) cents: on a partial authorization Square may
  // keep amount_money at the requested figure while approved_money carries
  // the truth (probe-partial-auth.mts A2), and capturing on the requested
  // figure would misstate the sum.
  const total = anchorTotalCents(anchor);
  const gcSum = gcTenders.reduce((s, t) => s + t.amountCents, 0);
  let termSum = 0;
  const verifiedTermAmounts = new Map<string, number>();
  for (const pid of terminalPaymentIds) {
    const pay = await getSquarePayment(pid);
    if (!pay || (pay.status !== "APPROVED" && pay.status !== "COMPLETED")) {
      return { ok: false, error: "square-error", detail: `payment ${pid} not capturable` };
    }
    if (pay.orderId && pay.orderId !== anchor.depositOrderId) {
      return { ok: false, error: "square-error", detail: `payment ${pid} paid a different order` };
    }
    verifiedTermAmounts.set(pid, pay.effectiveCents);
    termSum += pay.effectiveCents;
  }
  let sum = gcSum + termSum;

  // Over-collection corrective pass: a tap sized for the pre-scan remainder
  // can land in the same beat a gift card applies (harvest narrows the window
  // but cannot close it — the tap may already be in flight on the Terminal).
  // The NEWEST terminal tender is the one sized for a stale remainder: void
  // it, recompute, proceed. GC adds are lock-serialized and exact-amount, so
  // one pass suffices; anything still over is a genuine anomaly.
  if (sum > total && termTenders.length > 0) {
    const newest = [...termTenders].sort((a, b) => b.index - a.index)[0];
    const newestId = newest.paymentId as string;
    const outcome = await verifiedCancel(anchor.baseKey, newestId);
    console.warn(
      `[kiosk-split] over-collection ${sum}¢ > ${total}¢ — voided newest tap ${newestId} (${outcome})`,
    );
    const updated = await updateTerminalAnchor(seed, (a) => ({
      ...a,
      tenders: (a.tenders ?? []).map((t) =>
        t.paymentId === newestId ? { ...t, status: outcome } : t,
      ),
      paymentIds:
        outcome === "canceled"
          ? (a.paymentIds ?? []).filter((id) => id !== newestId)
          : (a.paymentIds ?? []),
      attempt: (a.attempt ?? 0) + 1,
    }));
    if (outcome !== "canceled" || !updated) {
      await setSplitState(anchor.baseKey, "needs_review");
      return { ok: false, error: "square-error", detail: "over-collected set needs review" };
    }
    anchor = updated;
    termTenders = authorizedTenders(anchor, "terminal");
    terminalPaymentIds = termTenders.map((t) => t.paymentId as string).filter(Boolean);
    paymentIds = [...gcPaymentIds, ...terminalPaymentIds];
    sum = gcSum + terminalPaymentIds.reduce((s, pid) => s + (verifiedTermAmounts.get(pid) ?? 0), 0);
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
    // Tolerance: PayOrder can fail on an order that is ALREADY COMPLETED — a
    // kill-switch-off capture-on-tap, or a racing capture that beat the lock's
    // 30s expiry. If Square says the order is COMPLETED and its tender set
    // covers ours, the money outcome we wanted already exists — succeed.
    const info = await getOrderPaymentInfo(anchor.depositOrderId).catch(() => null);
    if (info?.state === "COMPLETED" && paymentIds.every((id) => info.paymentIds.includes(id))) {
      console.log(
        `[kiosk-split] PayOrder raced an already-COMPLETED order ${anchor.depositOrderId} — treating as captured`,
      );
    } else {
      // Do NOT cancel here: the reader tap may already be APPROVED and the
      // guest is standing there — the client retries capture; abandon/idle
      // unwinds.
      return {
        ok: false,
        error: "square-error",
        detail: err instanceof SquarePaymentError ? err.message : String(err),
      };
    }
  }

  const capturedAt = new Date().toISOString();
  await updateTerminalAnchor(seed, (a) => ({
    ...a,
    tenders: ledgerTenders,
    capturedAt,
  }));
  // PERSIST-FIRST house rule at capture: the full payment set must land in
  // Neon (refund-alerts matches on it). A missing row is LOUD — never silent.
  const persist = await setSplitCaptured(anchor.baseKey, {
    tenders: ledgerTenders as SplitTenderEntry[],
    paymentIds,
    capturedAt,
  });
  if (!persist.persisted && persist.reason === "no-row") {
    // setSplitCaptured writes state='captured' itself when the row exists, so
    // this branch means the durable record is GONE while money moved.
    console.error(
      `[kiosk-split] CAPTURED but the ledger row is MISSING baseKey=${anchor.baseKey} payments=${paymentIds.join(",")} — refund-alerts is blind to this set; needs review`,
    );
    await setSplitState(anchor.baseKey, "needs_review");
  }
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
      tenders: authorizedTenders(anchor).map((t) => ({
        kind: t.kind,
        isGiftCard: isGiftCardTender(t),
        paymentId: t.paymentId,
        last4: t.ganLast4 ?? t.last4,
        amountCents: t.amountCents,
      })),
      ...(anchor.capturedAt ? { capturedAt: anchor.capturedAt } : {}),
    },
  };
}
