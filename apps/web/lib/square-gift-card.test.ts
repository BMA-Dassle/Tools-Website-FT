import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeCardPayment,
  authorizeMultiTender,
  sanitizeStatementDescriptor,
} from "./square-gift-card";

const SQUARE_BASE = "https://connect.squareup.com/v2";

interface MockCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Minimal fetch mock (same shape as deposit.test.ts) — records request bodies
 *  and replies from registered routes. */
function installFetchMock() {
  const calls: MockCall[] = [];
  const routes: Array<{
    match: (c: MockCall) => boolean;
    reply: (c: MockCall) => { status: number; body: unknown };
  }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
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
    for (const r of routes) {
      if (r.match(call)) {
        const out = r.reply(call);
        return new Response(JSON.stringify(out.body), {
          status: out.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ errors: [{ code: "NO_ROUTE", detail: url }] }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
  return {
    when: (
      match: (c: MockCall) => boolean,
      reply: (c: MockCall) => { status: number; body: unknown },
    ) => routes.push({ match, reply }),
    calls,
  };
}

beforeEach(() => {
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitizeStatementDescriptor", () => {
  it("strips disallowed chars, collapses spaces, truncates to 20", () => {
    expect(sanitizeStatementDescriptor("RACE 03928151")).toBe("RACE 03928151");
    expect(sanitizeStatementDescriptor("EVENT  Smith's Bday!!")).toBe("EVENT Smith s Bday");
    expect(sanitizeStatementDescriptor("WAY-TOO-LONG-DESCRIPTOR-1234567890")).toHaveLength(20);
    expect(sanitizeStatementDescriptor("---")).toBe("");
  });
});

describe("authorizeCardPayment — chargeback-defense fields", () => {
  it("sets buyer_email_address and statement_description_identifier when supplied", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({ status: 200, body: { payment: { id: "pay_1" } } }),
    );

    await authorizeCardPayment({
      orderId: "ord_1",
      locationId: "LOC",
      sourceId: "cnon:fake",
      amountCents: 4399,
      baseKey: "bk",
      buyerEmail: "guest@example.com",
      statementDescriptor: "RACE 03928151",
    });

    const body = mock.calls.find((c) => c.url === `${SQUARE_BASE}/payments`)!.body!;
    expect(body.buyer_email_address).toBe("guest@example.com");
    expect(body.statement_description_identifier).toBe("RACE 03928151");
  });

  it("returns card brand + last-4 parsed from the payment response", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({
        status: 200,
        body: {
          payment: { id: "pay_1", card_details: { card: { card_brand: "VISA", last_4: "6335" } } },
        },
      }),
    );

    const res = await authorizeCardPayment({
      orderId: "ord_1",
      locationId: "LOC",
      sourceId: "cnon:fake",
      amountCents: 4399,
      baseKey: "bk",
    });

    expect(res.cardBrand).toBe("VISA");
    expect(res.cardLast4).toBe("6335");
  });

  it("returns null card details when the response omits card_details", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({ status: 200, body: { payment: { id: "pay_1" } } }),
    );

    const res = await authorizeCardPayment({
      orderId: "ord_1",
      locationId: "LOC",
      sourceId: "cnon:fake",
      amountCents: 4399,
      baseKey: "bk",
    });

    expect(res.cardBrand).toBeNull();
    expect(res.cardLast4).toBeNull();
  });

  it("omits both fields when not supplied", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({ status: 200, body: { payment: { id: "pay_1" } } }),
    );

    await authorizeCardPayment({
      orderId: "ord_1",
      locationId: "LOC",
      sourceId: "cnon:fake",
      amountCents: 4399,
      baseKey: "bk",
    });

    const body = mock.calls.find((c) => c.url === `${SQUARE_BASE}/payments`)!.body!;
    expect(body.buyer_email_address).toBeUndefined();
    expect(body.statement_description_identifier).toBeUndefined();
  });
});

describe("authorizeMultiTender — forwards descriptor + email to the card auth", () => {
  it("passes statement_description_identifier + buyer_email_address through (card-only)", async () => {
    const mock = installFetchMock();
    // card auth
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({ status: 200, body: { payment: { id: "pay_card" } } }),
    );
    // payOrder
    mock.when(
      (c) => c.method === "POST" && c.url.includes("/orders/") && c.url.endsWith("/pay"),
      () => ({ status: 200, body: { order: { id: "ord_1" } } }),
    );

    await authorizeMultiTender({
      orderId: "ord_1",
      locationId: "LOC",
      totalCents: 4399,
      baseKey: "bk",
      cardSourceId: "cnon:fake",
      buyerEmail: "guest@example.com",
      statementDescriptor: "RACE 03928151",
    });

    const payBody = mock.calls.find((c) => c.url === `${SQUARE_BASE}/payments`)!.body!;
    expect(payBody.buyer_email_address).toBe("guest@example.com");
    expect(payBody.statement_description_identifier).toBe("RACE 03928151");
  });

  it("surfaces card brand/last-4 from the card auth in the result", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/payments`,
      () => ({
        status: 200,
        body: {
          payment: {
            id: "pay_card",
            card_details: { card: { card_brand: "MASTERCARD", last_4: "4203" } },
          },
        },
      }),
    );
    mock.when(
      (c) => c.method === "POST" && c.url.includes("/orders/") && c.url.endsWith("/pay"),
      () => ({ status: 200, body: { order: { id: "ord_1" } } }),
    );

    const res = await authorizeMultiTender({
      orderId: "ord_1",
      locationId: "LOC",
      totalCents: 4399,
      baseKey: "bk",
      cardSourceId: "cnon:fake",
    });

    expect(res.cardBrand).toBe("MASTERCARD");
    expect(res.cardLast4).toBe("4203");
  });
});
