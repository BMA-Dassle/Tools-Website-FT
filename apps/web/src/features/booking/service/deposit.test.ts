import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the multi-tender capture so the test only exercises deposit.ts's own
// Square calls (order create, gift-card create, gift-card activate, order GET).
// Keep the real SquarePaymentError so instanceof checks still work.
vi.mock("@/lib/square-gift-card", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/square-gift-card")>();
  return { ...actual, authorizeMultiTender: vi.fn() };
});

import { authorizeMultiTender } from "@/lib/square-gift-card";
import {
  activateGiftCardForDeposit,
  createDepositAndCharge,
  getDepositOrderLineItem,
  giftCardSaleChunks,
} from "./deposit";

const SQUARE_BASE = "https://connect.squareup.com/v2";

describe("giftCardSaleChunks — $2k/card split", () => {
  it("keeps a sub-cap deposit as a single chunk", () => {
    expect(giftCardSaleChunks(4399)).toEqual([4399]);
    expect(giftCardSaleChunks(200_000)).toEqual([200_000]);
  });
  it("splits an over-cap deposit into ≤$2k chunks summing to the total", () => {
    expect(giftCardSaleChunks(250_000)).toEqual([200_000, 50_000]);
    expect(giftCardSaleChunks(400_000)).toEqual([200_000, 200_000]);
    expect(giftCardSaleChunks(450_000)).toEqual([200_000, 200_000, 50_000]);
    // #H2821 shape: $2,231.00 deposit must NOT be a single $2,231 card.
    const chunks = giftCardSaleChunks(223_100);
    expect(chunks).toEqual([200_000, 23_100]);
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(223_100);
    expect(chunks.every((c) => c <= 200_000)).toBe(true);
  });
  it("returns [] for a non-positive total", () => {
    expect(giftCardSaleChunks(0)).toEqual([]);
    expect(giftCardSaleChunks(-100)).toEqual([]);
  });
});

interface MockCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}
type RouteHandler = (call: MockCall) => { status: number; body: unknown };

function installFetchMock() {
  const calls: MockCall[] = [];
  const routes: Array<{ match: (c: MockCall) => boolean; handler: RouteHandler }> = [];

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
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ errors: [{ code: "NO_ROUTE", detail: url }] }), {
      status: 404,
    });
  }) as unknown as typeof fetch;

  return {
    when: (match: (c: MockCall) => boolean, handler: RouteHandler) =>
      routes.push({ match, handler }),
    calls,
  };
}

/** Register the happy-path routes: deposit order → gift card → activate. */
function registerHappyRoutes(
  mock: ReturnType<typeof installFetchMock>,
  opts: { activateBalanceCents?: number; activateErrors?: unknown[] } = {},
) {
  mock.when(
    (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/orders`,
    () => ({ status: 200, body: { order: { id: "ord_dep_1", line_items: [{ uid: "li_1" }] } } }),
  );
  mock.when(
    (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/gift-cards`,
    () => ({ status: 200, body: { gift_card: { id: "gftc_1", gan: "RACE12345678" } } }),
  );
  mock.when(
    (c) => c.method === "POST" && c.url === `${SQUARE_BASE}/gift-cards/activities`,
    () => ({
      status: 200,
      body: opts.activateErrors
        ? { errors: opts.activateErrors }
        : {
            gift_card_activity: {
              gift_card_balance_money: { amount: opts.activateBalanceCents ?? 4399 },
            },
          },
    }),
  );
}

const mockMultiTender = authorizeMultiTender as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
  delete process.env.DEPOSIT_GC_SALE_V2;
  mockMultiTender.mockReset();
  mockMultiTender.mockResolvedValue({
    gcPaymentId: undefined,
    cardPaymentId: "pay_card_1",
    gcApprovedCents: 0,
    cardApprovedCents: 4399,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEPOSIT_GC_SALE_V2;
});

const baseParams = {
  amountCents: 4399,
  locationId: "TXBSQN0FEKQ11",
  cardSourceId: "cnon:fake",
  ganPrefix: "RACE",
  ganSuffix: "12345678",
  note: "Deposit - RACE12345678 - 2026-06-15",
  baseKey: "testbase",
};

describe("createDepositAndCharge — flag OFF (legacy)", () => {
  it("creates a plain (non-GIFT_CARD) line item and activates with amount + instruments", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock);

    const res = await createDepositAndCharge({ ...baseParams });

    const orderCall = mock.calls.find((c) => c.url === `${SQUARE_BASE}/orders`);
    const lineItem = (orderCall!.body!.order as Record<string, unknown>).line_items as Array<
      Record<string, unknown>
    >;
    expect(lineItem[0].item_type).toBeUndefined();
    expect(lineItem[0].name).toBe("Reservation Deposit");

    const activateCall = mock.calls.find((c) => c.url === `${SQUARE_BASE}/gift-cards/activities`);
    const details = (activateCall!.body!.gift_card_activity as Record<string, unknown>)
      .activate_activity_details as Record<string, unknown>;
    expect(details.amount_money).toEqual({ amount: 4399, currency: "USD" });
    expect(details.buyer_payment_instrument_ids).toEqual(["pay_card_1"]);
    expect(details.order_id).toBeUndefined();
    expect(details.line_item_uid).toBeUndefined();

    expect(res.giftCardId).toBe("gftc_1");
    expect(res.giftCardGan).toBe("RACE12345678");
    expect(res.giftCardPending).toBeUndefined();
  });
});

