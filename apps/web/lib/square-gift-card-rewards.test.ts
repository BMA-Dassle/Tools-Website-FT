import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetLoyaltyProgramCache,
  appendCustomerNote,
  creditLoyaltyPoints,
  ensureLoyaltyEnrollment,
  findLoyaltyAccount,
  mintDigitalGiftCard,
  SquarePaymentError,
} from "./square-gift-card";

const SQUARE_BASE = "https://connect.squareup.com/v2";

interface MockCall {
  url: string;
  method: string;
  body: unknown;
}

type RouteHandler = (call: MockCall) => { status: number; body: unknown };

function installFetchMock() {
  const calls: MockCall[] = [];
  const routes: Array<{ match: (c: MockCall) => boolean; handler: RouteHandler }> = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    const raw = init?.body;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const call: MockCall = { url, method, body };
    calls.push(call);

    for (const route of routes) {
      if (route.match(call)) {
        const r = route.handler(call);
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  }) as unknown as typeof fetch;

  return {
    when: (match: (c: MockCall) => boolean, handler: RouteHandler) => {
      routes.push({ match, handler });
    },
    calls,
  };
}

beforeEach(() => {
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
  _resetLoyaltyProgramCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mintDigitalGiftCard", () => {
  it("creates a DIGITAL gift card and activates it with the load amount", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards` && c.method === "POST",
      () => ({ status: 200, body: { gift_card: { id: "gc_1", gan: "7777111122223333" } } }),
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards/gc_1/activities` && c.method === "POST",
      () => ({ status: 200, body: { gift_card_activity: { id: "act_1" } } }),
    );

    const result = await mintDigitalGiftCard({
      locationId: "LOC_TEST",
      amountCents: 500,
      baseKey: "abc123",
    });

    expect(result).toEqual({
      giftCardId: "gc_1",
      gan: "7777111122223333",
      balanceCents: 500,
    });

    const createCall = mock.calls.find((c) => c.url.endsWith("/gift-cards"))!;
    expect(createCall.body).toMatchObject({
      idempotency_key: "gc-mint-abc123",
      location_id: "LOC_TEST",
      gift_card: { type: "DIGITAL" },
    });

    const actCall = mock.calls.find((c) => c.url.includes("/gift-cards/gc_1/activities"))!;
    expect(actCall.body).toMatchObject({
      idempotency_key: "gc-act-abc123",
      gift_card_activity: {
        type: "ACTIVATE",
        location_id: "LOC_TEST",
        gift_card_id: "gc_1",
        activate_activity_details: {
          amount_money: { amount: 500, currency: "USD" },
        },
      },
    });
  });

  it("throws SquarePaymentError on create failure", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards`,
      () => ({
        status: 400,
        body: { errors: [{ code: "INVALID_REQUEST_ERROR", detail: "nope" }] },
      }),
    );

    await expect(
      mintDigitalGiftCard({ locationId: "LOC", amountCents: 500, baseKey: "x" }),
    ).rejects.toBeInstanceOf(SquarePaymentError);
  });

  it("throws on missing id or gan from create", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards`,
      () => ({ status: 200, body: { gift_card: {} } }),
    );
    await expect(
      mintDigitalGiftCard({ locationId: "LOC", amountCents: 500, baseKey: "x" }),
    ).rejects.toMatchObject({ code: "GIFT_CARD_CREATE_INCOMPLETE" });
  });

  it("throws on activation failure", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/gift-cards` && c.method === "POST",
      () => ({ status: 200, body: { gift_card: { id: "gc_1", gan: "1234" } } }),
    );
    mock.when(
      (c) => c.url.includes("/activities"),
      () => ({ status: 422, body: { errors: [{ code: "LOAD_FAILED", detail: "x" }] } }),
    );
    await expect(
      mintDigitalGiftCard({ locationId: "LOC", amountCents: 500, baseKey: "x" }),
    ).rejects.toMatchObject({ code: "LOAD_FAILED" });
  });
});

describe("findLoyaltyAccount", () => {
  it("returns null when no account exists for the customer", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/search`,
      () => ({ status: 200, body: { loyalty_accounts: [] } }),
    );
    const result = await findLoyaltyAccount("CUS_NEW");
    expect(result).toBeNull();
  });

  it("returns the first account when one exists", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/search`,
      () => ({
        status: 200,
        body: {
          loyalty_accounts: [
            { id: "la_1", customer_id: "CUS_1", balance: 1500, lifetime_points: 3200 },
          ],
        },
      }),
    );
    const result = await findLoyaltyAccount("CUS_1");
    expect(result).toEqual({
      accountId: "la_1",
      customerId: "CUS_1",
      balance: 1500,
      lifetimePoints: 3200,
    });
  });

  it("throws SquarePaymentError on 5xx", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/search`,
      () => ({ status: 500, body: { errors: [{ code: "INTERNAL", detail: "boom" }] } }),
    );
    await expect(findLoyaltyAccount("CUS_1")).rejects.toBeInstanceOf(SquarePaymentError);
  });
});

