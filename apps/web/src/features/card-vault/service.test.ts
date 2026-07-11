import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSquareMock, type SquareMockHandle } from "~/test/mocks/square";
import { SquarePaymentError } from "@/lib/square-gift-card";

const data = vi.hoisted(() => ({
  upsertCapturedCard: vi.fn(),
  recordCaptureFailure: vi.fn(),
  getCardForCustomer: vi.fn(),
  getCardStatusForReservation: vi.fn(),
}));
vi.mock("./data", () => data);

import { captureCardFromDeposit, chargeSavedCard, getChargeableCard } from "./service";

const BASE_KEY = "26ad0266ecd84a73"; // 16 hex chars — the reserve base key shape
const CUSTOMER = "CUS_1";
const PAYMENT = "PAY_abc123";

const captureParams = (partial: Partial<Parameters<typeof captureCardFromDeposit>[0]> = {}) => ({
  squareCustomerId: CUSTOMER,
  paymentId: PAYMENT,
  reservationId: 4211,
  depositOrderId: "DEP_ORDER_1",
  baseKey: BASE_KEY,
  sourceKind: "card" as const,
  permanentConsent: false,
  ...partial,
});

const paymentWithCard = (card: Record<string, unknown> | undefined) => ({
  payment: { id: PAYMENT, status: "COMPLETED", card_details: card ? { card } : {} },
});

const visa = {
  card_brand: "VISA",
  last_4: "4242",
  exp_month: 12,
  exp_year: 2028,
  fingerprint: "fp_1",
};

let sq: SquareMockHandle;

/** All POST /v2/cards calls this test issued (a fresh onCardCreate() route
 *  would always be empty — assert against the global capture instead). */
const cardCreateCalls = () =>
  sq.allCalls().filter((c) => c.method === "POST" && c.url.endsWith("/v2/cards"));

beforeEach(() => {
  vi.clearAllMocks();
  sq = installSquareMock();
  data.upsertCapturedCard.mockResolvedValue(undefined);
  data.recordCaptureFailure.mockResolvedValue(undefined);
});

describe("captureCardFromDeposit — skip matrix", () => {
  it("skips wallet sources without touching Square or Neon", async () => {
    const result = await captureCardFromDeposit(captureParams({ sourceKind: "wallet" }));
    expect(result).toEqual({ ok: true, skipped: "source_kind_wallet" });
    expect(sq.allCalls()).toHaveLength(0);
    expect(data.upsertCapturedCard).not.toHaveBeenCalled();
    expect(data.recordCaptureFailure).not.toHaveBeenCalled();
  });

  it("skips gift-card-only tenders", async () => {
    const result = await captureCardFromDeposit(captureParams({ sourceKind: "gift_card" }));
    expect(result).toEqual({ ok: true, skipped: "source_kind_gift_card" });
    expect(sq.allCalls()).toHaveLength(0);
  });

  it("skips when there is no payment id ($0 / free bookings)", async () => {
    const result = await captureCardFromDeposit(captureParams({ paymentId: null }));
    expect(result).toEqual({ ok: true, skipped: "no_payment_id" });
    expect(sq.allCalls()).toHaveLength(0);
  });

  it("skips untagged sources (stale client) — never guesses a wallet into CreateCard", async () => {
    const result = await captureCardFromDeposit(captureParams({ sourceKind: undefined }));
    expect(result).toEqual({ ok: true, skipped: "no_source_kind" });
    expect(sq.allCalls()).toHaveLength(0);
  });

  it("skips when the payment carries no storable card (server-side wallet double-check)", async () => {
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard(undefined));
    const result = await captureCardFromDeposit(captureParams({ sourceKind: "card" }));
    expect(result).toEqual({ ok: true, skipped: "no_card_details" });
    // No CreateCard happened…
    expect(cardCreateCalls()).toHaveLength(0);
    // …and the pending anchor's attempts were bumped so the sweep retires it.
    expect(data.recordCaptureFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("no storable card") }),
    );
  });

  it("saved-card checkout records a we_added=false / preexisting row (no CreateCard)", async () => {
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard(visa));
    sq.onCardsList().reply({
      cards: [
        {
          id: "ccof:EXISTING",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2028,
          enabled: true,
          fingerprint: "fp_1",
        },
      ],
    });

    const result = await captureCardFromDeposit(captureParams({ sourceKind: "saved" }));
    expect(result).toEqual({ ok: true, cardId: "ccof:EXISTING", deduped: true });
    expect(cardCreateCalls()).toHaveLength(0);
    expect(data.upsertCapturedCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        squareCardId: "ccof:EXISTING",
        weAdded: false,
        consentSource: "preexisting",
        sourcePaymentId: PAYMENT,
      }),
    );
  });
});

