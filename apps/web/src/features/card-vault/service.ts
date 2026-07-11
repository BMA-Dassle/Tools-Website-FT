/**
 * Card-vault service — silent card capture at booking, the saved-card charge
 * surface for the reservation-edit engine, and dry-run card resolution.
 *
 * Capture doctrine (plan §7):
 *  - `captureCardFromDeposit` NEVER throws and NEVER fails a booking — every
 *    call site additionally wraps it, and every failure leaves a durable
 *    pending row the card-vault-sweep cron retries.
 *  - CreateCard uses the captured *payment id* as source_id (never re-uses the
 *    single-use nonce — lesson 2026-06-18) with key `cof-${baseKey}` (20
 *    chars; Square's CreateCard idempotency cap is 45 — lesson 2026-06-20).
 *  - Wallet tokens are NOT storable as cards: skipped by client sourceKind AND
 *    double-checked server-side via the payment's card_details.
 */
import { squareErrorDetail, squareFetch } from "~/features/account/data/square-client";
import { fetchSavedCards } from "~/features/account/data/customers";
import { saveCardOnFile } from "~/features/account/data/cards";
import type { SavedCard } from "~/features/account/types";
import { SquarePaymentError } from "@/lib/square-gift-card";
import { FRIENDLY_PAYMENT_ERRORS } from "~/features/booking/service/deposit";
import {
  getCardForCustomer,
  getCardStatusForReservation,
  recordCaptureFailure,
  upsertCapturedCard,
} from "./data";
import type {
  CaptureCardParams,
  CaptureCardResult,
  ChargeSavedCardParams,
  ChargeSavedCardResult,
  ChargeableCard,
} from "./types";

const IDEMPOTENCY_KEY_MAX = 45;

interface SquarePaymentCard {
  card_brand?: string;
  last_4?: string;
  exp_month?: number;
  exp_year?: number;
  fingerprint?: string;
}

interface SquarePaymentResponse {
  payment?: {
    id?: string;
    status?: string;
    card_details?: { card?: SquarePaymentCard };
  };
  errors?: Array<{ code?: string; detail?: string }>;
}

/** Dedupe: fingerprint when both sides have one, else brand+last4+exp. */
const matchSavedCard = (
  saved: SavedCard[],
  paymentCard: SquarePaymentCard,
): SavedCard | undefined => {
  if (paymentCard.fingerprint) {
    const byFp = saved.find((c) => c.fingerprint && c.fingerprint === paymentCard.fingerprint);
    if (byFp) return byFp;
  }
  return saved.find(
    (c) =>
      (c.brand || "").toUpperCase() === (paymentCard.card_brand || "").toUpperCase() &&
      c.last4 === (paymentCard.last_4 || "") &&
      c.expMonth === (paymentCard.exp_month ?? 0) &&
      c.expYear === (paymentCard.exp_year ?? 0),
  );
};

/**
 * Silently capture the deposit card onto the Square customer + record
 * provenance in `reservation_saved_cards`. Never throws (plan §7 steps 1–5):
 *  1. Skip non-card sources (wallet / gift-card-only / untagged legacy
 *     clients). `sourceKind === "saved"` records a `we_added=false,
 *     consent_source='preexisting'` row (the card already lived on file).
 *  2. GET /payments/{id} → card_details.card (brand/last4/exp/fingerprint) —
 *     also the server-side wallet double-check (no storable card → skip).
 *  3. Dedupe against the customer's live saved cards → existing-card row
 *     (`we_added=false`, never auto-disabled).
 *  4. No match → CreateCard from the payment id, key `cof-${baseKey}`.
 *  5. Any failure → recordCaptureFailure row; the sweep retries (≤5).
 */
