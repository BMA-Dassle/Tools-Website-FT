/**
 * Split-tender model — the shared shape for "several payments cover one
 * checkout" (plan: tasks/split-payments-plan.md, PR-2).
 *
 * Owner rules baked in (2026-07-26):
 *   - gift cards FIRST (each drained to min(balance, remaining)), cards after;
 *   - guest-entered card amounts; only the LAST card may omit its amount
 *     (= auto-fill the remainder);
 *   - caps: SQUARE_MAX_TENDERS_PER_ORDER total, 5 gift cards, 4 cards.
 *
 * Square rule the whole model exists to satisfy: an order cannot be partially
 * paid — every tender is authorized `autocomplete:false` and the full set is
 * captured atomically by PayOrder, so planned amounts MUST sum exactly to the
 * total (probe #1 GO, 2026-07-29).
 *
 * This file is PURE (schema + math + key derivation) so it unit-tests without
 * any Square mocking. The engine that moves money is `authorizeTenders` in
 * lib/square-gift-card.ts; routes gain `tenders[]` parsing in PR-4.
 */
import { createHash } from "crypto";
import { z } from "zod";

/**
 * Square's per-order payment cap for PayOrder. PROBE-GATED: believed 10 from
 * Square's docs; `scripts/probe-payorder-cap.mts` confirms the real value
 * before any flag flips (tasks/split-tender-probes.md #3). Lower it here if
 * the probe says otherwise — every guard reads this constant.
 */
export const SQUARE_MAX_TENDERS_PER_ORDER = 10;
/** Product caps (UX sanity, always ≤ the Square cap). */
export const MAX_GIFT_CARD_TENDERS = 5;
export const MAX_CARD_TENDERS = 4;

// ── Request schema (used by routes in PR-4; defined here so the contract is
//    one artifact) ─────────────────────────────────────────────────────────

export const GiftCardTenderSchema = z.object({
  kind: z.literal("gift_card"),
  /** Web Payments SDK gift-card nonce (web checkout). */
  nonce: z.string().min(1).optional(),
  /** Opaque single-use token from the kiosk GAN-lookup route (PR-5's
   *  /api/kiosk/gift-card-lookup). The raw GAN / gftc: id never round-trips
   *  through the client. */
  lookupToken: z.string().min(16).optional(),
});

export const CardTenderSchema = z.object({
  kind: z.literal("card"),
  /** Card nonce, saved-card id, or wallet token. */
  sourceId: z.string().min(1),
  /** Guest-entered cents. Omitted on the LAST card only = auto-fill the
   *  remainder after gift cards + earlier cards. */
  amountCents: z.number().int().positive().optional(),
  sourceKind: z.enum(["card", "wallet", "saved"]).optional(),
});

export const TenderSchema = z.discriminatedUnion("kind", [GiftCardTenderSchema, CardTenderSchema]);
export type TenderInput = z.infer<typeof TenderSchema>;

/**
 * The full request-level tender list with every structural rule enforced:
 * counts/caps, gift-cards-before-cards ordering, exactly one of
 * nonce/lookupToken per gift card, only-last-card auto-fill, no duplicate
 * gift-card tokens. Amount SUMS are validated later by `planTenderAmounts`
 * (balances are only known server-side after resolution).
 */
