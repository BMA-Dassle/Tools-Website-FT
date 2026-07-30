/**
 * Engine-level tests for authorizeTenders — fetch-mocked Square, no module
 * mocks, so the resolve → plan → auth → capture → unwind sequencing and the
 * PR-2 review guards (burned-key replay, smuggled gift card, tender
 * attribution) are exercised for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SquarePaymentError, authorizeTenders } from "@/lib/square-gift-card";

const SQUARE_BASE = "https://connect.squareup.com/v2";

interface MockCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function installFetchMock() {
  const calls: MockCall[] = [];
  const routes: Array<{
    match: (c: MockCall) => boolean;
    handler: (c: MockCall) => { status: number; body: unknown };
  }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    const call: MockCall = { url, method, body };
    calls.push(call);
    for (const route of routes) {
      if (route.match(call)) {
        const r = route.handler(call);
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
    }
    return new Response(JSON.stringify({ errors: [{ code: "NO_ROUTE", detail: url }] }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
  return {
    when: (
      match: (c: MockCall) => boolean,
      handler: (c: MockCall) => { status: number; body: unknown },
    ) => routes.push({ match, handler }),
    calls,
  };
}

const giftCardBody = (id: string, gan: string, balance: number) => ({
  gift_card: { id, gan, state: "ACTIVE", balance_money: { amount: balance } },
});
const paymentBody = (
  id: string,
  opts: { status?: string; sourceType?: string; cardBrand?: string } = {},
) => ({
  payment: {
    id,
    status: opts.status ?? "APPROVED",
    source_type: opts.sourceType ?? "CARD",
    ...(opts.cardBrand ? { card_details: { card: { card_brand: opts.cardBrand } } } : {}),
  },
});

const BASE = {
  orderId: "ord_1",
  locationId: "LAB52GY480CJF",
  totalCents: 5_000,
  baseKey: "0123456789abcdef",
};

beforeEach(() => {
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
});

describe("authorizeTenders — happy path", () => {
  it("resolves GCs, auths sequentially with attempt-salted keys, captures via salted PayOrder", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards/gftc:g1`,
      () => ({ status: 200, body: giftCardBody("gftc:g1", "7783300000001234", 2_000) }),
    );
    let payN = 0;
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({ status: 200, body: paymentBody(`pay_${++payN}`) }),
    );
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/orders/ord_1/pay`,
      () => ({ status: 200, body: { order: { state: "COMPLETED" } } }),
    );

    const res = await authorizeTenders({
      ...BASE,
      attempt: 3,
      giftCards: [{ giftCardId: "gftc:g1" }],
      cards: [{ sourceId: "cnon:c1" }],
    });

    expect(res.tenders).toEqual([
      { index: 0, kind: "gift_card", paymentId: "pay_1", amountCents: 2_000, ganLast4: "1234" },
      { index: 1, kind: "card", paymentId: "pay_2", amountCents: 3_000 },
    ]);

    const payCalls = mock.calls.filter(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
    );
    // GC charged by gftc: id for the exact planned amount, key attempt-salted.
    expect(payCalls[0].body!.source_id).toBe("gftc:g1");
    expect((payCalls[0].body!.amount_money as { amount: number }).amount).toBe(2_000);
    expect(String(payCalls[0].body!.idempotency_key)).toMatch(/^pay-gc-.*-0-.*-a3$/);
    expect(payCalls[0].body!.autocomplete).toBe(false);
    expect(String(payCalls[1].body!.idempotency_key)).toMatch(/^pay-card-.*-0-.*-a3$/);

    const payOrderCall = mock.calls.find((c) => c.url === `${SQUARE_BASE}/orders/ord_1/pay`);
    expect(String(payOrderCall!.body!.idempotency_key)).toMatch(/^payord2-/);
    expect(payOrderCall!.body!.payment_ids).toEqual(["pay_1", "pay_2"]);
  });
});

describe("authorizeTenders — unwind + guards", () => {
  it("cancels every prior auth when a later card declines, and attributes the failure", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards/gftc:g1`,
      () => ({ status: 200, body: giftCardBody("gftc:g1", "7783300000009999", 2_000) }),
    );
    mock.when(
      (c) =>
        c.method === "POST" &&
        c.url === `${SQUARE_BASE}/payments` &&
        c.body?.source_id === "gftc:g1",
      () => ({ status: 200, body: paymentBody("pay_gc") }),
    );
    mock.when(
      (c) =>
        c.method === "POST" &&
        c.url === `${SQUARE_BASE}/payments` &&
        c.body?.source_id === "cnon:declined",
      () => ({ status: 402, body: { errors: [{ code: "GENERIC_DECLINE", detail: "nope" }] } }),
    );
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments/pay_gc/cancel`,
      () => ({ status: 200, body: {} }),
    );

    let caught: SquarePaymentError | undefined;
    try {
      await authorizeTenders({
        ...BASE,
        giftCards: [{ giftCardId: "gftc:g1" }],
        cards: [{ sourceId: "cnon:declined" }],
      });
    } catch (e) {
      caught = e as SquarePaymentError;
    }
    expect(caught?.code).toBe("GENERIC_DECLINE");
    expect(caught?.failedTender).toEqual({ index: 1, kind: "card" });

    const cancel = mock.calls.find((c) => c.url === `${SQUARE_BASE}/payments/pay_gc/cancel`);
    expect(cancel).toBeTruthy();
    expect(String(cancel!.body!.idempotency_key)).toMatch(/^cxl-/);
    // No capture attempted.
    expect(mock.calls.some((c) => c.url.endsWith("/pay"))).toBe(false);
  });

  it("rejects a replayed CANCELED payment (burned key) instead of capturing a dead auth", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards/gftc:g1`,
      () => ({ status: 200, body: giftCardBody("gftc:g1", "7783300000001111", 5_000) }),
    );
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({ status: 200, body: paymentBody("pay_dead", { status: "CANCELED" }) }),
    );

    await expect(
      authorizeTenders({ ...BASE, giftCards: [{ giftCardId: "gftc:g1" }], cards: [] }),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_APPROVED" });
  });

  it("voids and rejects a gift card smuggled into a card slot", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({
        status: 200,
        body: paymentBody("pay_smuggled", { sourceType: "GIFT_CARD" }),
      }),
    );
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments/pay_smuggled/cancel`,
      () => ({ status: 200, body: {} }),
    );

    await expect(
      authorizeTenders({ ...BASE, giftCards: [], cards: [{ sourceId: "cnon:gc-in-disguise" }] }),
    ).rejects.toMatchObject({ code: "CARD_SLOT_GIFT_CARD" });
    // The smuggled auth was voided by the unwind.
    expect(mock.calls.some((c) => c.url === `${SQUARE_BASE}/payments/pay_smuggled/cancel`)).toBe(
      true,
    );
  });

  it("blocks an internal deposit GAN presented as a gift card", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards/gftc:dep`,
      () => ({ status: 200, body: giftCardBody("gftc:dep", "WEBFT12345678", 5_000) }),
    );
    await expect(
      authorizeTenders({ ...BASE, giftCards: [{ giftCardId: "gftc:dep" }], cards: [] }),
    ).rejects.toMatchObject({ code: "GIFT_CARD_BLOCKED" });
    // Nothing was ever authorized.
    expect(mock.calls.some((c) => c.url === `${SQUARE_BASE}/payments`)).toBe(false);
  });

  it("dedups two tokens resolving to the SAME gift card", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards/gftc:same`,
      () => ({ status: 200, body: giftCardBody("gftc:same", "7783300000002222", 1_000) }),
    );
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/gift-cards/from-nonce`,
      () => ({ status: 200, body: giftCardBody("gftc:same", "7783300000002222", 1_000) }),
    );
    await expect(
      authorizeTenders({
        ...BASE,
        giftCards: [{ giftCardId: "gftc:same" }, { nonce: "gcnon:same-card" }],
        cards: [{ sourceId: "cnon:c" }],
      }),
    ).rejects.toMatchObject({ code: "GIFT_CARD_DUPLICATE" });
  });

  it("cancels all auths when PayOrder succeeds but the order is not COMPLETED", async () => {
    const mock = installFetchMock();
    let payN = 0;
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({ status: 200, body: paymentBody(`pay_${++payN}`) }),
    );
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/orders/ord_1/pay`,
      () => ({ status: 200, body: { order: { state: "OPEN" } } }),
    );
    mock.when(
      (c) => c.method === "POST" && /\/payments\/pay_\d+\/cancel$/.test(c.url),
      () => ({ status: 200, body: {} }),
    );

    await expect(
      authorizeTenders({ ...BASE, giftCards: [], cards: [{ sourceId: "cnon:c1" }] }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_COMPLETED" });
    expect(mock.calls.some((c) => /\/payments\/pay_1\/cancel$/.test(c.url))).toBe(true);
  });
});
