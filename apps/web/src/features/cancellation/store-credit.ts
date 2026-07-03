/**
 * Store-credit issuance: convert the internal deposit gift card (custom
 * WEBHPFM…-style GAN, blocked as an online payment method by
 * isInternalDepositGan) into a NEW customer-facing DIGITAL card with a
 * SQUARE-GENERATED GAN, loaded with exactly the deposit balance.
 *
 * Two strategies, selected by env STORE_CREDIT_STRATEGY and decided by the
 * live probe (scripts/store-credit-probe.mts) BEFORE this ships to guests:
 *
 *  "purchase" (owner-preferred) — a real sale: order with a GIFT_CARD line
 *    item, PAID by the internal deposit card, then the new card ACTIVATEd
 *    against that order/line item. The internal card hits $0 through the
 *    sale itself — books cleanly as gift-card revenue funded by the deposit.
 *    RISK the probe checks: Square may reject gift-card tenders on gift-card
 *    purchases.
 *
 *  "comp" (default fallback; prod-proven by survey rewards / winback) —
 *    mintDigitalGiftCard's merchant-comp Order+Discount pattern mints the new
 *    card, then the internal card is drained via ADJUST_DECREMENT
 *    (PURCHASE_WAS_REFUNDED). Needs a dedicated catalog discount
 *    (SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID) so the GL line is honest;
 *    falls back to the survey discount with a loud warning until ops creates
 *    one.
 *
 * PERSIST-FIRST: the new card's id/GAN are written to Neon the moment the
 * card object exists — before activation completes, before any teardown,
 * before any email/SMS — so a crash or delivery failure can never lose the
 * card. The admin board reads the GAN off the row forever after.
 */
import { updateStoreCreditIssued } from "@/lib/bowling-db";
import { mintDigitalGiftCard } from "@/lib/square-gift-card";
import { drainGiftCard, fetchGiftCardFacts, sq } from "./square-actions";

export type StoreCreditStrategy = "purchase" | "comp";

export interface StoreCreditResult {
  giftCardId: string;
  gan: string;
  amountCents: number;
  strategy: StoreCreditStrategy | "existing";
}

export function storeCreditStrategy(): StoreCreditStrategy {
  return process.env.STORE_CREDIT_STRATEGY === "purchase" ? "purchase" : "comp";
}

const SURVEY_DISCOUNT_FALLBACK = "37C3SN4245TUCN3RF7XMNKPU";

export async function issueStoreCredit(params: {
  cascadeId: string;
  /** Leg that carries the store_credit_* columns (the money leg). */
  anchorNeonId: number;
  internalGiftCardId: string;
  /** Plan-verified == the internal card's live balance. */
  amountCents: number;
  /** From the internal card's ACTIVATE activity (plan facts). */
  locationId: string;
  squareCustomerId?: string;
  /** A card persisted by a prior attempt — reused, never re-minted. */
  existing?: { giftCardId: string; gan: string; cents: number; state: string };
}): Promise<StoreCreditResult> {
  // ── Resume: a prior attempt already persisted a card ───────────────────────
  if (params.existing) {
    const card = await fetchGiftCardFacts(params.existing.giftCardId);
    if (card.state === "ACTIVE" && card.balanceCents > 0) {
      if (params.existing.state !== "issued") {
        await updateStoreCreditIssued(params.anchorNeonId, {
          giftCardId: params.existing.giftCardId,
          gan: params.existing.gan,
          cents: card.balanceCents,
          state: "issued",
        });
      }
      // The internal card may still hold the money if the prior attempt died
      // between mint and drain — draining is skip-at-zero idempotent.
      await drainGiftCard({ cascadeId: params.cascadeId, giftCardId: params.internalGiftCardId });
      return {
        giftCardId: params.existing.giftCardId,
        gan: params.existing.gan,
        amountCents: card.balanceCents,
        strategy: "existing",
      };
    }
    console.error(
      `[store-credit] persisted card ${params.existing.giftCardId} is ${card.state} ` +
        `balance=${card.balanceCents} — issuing a replacement (old card stays orphaned at $0)`,
    );
  }

  const strategy = storeCreditStrategy();
  const minted =
    strategy === "purchase" ? await issueViaPurchase(params) : await issueViaComp(params);
  await updateStoreCreditIssued(params.anchorNeonId, {
    giftCardId: minted.giftCardId,
    gan: minted.gan,
    cents: params.amountCents,
    state: "issued",
  });
  return { ...minted, amountCents: params.amountCents, strategy };
}

// ── Strategy A: sell a gift card, paid by the internal deposit card ─────────