describe("captureCardFromDeposit — dedupe", () => {
  it("matches by fingerprint when present (even if display fields differ)", async () => {
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard(visa));
    sq.onCardsList().reply({
      cards: [
        // Different last4/brand but SAME fingerprint — fingerprint wins.
        {
          id: "ccof:FP_MATCH",
          card_brand: "MASTERCARD",
          last_4: "9999",
          exp_month: 1,
          exp_year: 2030,
          enabled: true,
          fingerprint: "fp_1",
        },
      ],
    });

    const result = await captureCardFromDeposit(captureParams());
    expect(result).toEqual({ ok: true, cardId: "ccof:FP_MATCH", deduped: true });
    expect(cardCreateCalls()).toHaveLength(0);
    expect(data.upsertCapturedCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ weAdded: false, squareCardId: "ccof:FP_MATCH" }),
    );
  });

  it("falls back to brand+last4+exp when the payment card has no fingerprint (A2)", async () => {
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard({ ...visa, fingerprint: undefined }));
    sq.onCardsList().reply({
      cards: [
        {
          id: "ccof:OTHER",
          card_brand: "VISA",
          last_4: "1111",
          exp_month: 12,
          exp_year: 2028,
          enabled: true,
        },
        {
          id: "ccof:FALLBACK",
          card_brand: "VISA",
          last_4: "4242",
          exp_month: 12,
          exp_year: 2028,
          enabled: true,
        },
      ],
    });

    const result = await captureCardFromDeposit(captureParams());
    expect(result).toEqual({ ok: true, cardId: "ccof:FALLBACK", deduped: true });
    expect(cardCreateCalls()).toHaveLength(0);
  });
});

describe("captureCardFromDeposit — new card", () => {
  it("CreateCard from the payment id with key cof-<16hex> (≤45 chars)", async () => {
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard(visa));
    sq.onCardsList().reply({ cards: [] });
    const create = sq
      .onCardCreate()
      .reply({ card: { id: "ccof:NEW", card_brand: "VISA", last_4: "4242" } });

    const result = await captureCardFromDeposit(captureParams({ permanentConsent: true }));
    expect(result).toEqual({ ok: true, cardId: "ccof:NEW", deduped: false });

    expect(create.calls()).toHaveLength(1);
    const body = create.calls()[0].body as {
      idempotency_key: string;
      source_id: string;
      card: { customer_id: string };
    };
    expect(body.idempotency_key).toBe(`cof-${BASE_KEY}`);
    expect(body.idempotency_key).toMatch(/^cof-[0-9a-f]{16}$/);
    expect(body.idempotency_key.length).toBeLessThanOrEqual(45);
    expect(body.source_id).toBe(PAYMENT); // payment id, NEVER the spent nonce
    expect(body.card.customer_id).toBe(CUSTOMER);

    expect(data.upsertCapturedCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        squareCardId: "ccof:NEW",
        weAdded: true,
        permanentConsent: true,
        consentSource: "checkout_optin",
        fingerprint: "fp_1",
      }),
    );
  });

  it("silent capture (no opt-in) records permanentConsent=false with no consent source", async () => {
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard(visa));
    sq.onCardsList().reply({ cards: [] });
    sq.onCardCreate().reply({ card: { id: "ccof:NEW", card_brand: "VISA", last_4: "4242" } });

    await captureCardFromDeposit(captureParams({ permanentConsent: false }));
    expect(data.upsertCapturedCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ permanentConsent: false, consentSource: null, weAdded: true }),
    );
  });

  it("rejects an over-length idempotency key BEFORE calling Square (45-char cap)", async () => {
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard(visa));
    sq.onCardsList().reply({ cards: [] });
    const create = sq.onCardCreate();

    const result = await captureCardFromDeposit(captureParams({ baseKey: "x".repeat(60) }));
    expect(result.ok).toBe(false);
    expect(create.calls()).toHaveLength(0);
    expect(data.recordCaptureFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("too long") }),
    );
  });

  it("CreateCard failure → recordCaptureFailure + {ok:false}, NEVER throws", async () => {
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard(visa));
    sq.onCardsList().reply({ cards: [] });
    sq.onCardCreate().replyError(400, {
      errors: [{ code: "INVALID_CARD_DATA", detail: "Card cannot be stored" }],
    });

    // Must resolve (not reject) — a capture failure can never fail a booking.
    const result = await captureCardFromDeposit(captureParams());
    expect(result.ok).toBe(false);
    expect(data.recordCaptureFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        squareCustomerId: CUSTOMER,
        sourcePaymentId: PAYMENT,
        sourceReservationId: 4211,
        error: expect.stringContaining("Card cannot be stored"),
      }),
    );
  });

  it("payment fetch failure → recordCaptureFailure + {ok:false}, no throw", async () => {
    sq.onPaymentGet(PAYMENT).replyError(500, { errors: [{ code: "INTERNAL", detail: "boom" }] });
    const result = await captureCardFromDeposit(captureParams());
    expect(result.ok).toBe(false);
    expect(data.recordCaptureFailure).toHaveBeenCalled();
  });

  it("even a Neon write failure resolves {ok:false} (belt-and-braces catch)", async () => {
    data.upsertCapturedCard.mockRejectedValue(new Error("neon down"));
    sq.onPaymentGet(PAYMENT).reply(paymentWithCard(visa));
    const result = await captureCardFromDeposit(captureParams());
    expect(result).toEqual({ ok: false, error: "neon down" });
  });
});