export const TendersRequestSchema = z
  .array(TenderSchema)
  .min(1)
  .max(SQUARE_MAX_TENDERS_PER_ORDER)
  .superRefine((tenders, ctx) => {
    const gcs = tenders.filter((t) => t.kind === "gift_card");
    const cards = tenders.filter((t) => t.kind === "card");
    if (gcs.length > MAX_GIFT_CARD_TENDERS) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${MAX_GIFT_CARD_TENDERS} gift cards per checkout`,
      });
    }
    if (cards.length > MAX_CARD_TENDERS) {
      ctx.addIssue({ code: "custom", message: `at most ${MAX_CARD_TENDERS} cards per checkout` });
    }
    for (const [i, g] of gcs.entries()) {
      if (!!g.nonce === !!g.lookupToken) {
        ctx.addIssue({
          code: "custom",
          message: `gift card #${i + 1} needs exactly one of nonce / lookupToken`,
        });
      }
    }
    // Owner rule: gift cards first, then cards — a gift card after any card is
    // a malformed request (the greedy plan math depends on this ordering).
    const firstCardIdx = tenders.findIndex((t) => t.kind === "card");
    if (firstCardIdx !== -1 && tenders.slice(firstCardIdx).some((t) => t.kind === "gift_card")) {
      ctx.addIssue({ code: "custom", message: "gift cards must precede cards" });
    }
    // Only the LAST card may omit amountCents (auto-fill).
    const lastCardIdx = tenders.map((t) => t.kind).lastIndexOf("card");
    tenders.forEach((t, i) => {
      if (t.kind === "card" && i !== lastCardIdx && t.amountCents == null) {
        ctx.addIssue({ code: "custom", message: "only the last card may omit amountCents" });
      }
    });
    // Duplicate gift-card tokens: the same nonce/lookupToken twice is always a
    // client bug (server-side resolution also dedups by gift-card ID, which
    // catches two DIFFERENT tokens for the same card).
    const tokens = gcs.map((g) => g.nonce ?? g.lookupToken ?? "");
    if (new Set(tokens).size !== tokens.length) {
      ctx.addIssue({ code: "custom", message: "duplicate gift card" });
    }
  });

// ── Pure amount planning ───────────────────────────────────────────────────

export class TenderPlanError extends Error {
  code:
    | "INVALID_AMOUNT"
    | "NO_TENDER"
    | "TOO_MANY_TENDERS"
    | "GIFT_CARD_EMPTY"
    | "GIFT_CARD_NOT_NEEDED"
    | "CARDS_NOT_NEEDED"
    | "CARD_AMOUNT_INVALID"
    | "AMOUNTS_MISMATCH";
  constructor(code: TenderPlanError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface TenderAmountPlan {
  /** Cents each gift card charges, in submitted order (min(balance, remaining)). */
  gcAmounts: number[];
  /** Cents each card charges, in submitted order (last card auto-filled). */
  cardAmounts: number[];
}

/**
 * Plan the exact per-tender amounts. Pure math — resolution (balances) happens
 * server-side in `authorizeTenders` before this runs.
 *
 * Guarantees on success: every amount > 0 and the grand total equals
 * `totalCents` EXACTLY (Square captures all-or-nothing via PayOrder).
 * Throws TenderPlanError otherwise — nothing is authorized on a bad plan.
 *
 * `cardAmounts` entries are the guest-entered cents; `undefined` means
 * auto-fill (validated upstream to be the last card only).
 */
export function planTenderAmounts(
  totalCents: number,
  gcBalancesCents: number[],
  cardAmountsCents: Array<number | undefined>,
): TenderAmountPlan {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new TenderPlanError("INVALID_AMOUNT", "Amount must be a positive number of cents");
  }
  const tenderCount = gcBalancesCents.length + cardAmountsCents.length;
  if (tenderCount < 1) {
    throw new TenderPlanError("NO_TENDER", "No payment method provided");
  }
  if (tenderCount > SQUARE_MAX_TENDERS_PER_ORDER) {
    throw new TenderPlanError(
      "TOO_MANY_TENDERS",
      `At most ${SQUARE_MAX_TENDERS_PER_ORDER} payments per order`,
    );
  }

  let remaining = totalCents;
  const gcAmounts: number[] = [];
  for (const [i, balance] of gcBalancesCents.entries()) {
    if (!Number.isInteger(balance) || balance <= 0) {
      throw new TenderPlanError("GIFT_CARD_EMPTY", `Gift card #${i + 1} has no balance`);
    }
    const amount = Math.min(balance, remaining);
    if (amount <= 0) {
      // Earlier tenders already cover the total — never silently drop a tender
      // the guest believes they used (they'd expect that card drained).
      throw new TenderPlanError(
        "GIFT_CARD_NOT_NEEDED",
        `Gift card #${i + 1} isn't needed — the total is already covered`,
      );
    }
    gcAmounts.push(amount);
    remaining -= amount;
  }

  const cardAmounts: number[] = [];
  for (const [j, entered] of cardAmountsCents.entries()) {
    const isLast = j === cardAmountsCents.length - 1;
    if (remaining <= 0) {
      throw new TenderPlanError(
        "CARDS_NOT_NEEDED",
        "The gift cards already cover the total — remove the card payment",
      );
    }
    const amount = entered ?? (isLast ? remaining : undefined);
    if (amount == null) {
      // Upstream schema enforces this; belt-and-braces for direct callers.
      throw new TenderPlanError(
        "CARD_AMOUNT_INVALID",
        `Card #${j + 1} needs an amount (only the last card may auto-fill)`,
      );
    }
    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
      throw new TenderPlanError(
        "CARD_AMOUNT_INVALID",
        `Card #${j + 1} amount must be between 1¢ and the remaining ${remaining}¢`,
      );
    }
    cardAmounts.push(amount);
    remaining -= amount;
  }

