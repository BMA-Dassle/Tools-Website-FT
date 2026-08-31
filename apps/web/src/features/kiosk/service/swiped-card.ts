/**
 * Swipe kiosks (no dispenser, owner 2026-08-28): the client-side half of "is
 * the card the guest just swiped a BLANK we may load as new?" — one lookup and
 * one bounded wait-for-a-blank loop, shared by every screen that asks the
 * question (the new-card cart, the voucher run, the confirmation-screen
 * fulfilment), so no two screens can ever read the verify response differently
 * or run a different re-prompt policy for the same swiped card.
 *
 * The VERDICT itself is the shared pure rule in game-cards/blank-card.ts; the
 * server re-checks it before any money moves (swiped-blank-guard.ts). This file
 * only owns the fetch and the loop.
 */
import { classifySwipedCard, type SwipedCardClass } from "~/features/game-cards/blank-card";
import type { VerifyResult } from "~/features/game-cards/types";
import { SwipeWaitError, type SwipeWaiter } from "../card-reader/swipe-waiter";
import type { Translate } from "../i18n";

export interface SwipedVerdict {
  cls: SwipedCardClass;
  /** Tokens + bonus already on the card (for the "isn't new" message). */
  tokens: number;
}

const UNKNOWN: SwipedVerdict = { cls: "unknown", tokens: 0 };

/**
 * Look the swiped account up and classify it. A failed or ambiguous lookup is
 * "unknown" — never "blank". The client deadline sits ABOVE the server's 20 s
 * Intercard SOAP timeout, so a slow answer is waited for rather than thrown
 * away and immediately re-requested.
 */
export async function classifySwipedAccount(
  accountNumber: string,
  locationCode: number,
): Promise<SwipedVerdict> {
  try {
    const res = await fetch("/api/game-cards/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountNumber, locationCode }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = (await res.json().catch(() => null)) as Partial<VerifyResult> | null;
    if (!res.ok || !data) return UNKNOWN;
    const cls = classifySwipedCard({
      exists: data.exists === true,
      notFound: data.notFound,
      balance: data.balance,
      cashBalance: data.cashBalance,
      transactions: data.transactions,
    });
    return { cls, tokens: (data.balance?.tokens ?? 0) + (data.balance?.bonusTokens ?? 0) };
  } catch {
    return UNKNOWN;
  }
}

export type BlankWaitState =
  | { phase: "waiting"; note: string | null }
  | { phase: "checking" }
  | { phase: "idle" };

export type AcquireBlankResult =
  | { ok: true; account: string }
  | { ok: false; why: "cancelled" | "timeout" };

/**
 * Wait for the guest to swipe a BLANK. Bounded (the waiter's default) and
 * cancel-able; a card that already carries value, one already used this run, or
 * one we couldn't check re-prompts with a note instead of failing. `onState`
 * drives the screen's guide; `used` is the caller's set of accounts already
 * committed this run — the caller adds to it once a card is actually loaded (or
 * a claim was taken against it), never before.
 */
export async function acquireBlankBySwipe(opts: {
  waiter: SwipeWaiter;
  locationCode: number;
  used: ReadonlySet<string>;
  t: Translate;
  onState: (s: BlankWaitState) => void;
  timeoutMs?: number;
}): Promise<AcquireBlankResult> {
  let note: string | null = null;
  for (;;) {
    opts.onState({ phase: "waiting", note });
    let acct: string;
    try {
      acct = await opts.waiter.wait({ timeoutMs: opts.timeoutMs });
    } catch (err) {
      opts.onState({ phase: "idle" });
      return {
        ok: false,
        why: err instanceof SwipeWaitError && err.kind === "timeout" ? "timeout" : "cancelled",
      };
    }
    if (opts.used.has(acct)) {
      note = opts.t("gamezone.swipe.duplicate");
      continue;
    }
    opts.onState({ phase: "checking" });
    const v = await classifySwipedAccount(acct, opts.locationCode);
    if (v.cls === "blank") {
      opts.onState({ phase: "idle" });
      return { ok: true, account: acct };
    }
    note =
      v.cls === "active" ? opts.t("gamezone.swipe.active.short") : opts.t("gamezone.swipe.unknown");
  }
}
