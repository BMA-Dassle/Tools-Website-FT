import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The public route's own contract. Three properties, and each one is the
 * reason the route exists in the shape it does:
 *
 *   1. the `validationToken` handshake is answered FIRST, as `text/plain`,
 *      before anything else can slow it down or refuse it;
 *   2. an unverified notification never reaches Graph;
 *   3. a fetch failure is handed to `crm_jobs` rather than lost — the response
 *      freezes the function, so "we'll do it after the return" would not run.
 */

const bag = vi.hoisted(() => ({
  handled: [] as unknown[],
  outcome: { status: "linked", linkId: "500", leadId: "1042", matchedBy: "from" } as unknown,
  enqueued: [] as Record<string, unknown>[],
  onFetchFailure: null as
    | null
    | ((mailbox: string, messageId: string, error: string) => Promise<void>),
}));

vi.mock("~/features/crm/email", () => ({
  clientStateMatches: (a: string, b: string | null | undefined) => a === b,
  defaultWebhookDeps: { findSubscription: async () => null, fetchMessage: async () => ({}) },
  GRAPH_FETCH_MESSAGE_KIND: "graph-fetch-message",
  graphFetchIdempotencyKey: (m: string, id: string) => `graph-fetch-message:${m}:${id}`,
  handleNotification: vi.fn(
    async (
      note: unknown,
      deps: {
        onFetchFailure?: (m: string, id: string, e: string) => Promise<void>;
      },
    ) => {
      bag.handled.push(note);
      bag.onFetchFailure = deps.onFetchFailure ?? null;
      return bag.outcome;
    },
  ),
}));

vi.mock("~/features/crm/jobs", () => ({
  neonJobStore: {
    enqueue: vi.fn(async (input: Record<string, unknown>) => {
      bag.enqueued.push(input);
      return { job: { id: "1" }, created: true };
    }),
  },
}));

const { GET, POST } = await import("./route");

const URL_BASE = "https://headpinz.com/api/crm/graph-webhook";

const post = (url: string, body: unknown) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  bag.handled.length = 0;
  bag.enqueued.length = 0;
  bag.onFetchFailure = null;
});

describe("the validation handshake", () => {
  it("echoes the token verbatim as text/plain, on GET and on POST", async () => {
    const url = `${URL_BASE}?validationToken=abc%20123`;
    const onGet = await GET(new NextRequest(url, { method: "GET" }));
    expect(onGet.status).toBe(200);
    expect(onGet.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await onGet.text()).toBe("abc 123");

    const onPost = await POST(post(url, { value: [] }));
    expect(await onPost.text()).toBe("abc 123");
    // Nothing else may run first — Graph is waiting synchronously.
    expect(bag.handled).toHaveLength(0);
  });

  it("answers a bare GET without pretending to be a handshake", async () => {
    const res = await GET(new NextRequest(URL_BASE, { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("notifications", () => {
  it("hands every entry to the verifier and answers 202", async () => {
    const res = await POST(
      post(URL_BASE, {
        value: [
          { subscriptionId: "s1", clientState: "x" },
          { subscriptionId: "s2", clientState: "y" },
        ],
      }),
    );
    expect(res.status).toBe(202);
    expect(bag.handled).toHaveLength(2);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 202 to a body that is not JSON rather than 500ing at Graph", async () => {
    const res = await POST(post(URL_BASE, "not json at all{"));
    expect(res.status).toBe(202);
    expect(bag.handled).toHaveLength(0);
  });

  it("answers 202 even when every notification was DROPPED — a spoofer learns nothing", async () => {
    bag.outcome = { status: "dropped", reason: "state_mismatch" };
    const res = await POST(post(URL_BASE, { value: [{ subscriptionId: "s", clientState: "no" }] }));
    expect(res.status).toBe(202);
    bag.outcome = { status: "linked", linkId: "500", leadId: "1042", matchedBy: "from" };
  });

  it("gives a failed fetch to crm_jobs under a key a replay collapses into", async () => {
    await POST(post(URL_BASE, { value: [{ subscriptionId: "s", clientState: "x" }] }));
    expect(bag.onFetchFailure).toBeTruthy();
    await bag.onFetchFailure!("Kelsea@HeadPinz.com", "AAMk1", "Graph 503");
    expect(bag.enqueued).toEqual([
      {
        kind: "graph-fetch-message",
        idempotencyKey: "graph-fetch-message:Kelsea@HeadPinz.com:AAMk1",
        payload: { mailbox: "Kelsea@HeadPinz.com", messageId: "AAMk1", error: "Graph 503" },
        createdBy: "graph-webhook",
      },
    ]);
  });
});