export const captureCardFromDeposit = async (
  params: CaptureCardParams,
): Promise<CaptureCardResult> => {
  const { paymentId, squareCustomerId, sourceKind } = params;
  try {
    if (!paymentId) return { ok: true, skipped: "no_payment_id" };
    if (!squareCustomerId) return { ok: true, skipped: "no_square_customer" };
    // Untagged (stale client bundle) is treated as unknown — never guess a
    // wallet token into CreateCard. Tagged non-card sources are skipped too;
    // "saved" continues (provenance row below).
    if (!sourceKind) return { ok: true, skipped: "no_source_kind" };
    if (sourceKind === "wallet" || sourceKind === "gift_card") {
      return { ok: true, skipped: `source_kind_${sourceKind}` };
    }

    const failureCtx = {
      squareCustomerId,
      sourceReservationId: params.reservationId,
      sourceDepositOrderId: params.depositOrderId ?? null,
      sourcePaymentId: paymentId,
      permanentConsent: params.permanentConsent,
      consentSource: params.permanentConsent ? ("checkout_optin" as const) : null,
    };

    // Persist-first: durable pending anchor BEFORE any Square write, so a
    // crash mid-capture never loses the guest's consent / provenance — the
    // sweep re-runs this capture from the row (lesson 2026-06-21).
    await upsertCapturedCard({
      squareCustomerId,
      squareCardId: null,
      sourceReservationId: params.reservationId,
      sourceDepositOrderId: params.depositOrderId ?? null,
      sourcePaymentId: paymentId,
      weAdded: sourceKind !== "saved",
      permanentConsent: params.permanentConsent,
      consentSource:
        sourceKind === "saved" ? "preexisting" : params.permanentConsent ? "checkout_optin" : null,
    });

    // 2. Payment facts — the card the guest actually paid with.
    const payRes = await squareFetch<SquarePaymentResponse>(
      `/payments/${encodeURIComponent(paymentId)}`,
    );
    if (!payRes.ok) {
      const error = `payment fetch failed: ${payRes.status} ${squareErrorDetail(payRes.data)}`;
      await recordCaptureFailure({ ...failureCtx, error });
      return { ok: false, error };
    }
    const paymentCard = payRes.data.payment?.card_details?.card;
    if (!paymentCard) {
      // Gift-card-only tender / wallet double-check: nothing storable. Bump
      // the pending anchor's attempts so the sweep retires it instead of
      // re-probing this payment every hour forever.
      await recordCaptureFailure({ ...failureCtx, error: "no storable card on payment" });
      return { ok: true, skipped: "no_card_details" };
    }

    // 3. Dedupe against the customer's live cards on file.
    const saved = await fetchSavedCards(squareCustomerId);
    const existing = matchSavedCard(saved, paymentCard);

    if (existing || sourceKind === "saved") {
      await upsertCapturedCard({
        squareCustomerId,
        squareCardId: existing?.id ?? null,
        cardBrand: paymentCard.card_brand ?? existing?.brand ?? null,
        cardLast4: paymentCard.last_4 ?? existing?.last4 ?? null,
        cardExpMonth: paymentCard.exp_month ?? existing?.expMonth ?? null,
        cardExpYear: paymentCard.exp_year ?? existing?.expYear ?? null,
        fingerprint: paymentCard.fingerprint ?? null,
        sourceReservationId: params.reservationId,
        sourceDepositOrderId: params.depositOrderId ?? null,
        sourcePaymentId: paymentId,
        // The card pre-existed on the customer — not ours to auto-remove.
        weAdded: false,
        permanentConsent: params.permanentConsent,
        consentSource: "preexisting",
      });
      return { ok: true, cardId: existing?.id ?? null, deduped: true };
    }

    // 4. New card on file from the captured payment id.
    const idempotencyKey = `cof-${params.baseKey}`;
    if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
      // Square CreateCard hard-caps idempotency_key at 45 chars (lesson
      // 2026-06-20) — a malformed baseKey must fail HERE, loudly, not at Square.
      const error = `cof idempotency key too long (${idempotencyKey.length} > ${IDEMPOTENCY_KEY_MAX})`;
      await recordCaptureFailure({ ...failureCtx, error });
      return { ok: false, error };
    }

    const created = await saveCardOnFile({
      customerId: squareCustomerId,
      cardToken: paymentId,
      idempotencyKey,
    });
    if (!created.ok || !created.cardId) {
      const error = created.error ?? "CreateCard failed";
      await recordCaptureFailure({ ...failureCtx, error });
      return { ok: false, error };
    }

    await upsertCapturedCard({
      squareCustomerId,
      squareCardId: created.cardId,
      cardBrand: created.brand ?? paymentCard.card_brand ?? null,
      cardLast4: created.last4 ?? paymentCard.last_4 ?? null,
      cardExpMonth: paymentCard.exp_month ?? null,
      cardExpYear: paymentCard.exp_year ?? null,
      fingerprint: paymentCard.fingerprint ?? null,
      sourceReservationId: params.reservationId,
      sourceDepositOrderId: params.depositOrderId ?? null,
      sourcePaymentId: paymentId,
      weAdded: true,
      permanentConsent: params.permanentConsent,
      consentSource: params.permanentConsent ? "checkout_optin" : null,
    });
    return { ok: true, cardId: created.cardId, deduped: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : "card capture failed";
    console.error(
      `[card-vault] capture failed payment=${paymentId ?? "?"} res=${params.reservationId ?? "?"}:`,
      error,
    );
    try {
      if (paymentId && squareCustomerId) {
        await recordCaptureFailure({
          squareCustomerId,
          sourceReservationId: params.reservationId,
          sourceDepositOrderId: params.depositOrderId ?? null,
          sourcePaymentId: paymentId,
          permanentConsent: params.permanentConsent,
          consentSource: params.permanentConsent ? "checkout_optin" : null,
          error,
        });
      }
    } catch {
      /* the booking must survive even a double failure */
    }
    return { ok: false, error };
  }
};