describe("ensureLoyaltyEnrollment", () => {
  it("returns the existing account without enrolling", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/search`,
      () => ({
        status: 200,
        body: {
          loyalty_accounts: [
            { id: "la_existing", customer_id: "CUS_1", balance: 500, lifetime_points: 1000 },
          ],
        },
      }),
    );

    const result = await ensureLoyaltyEnrollment({
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      baseKey: "x",
    });

    expect(result.accountId).toBe("la_existing");
    // No enrollment call should have fired
    expect(mock.calls.some((c) => c.url === `${SQUARE_BASE}/loyalty/accounts`)).toBe(false);
  });

  it("enrolls when no account exists", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/search`,
      () => ({ status: 200, body: { loyalty_accounts: [] } }),
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/programs/main`,
      () => ({ status: 200, body: { program: { id: "prog_1" } } }),
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts` && c.method === "POST",
      () => ({
        status: 200,
        body: {
          loyalty_account: { id: "la_new", customer_id: "CUS_1", balance: 0, lifetime_points: 0 },
        },
      }),
    );

    const result = await ensureLoyaltyEnrollment({
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      baseKey: "abc",
    });

    expect(result.accountId).toBe("la_new");
    const enrollCall = mock.calls.find(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts` && c.method === "POST",
    )!;
    expect(enrollCall.body).toMatchObject({
      idempotency_key: "loy-enroll-abc",
      loyalty_account: {
        program_id: "prog_1",
        mapping: { phone_number: "+15551234567" },
      },
    });
  });

  it("caches the program id across calls within the TTL", async () => {
    const mock = installFetchMock();
    let searchCalls = 0;
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/search`,
      () => {
        searchCalls += 1;
        return { status: 200, body: { loyalty_accounts: [] } };
      },
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/programs/main`,
      () => ({ status: 200, body: { program: { id: "prog_1" } } }),
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts` && c.method === "POST",
      () => ({ status: 200, body: { loyalty_account: { id: "la", customer_id: "CUS" } } }),
    );

    await ensureLoyaltyEnrollment({
      customerId: "CUS_1",
      phoneE164: "+15551234567",
      baseKey: "a",
    });
    await ensureLoyaltyEnrollment({
      customerId: "CUS_2",
      phoneE164: "+15552223333",
      baseKey: "b",
    });

    const programCalls = mock.calls.filter((c) => c.url === `${SQUARE_BASE}/loyalty/programs/main`);
    expect(programCalls).toHaveLength(1); // cached
    expect(searchCalls).toBe(2);
  });
});

describe("creditLoyaltyPoints", () => {
  it("posts adjust_points with the supplied reason and returns event + balance", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/la_1/adjust` && c.method === "POST",
      () => ({ status: 200, body: { event: { id: "evt_1", loyalty_account_id: "la_1" } } }),
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/la_1` && c.method === "GET",
      () => ({ status: 200, body: { loyalty_account: { balance: 1500 } } }),
    );

    const result = await creditLoyaltyPoints({
      accountId: "la_1",
      points: 500,
      reason: "Guest Survey Reward",
      baseKey: "abc",
    });

    expect(result).toEqual({ eventId: "evt_1", newBalance: 1500 });

    const adjustCall = mock.calls.find((c) => c.url.endsWith("/adjust"))!;
    expect(adjustCall.body).toMatchObject({
      idempotency_key: "loy-adj-abc",
      adjust_points: { points: 500, reason: "Guest Survey Reward" },
    });
  });

  it("rejects non-positive point amounts", async () => {
    await expect(
      creditLoyaltyPoints({ accountId: "la", points: 0, reason: "x", baseKey: "k" }),
    ).rejects.toMatchObject({ code: "LOYALTY_INVALID_POINTS" });
    await expect(
      creditLoyaltyPoints({ accountId: "la", points: -5, reason: "x", baseKey: "k" }),
    ).rejects.toMatchObject({ code: "LOYALTY_INVALID_POINTS" });
  });

  it("treats balance fetch failure as non-fatal (returns 0 newBalance)", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url.endsWith("/adjust"),
      () => ({ status: 200, body: { event: { id: "evt_1" } } }),
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/loyalty/accounts/la_1` && c.method === "GET",
      () => ({ status: 500, body: { error: "boom" } }),
    );
    const result = await creditLoyaltyPoints({
      accountId: "la_1",
      points: 500,
      reason: "test",
      baseKey: "k",
    });
    expect(result.eventId).toBe("evt_1");
    expect(result.newBalance).toBe(0);
  });

  it("throws on adjust failure", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url.endsWith("/adjust"),
      () => ({ status: 400, body: { errors: [{ code: "BAD_REQUEST", detail: "x" }] } }),
    );
    await expect(
      creditLoyaltyPoints({ accountId: "la_1", points: 500, reason: "test", baseKey: "k" }),
    ).rejects.toBeInstanceOf(SquarePaymentError);
  });
});

describe("appendCustomerNote", () => {
  it("prepends the new line above existing note content", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/customers/CUS_1` && c.method === "GET",
      () => ({ status: 200, body: { customer: { note: "[2026-05-19] previous entry" } } }),
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/customers/CUS_1` && c.method === "PUT",
      () => ({ status: 200, body: {} }),
    );

    await appendCustomerNote({ customerId: "CUS_1", line: "[2026-05-20] new entry" });

    const putCall = mock.calls.find((c) => c.method === "PUT")!;
    expect(putCall.body).toEqual({
      note: "[2026-05-20] new entry\n[2026-05-19] previous entry",
    });
  });

  it("writes the line standalone when no existing note", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/customers/CUS_1` && c.method === "GET",
      () => ({ status: 200, body: { customer: {} } }),
    );
    mock.when(
      (c) => c.url === `${SQUARE_BASE}/customers/CUS_1` && c.method === "PUT",
      () => ({ status: 200, body: {} }),
    );

    await appendCustomerNote({ customerId: "CUS_1", line: "first" });
    const putCall = mock.calls.find((c) => c.method === "PUT")!;
    expect(putCall.body).toEqual({ note: "first" });
  });

  it("throws when GET fails", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.method === "GET",
      () => ({ status: 404, body: {} }),
    );
    await expect(appendCustomerNote({ customerId: "X", line: "y" })).rejects.toMatchObject({
      code: "CUSTOMER_GET_FAILED",
    });
  });
});