  if (remaining !== 0) {
    throw new TenderPlanError(
      "AMOUNTS_MISMATCH",
      `Planned payments leave ${remaining}¢ unpaid — amounts must cover the total exactly`,
    );
  }
  return { gcAmounts, cardAmounts };
}

// ── Idempotency key scheme (per-tender, ≤ 45 chars — Square's limit) ────────
//
// baseKey is the 16-hex `reserveBaseKey(seed)`. All new namespaces are
// disjoint from the legacy single-tender keys (`pay-gc-${baseKey}`,
// `pay-card-${baseKey}-h8`, `payorder-${baseKey}`, `cancel-*`) so a split
// retry can never collide with a prior legacy attempt on the same bill.
//
// ATTEMPT SALT (burned-key lesson, tasks/lessons.md 2026-07-25 + PR-2 review):
// gift-card ids (gftc:…) and saved-card tokens (ccof:…) are STABLE, so
// h8(source) alone would replay a key that a cancel-all unwind already burned
// — Square would return the CANCELED payment and every retry of the checkout
// would deadlock. Callers bump `attempt` on each retry AFTER a failed
// authorize/capture (the PR-3 ledger row and PR-6 anchor both carry it, same
// contract as the terminal `term-…-a${n}` keys). A true network-level
// double-POST of the SAME attempt still dedups.

export function h8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** Gift-card auth, tender index i, attempt a:
 *  `pay-gc-<baseKey>-<i>-<h8(source)>-a<n>` (≤ 40 at attempt 99). */
export function gcAuthKey(baseKey: string, index: number, sourceId: string, attempt = 0): string {
  return `pay-gc-${baseKey}-${index}-${h8(sourceId)}-a${attempt}`;
}

/** Card auth, tender index j, attempt a — h8(source) gives a NEW card at the
 *  same slot a fresh key even within one attempt; the attempt salt frees a
 *  STABLE source (saved card) after an unwind burned its key.
 *  `pay-card-<baseKey>-<j>-<h8>-a<n>` (≤ 42 at attempt 99). */
export function cardAuthKey(baseKey: string, index: number, sourceId: string, attempt = 0): string {
  return `pay-card-${baseKey}-${index}-${h8(sourceId)}-a${attempt}`;
}

/** Atomic capture — salted with the payment-id SET so a retry after one
 *  tender was swapped gets a fresh key (the old set's key is burned). */
export function payOrderKey(baseKey: string, paymentIds: string[]): string {
  return `payord2-${baseKey}-${h8(paymentIds.join(","))}`;
}

/** Per-payment cancel (engine unwind + the PR-3 sweep share this namespace). */
export function cancelKey(baseKey: string, paymentId: string): string {
  return `cxl-${baseKey}-${h8(paymentId)}`;
}