async function issueViaPurchase(params: {
  cascadeId: string;
  anchorNeonId: number;
  internalGiftCardId: string;
  amountCents: number;
  locationId: string;
}): Promise<{ giftCardId: string; gan: string }> {
  // 1. Order with one GIFT_CARD line at the full amount (GIFT_CARD lines are
  //    not taxed by Square).
  const orderRes = await sq("POST", "/orders", {
    idempotency_key: `gc-order-${params.cascadeId}`,
    order: {
      location_id: params.locationId,
      line_items: [
        {
          name: "Store Credit — Cancelled Reservation",
          quantity: "1",
          item_type: "GIFT_CARD",
          base_price_money: { amount: params.amountCents, currency: "USD" },
        },
      ],
    },
  });
  if (!orderRes.ok) throw storeCreditErr("purchase order create", orderRes);
  const orderId: string | undefined = orderRes.json?.order?.id;
  const lineItemUid: string | undefined = orderRes.json?.order?.line_items?.[0]?.uid;
  if (!orderId || !lineItemUid) {
    throw new Error("[store-credit] Square returned no order id / line item uid");
  }

  // 2. Pay it WITH the internal deposit gift card — the probed call. If Square
  //    rejects gift-card tenders on gift-card purchases this throws and the
  //    operator must set STORE_CREDIT_STRATEGY=comp (the probe should have
  //    settled this before any guest saw the feature).
  const payRes = await sq("POST", "/payments", {
    idempotency_key: `gc-pay-${params.cascadeId}`,
    source_id: params.internalGiftCardId,
    amount_money: { amount: params.amountCents, currency: "USD" },
    order_id: orderId,
    location_id: params.locationId,
    autocomplete: true,
  });
  if (!payRes.ok) {
    throw storeCreditErr(
      "purchase payment (gift-card tender on a gift-card sale — if Square forbids this, " +
        "set STORE_CREDIT_STRATEGY=comp)",
      payRes,
    );
  }

  // 3. Create the DIGITAL card — NO custom gan field, so Square GENERATES the
  //    GAN (the whole point: the guest must never hold a WEBHPFM…-style
  //    internal number, which online checkout blocks).
  const createRes = await sq("POST", "/gift-cards", {
    idempotency_key: `gc-mint-${params.cascadeId}`,
    location_id: params.locationId,
    gift_card: { type: "DIGITAL" },
  });
  if (!createRes.ok) throw storeCreditErr("card create", createRes);
  const giftCardId: string | undefined = createRes.json?.gift_card?.id;
  const gan: string | undefined = createRes.json?.gift_card?.gan;
  if (!giftCardId || !gan) throw new Error("[store-credit] Square returned no gift card id/gan");

  // 4. PERSIST-FIRST — the GAN survives anything that fails after this line.
  await updateStoreCreditIssued(params.anchorNeonId, {
    giftCardId,
    gan,
    cents: params.amountCents,
    state: "issuing",
  });

  // 5. ACTIVATE against the paid order; verify like mintDigitalGiftCard does
  //    (200-with-errors + zero-balance + re-GET ACTIVE all fail loudly).
  const actRes = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `gc-act-${params.cascadeId}`,
    gift_card_activity: {
      type: "ACTIVATE",
      location_id: params.locationId,
      gift_card_id: giftCardId,
      activate_activity_details: { order_id: orderId, line_item_uid: lineItemUid },
    },
  });
  if (!actRes.ok) throw storeCreditErr("card activate", actRes);
  const loaded =
    actRes.json?.gift_card_activity?.gift_card_balance_money?.amount ??
    actRes.json?.gift_card_activity?.activate_activity_details?.amount_money?.amount ??
    0;
  if (loaded === 0) throw new Error("[store-credit] Square activated the card with a $0 balance");

  const verify = await fetchGiftCardFacts(giftCardId);
  if (verify.state !== "ACTIVE" || verify.balanceCents <= 0) {
    throw new Error(
      `[store-credit] card ${giftCardId} is ${verify.state} balance=${verify.balanceCents} after activate`,
    );
  }
  return { giftCardId, gan };
}

// ── Strategy B: comp-mint + drain the internal card ─────────────────────────

async function issueViaComp(params: {
  cascadeId: string;
  anchorNeonId: number;
  internalGiftCardId: string;
  amountCents: number;
  locationId: string;
  squareCustomerId?: string;
}): Promise<{ giftCardId: string; gan: string }> {
  const discountId =
    process.env.SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID ||
    process.env.SQUARE_SURVEY_DISCOUNT_CATALOG_ID ||
    SURVEY_DISCOUNT_FALLBACK;
  if (!process.env.SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID) {
    console.warn(
      "[store-credit] SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID not set — comp mint will book " +
        "against the survey-reward discount. Create a 'Store Credit — Reservation Cancellation' " +
        "catalog discount and set the env for honest GL.",
    );
  }

  // mintDigitalGiftCard: order+discount → $0 pay → create DIGITAL (auto GAN) →
  // ACTIVATE by order → verify ACTIVE — all idempotent on baseKey.
  const minted = await mintDigitalGiftCard({
    locationId: params.locationId,
    amountCents: params.amountCents,
    baseKey: params.cascadeId,
    discountCatalogObjectId: discountId,
    customerId: params.squareCustomerId,
  });

  // Persist BEFORE the drain: if the drain fails the card is already
  // recoverable, and the cascade aborts loudly on the double-liability.
  await updateStoreCreditIssued(params.anchorNeonId, {
    giftCardId: minted.giftCardId,
    gan: minted.gan,
    cents: params.amountCents,
    state: "issuing",
  });

  // FATAL by design: comp-minting without draining leaves BOTH cards loaded
  // (double liability). drainGiftCard re-reads the live balance and is
  // skip-at-zero idempotent, so a retry converges.
  await drainGiftCard({ cascadeId: params.cascadeId, giftCardId: params.internalGiftCardId });

  return { giftCardId: minted.giftCardId, gan: minted.gan };
}

function storeCreditErr(what: string, r: { status: number; json: unknown }): Error {
  return new Error(
    `[store-credit] ${what} failed (${r.status}): ` +
      `${JSON.stringify((r.json as { errors?: unknown })?.errors ?? r.json).slice(0, 300)}`,
  );
}