describe("createDepositAndCharge — flag ON (gift-card sale)", () => {
  beforeEach(() => {
    process.env.DEPOSIT_GC_SALE_V2 = "true";
  });

  it("types the line item GIFT_CARD and activates via order_id + line_item_uid", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock);

    const res = await createDepositAndCharge({ ...baseParams });

    const orderCall = mock.calls.find((c) => c.url === `${SQUARE_BASE}/orders`);
    const lineItem = (orderCall!.body!.order as Record<string, unknown>).line_items as Array<
      Record<string, unknown>
    >;
    expect(lineItem[0].item_type).toBe("GIFT_CARD");

    const activateCall = mock.calls.find((c) => c.url === `${SQUARE_BASE}/gift-cards/activities`);
    const details = (activateCall!.body!.gift_card_activity as Record<string, unknown>)
      .activate_activity_details as Record<string, unknown>;
    expect(details.order_id).toBe("ord_dep_1");
    expect(details.line_item_uid).toBe("li_1");
    // Mutually exclusive — these MUST be absent or Square rejects the request.
    expect(details.amount_money).toBeUndefined();
    expect(details.buyer_payment_instrument_ids).toBeUndefined();

    expect(res.giftCardId).toBe("gftc_1");
    expect(res.giftCardPending).toBeUndefined();
  });

  it("keeps idempotency keys stable across the order / create / activate calls", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock);

    await createDepositAndCharge({ ...baseParams });

    const key = (url: string) => mock.calls.find((c) => c.url === url)!.body!.idempotency_key;
    expect(key(`${SQUARE_BASE}/orders`)).toBe("dep-order-testbase");
    expect(key(`${SQUARE_BASE}/gift-cards`)).toBe("gc-testbase");
    expect(key(`${SQUARE_BASE}/gift-cards/activities`)).toBe("gc-act-testbase");
  });

  it("returns giftCardPending when the order-linked activate yields a $0 balance", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock, { activateBalanceCents: 0 });

    const res = await createDepositAndCharge({ ...baseParams });

    // Card was captured (multiTender succeeded) but the card isn't funded —
    // recover-forward, never throw away the capture.
    expect(res.giftCardPending).toBe(true);
    expect(res.giftCardId).toBeNull();
    expect(res.depositPaymentId).toBe("pay_card_1");
  });

  it("returns giftCardPending when activate replies 200 with an errors array", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock, { activateErrors: [{ code: "BAD", detail: "replayed failure" }] });

    const res = await createDepositAndCharge({ ...baseParams });
    expect(res.giftCardPending).toBe(true);
    expect(res.giftCardId).toBeNull();
  });
});

describe("createDepositAndCharge — chargeback-defense params", () => {
  it("forwards buyerEmail and defaults statementDescriptor to `${ganPrefix} ${ganSuffix}`", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock);

    await createDepositAndCharge({ ...baseParams, buyerEmail: "guest@example.com" });

    const args = mockMultiTender.mock.calls[0][0];
    expect(args.buyerEmail).toBe("guest@example.com");
    expect(args.statementDescriptor).toBe("RACE 12345678");
  });

  it("honors an explicit statementDescriptor override", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock);

    await createDepositAndCharge({ ...baseParams, statementDescriptor: "FT EVENT 42" });

    expect(mockMultiTender.mock.calls[0][0].statementDescriptor).toBe("FT EVENT 42");
  });
});

describe("activateGiftCardForDeposit — body selection", () => {
  const args = {
    baseKey: "k1",
    locationId: "TXBSQN0FEKQ11",
    amountCents: 4399,
    ganPrefix: "RACE",
    ganSuffix: "12345678",
    paymentIds: ["pay_card_1"],
  };

  it("uses the legacy amount/instrument body when no order link is given", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock);
    await activateGiftCardForDeposit(args);
    const details = (
      mock.calls.find((c) => c.url === `${SQUARE_BASE}/gift-cards/activities`)!.body!
        .gift_card_activity as Record<string, unknown>
    ).activate_activity_details as Record<string, unknown>;
    expect(details.amount_money).toEqual({ amount: 4399, currency: "USD" });
    expect(details.order_id).toBeUndefined();
  });

  it("uses the order-linked body when depositOrderId + lineItemUid are given", async () => {
    const mock = installFetchMock();
    registerHappyRoutes(mock);
    await activateGiftCardForDeposit({ ...args, depositOrderId: "ord_9", lineItemUid: "li_9" });
    const details = (
      mock.calls.find((c) => c.url === `${SQUARE_BASE}/gift-cards/activities`)!.body!
        .gift_card_activity as Record<string, unknown>
    ).activate_activity_details as Record<string, unknown>;
    expect(details.order_id).toBe("ord_9");
    expect(details.line_item_uid).toBe("li_9");
    expect(details.amount_money).toBeUndefined();
  });
});

describe("getDepositOrderLineItem", () => {
  it("returns the uid + item_type of the order's first line item", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.method === "GET" && c.url === `${SQUARE_BASE}/orders/ord_dep_1`,
      () => ({
        status: 200,
        body: { order: { line_items: [{ uid: "li_1", item_type: "GIFT_CARD" }] } },
      }),
    );
    expect(await getDepositOrderLineItem("ord_dep_1")).toEqual({
      uid: "li_1",
      itemType: "GIFT_CARD",
    });
  });

  it("returns null when the order fetch fails", async () => {
    const mock = installFetchMock();
    mock.when(
      (c) => c.url.includes("/orders/"),
      () => ({ status: 404, body: { errors: [{ code: "NOT_FOUND" }] } }),
    );
    expect(await getDepositOrderLineItem("nope")).toBeNull();
  });
});
