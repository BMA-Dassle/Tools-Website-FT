import { vi, type Mock } from "vitest";

/**
 * Square API fetch mock for unit tests.
 *
 * Usage:
 *   import { installSquareMock } from "~/test/mocks/square";
 *
 *   beforeEach(() => {
 *     const sq = installSquareMock();
 *     sq.onCustomerSearch().reply({ customers: [{ id: "CUS_1", ... }] });
 *     sq.onCustomerCreate().reply({ customer: { id: "CUS_2", ... } });
 *   });
 *
 * The mock intercepts global `fetch` and routes any request whose URL matches
 * Square endpoints through programmatic responses. Non-Square fetches fall
 * through to the previous fetch implementation (or throw if none was set).
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";

interface MockResponse {
  status?: number;
  body: unknown;
}

interface RouteSpec {
  match: (url: string, init?: RequestInit) => boolean;
  /** Queue of responses — popped FIFO. Last one in the queue is reused if depleted. */
  responses: MockResponse[];
  /** Calls captured for assertions. */
  calls: Array<{ url: string; body: unknown }>;
}

export interface SquareMockHandle {
  onCustomerSearch(): RouteBuilder;
  onCustomerCreate(): RouteBuilder;
  onCustomerPatch(customerId?: string): RouteBuilder;
  onCustomerGet(customerId?: string): RouteBuilder;
  onLoyaltyAccountsSearch(): RouteBuilder;
  reset(): void;
  /** All captured calls across every Square route. */
  allCalls(): Array<{ method: string; url: string; body: unknown }>;
}

interface RouteBuilder {
  reply(body: unknown, status?: number): RouteBuilder;
  replyEmpty(): RouteBuilder;
  replyError(status: number, body?: unknown): RouteBuilder;
  calls(): Array<{ url: string; body: unknown }>;
}

function buildRoute(routes: RouteSpec[], match: RouteSpec["match"]): RouteBuilder {
  const route: RouteSpec = { match, responses: [], calls: [] };
  routes.push(route);
  const builder: RouteBuilder = {
    reply(body, status = 200) {
      route.responses.push({ status, body });
      return builder;
    },
    replyEmpty() {
      route.responses.push({ status: 200, body: {} });
      return builder;
    },
    replyError(status, body = { error: "mock error" }) {
      route.responses.push({ status, body });
      return builder;
    },
    calls() {
      return route.calls;
    },
  };
  return builder;
}

function dequeueResponse(route: RouteSpec): MockResponse {
  if (route.responses.length === 0) {
    return { status: 200, body: {} };
  }
  if (route.responses.length === 1) return route.responses[0]; // reuse the last
  return route.responses.shift() as MockResponse;
}

function makeResponse(r: MockResponse): Response {
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return new Response(body, {
    status: r.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

export function installSquareMock(): SquareMockHandle {
  const routes: RouteSpec[] = [];
  const allCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const previousFetch = globalThis.fetch as typeof fetch | undefined;

  const fetchMock: Mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body;
    let parsedBody: unknown = null;
    if (typeof rawBody === "string") {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    if (url.startsWith(SQUARE_BASE)) {
      allCalls.push({ method, url, body: parsedBody });
      for (const route of routes) {
        if (route.match(url, init)) {
          route.calls.push({ url, body: parsedBody });
          return makeResponse(dequeueResponse(route));
        }
      }
      // No route matched a Square URL — return 404 so tests fail loudly.
      return new Response(JSON.stringify({ error: "no mock route", url }), { status: 404 });
    }

    if (previousFetch) return previousFetch(input, init);
    throw new Error(`fetch called for non-Square URL with no fallback: ${url}`);
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;

  return {
    onCustomerSearch() {
      return buildRoute(routes, (url, init) => {
        return (
          url === `${SQUARE_BASE}/customers/search` &&
          (init?.method ?? "GET").toUpperCase() === "POST"
        );
      });
    },
    onCustomerCreate() {
      return buildRoute(routes, (url, init) => {
        return (
          url === `${SQUARE_BASE}/customers` && (init?.method ?? "GET").toUpperCase() === "POST"
        );
      });
    },
    onCustomerPatch(customerId?: string) {
      return buildRoute(routes, (url, init) => {
        const isPut = (init?.method ?? "GET").toUpperCase() === "PUT";
        if (!isPut) return false;
        if (customerId) return url === `${SQUARE_BASE}/customers/${customerId}`;
        return url.startsWith(`${SQUARE_BASE}/customers/`) && !url.endsWith("/search");
      });
    },
    onCustomerGet(customerId?: string) {
      return buildRoute(routes, (url, init) => {
        const isGet = (init?.method ?? "GET").toUpperCase() === "GET";
        if (!isGet) return false;
        if (customerId) return url === `${SQUARE_BASE}/customers/${customerId}`;
        return url.startsWith(`${SQUARE_BASE}/customers/`) && !url.endsWith("/search");
      });
    },
    onLoyaltyAccountsSearch() {
      return buildRoute(routes, (url, init) => {
        return (
          url === `${SQUARE_BASE}/loyalty/accounts/search` &&
          (init?.method ?? "GET").toUpperCase() === "POST"
        );
      });
    },
    reset() {
      routes.length = 0;
      allCalls.length = 0;
    },
    allCalls() {
      return allCalls;
    },
  };
}

/** Restore the global fetch to undefined / its previous value. Call in afterEach. */
export function uninstallSquareMock(): void {
  // vitest restoreAllMocks() handles vi.fn restoration; this is defensive.
  vi.restoreAllMocks();
}