describe("chargeSavedCard", () => {
  const chargeParams = {
    squareCustomerId: CUSTOMER,
    cardId: "ccof:CARD_1",
    amountCents: 2500,
    locationId: "LOC_1",
    orderId: "ORDER_1",
    note: "Reservation Edit — additional deposit",
    idempotencyKey: "edit-4211-a1-topup-pay",
  };

  it("happy path: POST /payments carries customer_id + autocomplete + card source", async () => {
    const create = sq
      .onPaymentCreate()
      .reply({ payment: { id: "PAY_EDIT_1", status: "COMPLETED" } });

    const result = await chargeSavedCard(chargeParams);
    expect(result).toEqual({ paymentId: "PAY_EDIT_1", status: "COMPLETED" });

    const body = create.calls()[0].body as Record<string, unknown>;
    expect(body.source_id).toBe("ccof:CARD_1");
    expect(body.customer_id).toBe(CUSTOMER); // required for COF charges
    expect(body.autocomplete).toBe(true);
    expect(body.order_id).toBe("ORDER_1");
    expect(body.location_id).toBe("LOC_1");
    expect(body.amount_money).toEqual({ amount: 2500, currency: "USD" });
    expect(body.idempotency_key).toBe("edit-4211-a1-topup-pay");
  });

  it("decline → SquarePaymentError with the Square code and a friendly message", async () => {
    sq.onPaymentCreate().replyError(402, {
      errors: [{ code: "INSUFFICIENT_FUNDS", detail: "Card has insufficient funds" }],
    });

    const err = await chargeSavedCard(chargeParams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquarePaymentError);
    expect((err as SquarePaymentError).code).toBe("INSUFFICIENT_FUNDS");
    expect((err as SquarePaymentError).message).toContain("insufficient funds");
  });

  it("200-with-errors[] (idempotency replay of a failure) still throws", async () => {
    sq.onPaymentCreate().reply({
      errors: [{ code: "GENERIC_DECLINE", detail: "Declined" }],
    });
    await expect(chargeSavedCard(chargeParams)).rejects.toMatchObject({
      code: "GENERIC_DECLINE",
    });
  });

  it("guards the 45-char idempotency key cap locally", async () => {
    await expect(
      chargeSavedCard({ ...chargeParams, idempotencyKey: "k".repeat(46) }),
    ).rejects.toMatchObject({ code: "VALUE_TOO_LONG" });
    expect(sq.allCalls()).toHaveLength(0);
  });

  it("rejects non-positive amounts before touching Square", async () => {
    await expect(chargeSavedCard({ ...chargeParams, amountCents: 0 })).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    });
    expect(sq.allCalls()).toHaveLength(0);
  });
});

describe("getChargeableCard", () => {
  it("prefers the vault row for THIS deposit order when it is still live on Square", async () => {
    sq.onCardsList().reply({
      cards: [
        { id: "ccof:OTHER", card_brand: "AMEX", last_4: "0005", exp_month: 1, exp_year: 2030 },
        { id: "ccof:VAULT", card_brand: "VISA", last_4: "4242", exp_month: 12, exp_year: 2028 },
      ],
    });
    data.getCardStatusForReservation.mockResolvedValue({
      squareCardId: "ccof:VAULT",
      disabledAt: null,
      permanentConsent: true,
    });

    const card = await getChargeableCard(CUSTOMER, "DEP_ORDER_1");
    expect(card).toMatchObject({
      cardId: "ccof:VAULT",
      brand: "VISA",
      last4: "4242",
      fromVault: true,
      permanentConsent: true,
    });
  });

  it("falls back to any live saved card when the vault has nothing usable", async () => {
    sq.onCardsList().reply({
      cards: [
        { id: "ccof:LIVE", card_brand: "VISA", last_4: "1111", exp_month: 12, exp_year: 2030 },
      ],
    });
    data.getCardStatusForReservation.mockResolvedValue(null);
    data.getCardForCustomer.mockResolvedValue(null);

    const card = await getChargeableCard(CUSTOMER, "DEP_ORDER_1");
    expect(card).toMatchObject({ cardId: "ccof:LIVE", fromVault: false });
  });

  it("returns null when the customer has no live cards", async () => {
    sq.onCardsList().reply({ cards: [] });
    const card = await getChargeableCard(CUSTOMER, "DEP_ORDER_1");
    expect(card).toBeNull();
  });
});