interface SquareChargeResponse {
  payment?: { id?: string; status?: string };
  errors?: Array<{ code?: string; detail?: string }>;
}

/**
 * Charge a saved card (merchant-initiated, no CVV/SCA in the US market) —
 * the edit engine's settlement surface. Modeled on the group-balance-charge
 * cron's saved-card payment: source_id = card id, customer_id required,
 * autocomplete. Throws SquarePaymentError with the Square decline code and a
 * FRIENDLY_PAYMENT_ERRORS message so callers can offer the payment-link
 * fallback.
 */
export const chargeSavedCard = async (
  params: ChargeSavedCardParams,
): Promise<ChargeSavedCardResult> => {
  if (params.amountCents <= 0) {
    throw new SquarePaymentError("INVALID_AMOUNT", "Amount must be greater than zero");
  }
  if (params.idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
    throw new SquarePaymentError(
      "VALUE_TOO_LONG",
      `Payment idempotency key exceeds ${IDEMPOTENCY_KEY_MAX} chars`,
    );
  }

  const { ok, status, data } = await squareFetch<SquareChargeResponse>("/payments", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: params.idempotencyKey,
      source_id: params.cardId,
      amount_money: { amount: params.amountCents, currency: "USD" },
      ...(params.orderId ? { order_id: params.orderId } : {}),
      location_id: params.locationId,
      customer_id: params.squareCustomerId,
      autocomplete: true,
      ...(params.note ? { note: params.note.slice(0, 500) } : {}),
    }),
  });

  // Square can 200 with errors[] on an idempotency replay of a prior failure.
  const sqErr = data.errors?.[0];
  const paymentId = data.payment?.id;
  if (!ok || sqErr || !paymentId) {
    const code = sqErr?.code ?? "CHARGE_FAILED";
    const friendly =
      FRIENDLY_PAYMENT_ERRORS[code] ?? sqErr?.detail ?? "Card charge failed. Please try again.";
    throw new SquarePaymentError(code, friendly, status);
  }
  return { paymentId, status: data.payment?.status ?? "COMPLETED" };
};

/**
 * Which card an edit charge would hit — for the dry-run display AND the
 * execute step. Preference order: the vault row for THIS money group
 * (deposit order id), then the customer's newest vault row, then any live
 * saved card on the Square customer. Always cross-checked against
 * `fetchSavedCards` so a disabled/expired card is never offered.
 */
export const getChargeableCard = async (
  customerId: string,
  depositOrderId: string | null | undefined,
): Promise<ChargeableCard | null> => {
  if (!customerId) return null;
  const live = (await fetchSavedCards(customerId)).filter((c) => !c.expired);
  if (live.length === 0) return null;

  const toChargeable = (
    card: SavedCard,
    fromVault: boolean,
    permanent: boolean,
  ): ChargeableCard => ({
    cardId: card.id,
    brand: card.brand,
    last4: card.last4,
    expMonth: card.expMonth,
    expYear: card.expYear,
    fromVault,
    permanentConsent: permanent,
  });

  const groupRow = await getCardStatusForReservation(depositOrderId ?? null, customerId);
  if (groupRow?.squareCardId && !groupRow.disabledAt) {
    const match = live.find((c) => c.id === groupRow.squareCardId);
    if (match) return toChargeable(match, true, groupRow.permanentConsent);
  }

  const anyRow = await getCardForCustomer(customerId);
  if (anyRow?.squareCardId) {
    const match = live.find((c) => c.id === anyRow.squareCardId);
    if (match) return toChargeable(match, true, anyRow.permanentConsent);
  }

  return toChargeable(live[0], false, false);
};
