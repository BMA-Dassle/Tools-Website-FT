import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fixtureText } from "@/test/msw/handlers/fixture";

/**
 * THE SAME ROUTE, WITH THE REAL VERIFIER BEHIND IT.
 *
 * `route.test.ts` stubs `handleNotification` to pin the shell — the handshake,
 * the 202, the batch cap, the retry enqueue. That leaves the wiring between the
 * route and the verifier untested, which is precisely where a renamed field or
 * a `resourceData.id` assumption hides: `tsc` is happy, the stub is happy, and
 * the one guest-reachable, unauthenticated surface in this PR ships broken.
 *
 * So this file mocks only what sits UNDERNEATH `handleNotification` — the
 * subscription row, `getMessage`, and the three row-owning modules — and posts
 * the envelope Microsoft Graph actually sends, kept verbatim as
 * `fixtures/graph-notification.json.txt`.
 *
 * Note what that fixture carries and a hand-written stub would not: `resource`
 * names the mailbox by DIRECTORY OID, never by address. The mailbox on the
 * stored row therefore has to come from the subscription we minted.
 */

const KELSEA = "kelsea@headpinz.com";
const CLIENT_STATE = "crm-inbox-kelsea@headpinz.com-2f8c1e";
const SUB_ID = "7f105c7d-2dc5-4530-97cd-4e7ae6534c07";
const INBOUND_ID =
  "AAMkAGRhZ2E3ZDAyLTUzNjItNDA1MS1hZDYzLTk0MjQ1M2Y0ZWFlNQBGAAAAAAB2inboundREPLY";

const bag = vi.hoisted(() => ({
  sub: null as Record<string, unknown> | null,
  fetched: [] as { mailbox: string; messageId: string }[],
  inserted: [] as Record<string, unknown>[],
  enqueued: [] as Record<string, unknown>[],
  activities: [] as Record<string, unknown>[],
  lead: null as Record<string, unknown> | null,
  fetchFails: false,
}));

vi.mock("~/features/crm/email/data/email-links-db", () => ({
  ensureEmailSchema: vi.fn(async () => undefined),
  findSubscriptionById: vi.fn(async () => bag.sub),
  findLinkByInternetMessageId: vi.fn(async () => null),
  insertGraphLinkOnce: vi.fn(async (input: Record<string, unknown>) => {
    bag.inserted.push(input);
    return { ...input, id: "500", direction: input.direction, sentAt: input.sentAt };
  }),
  // `service/subscriptions.ts` binds these at module scope.
  GRAPH_FOLDERS: ["inbox", "sentitems"] as const,
  listSubscriptions: vi.fn(async () => []),
  recordSubscription: vi.fn(async () => undefined),
  recordSubscriptionError: vi.fn(async () => undefined),
  upsertSubscriptionRow: vi.fn(async () => null),
  getLink: vi.fn(async () => null),
  markLinkSent: vi.fn(async () => null),
  markLinkFailed: vi.fn(async () => null),
  markLinkPending: vi.fn(async () => null),
  insertOutboundLink: vi.fn(async () => null),
  setLinkGraphMessageId: vi.fn(async () => undefined),
  listLeadEmails: vi.fn(async () => ({ items: [], nextCursor: null })),
  listEmailThreads: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

vi.mock("~/features/crm/email/service/graph-client", async () => {
  const actual =
    await vi.importActual<typeof import("~/features/crm/email/service/graph-client")>(
      "~/features/crm/email/service/graph-client",
    );
  return {
    ...actual,
    getMessage: vi.fn(async (mailbox: string, messageId: string) => {
      bag.fetched.push({ mailbox, messageId });
      if (bag.fetchFails) throw new actual.GraphError(503, "ServiceUnavailable", "down", "");
      return JSON.parse(fixtureText("graph-inbound-message.json.txt")) as Record<string, unknown>;
    }),
  };
});

vi.mock("~/features/crm/leads", () => ({
  listLeads: vi.fn(async () => ({ leads: bag.lead ? [bag.lead] : [], nextCursor: null })),
  getLead: vi.fn(async () => bag.lead),
}));

vi.mock("~/features/crm/activities", () => ({
  recordActivity: vi.fn(async (a: Record<string, unknown>) => {
    bag.activities.push(a);
    return "9";
  }),
}));

vi.mock("~/features/crm/jobs", () => ({
  neonJobStore: {
    enqueue: vi.fn(async (input: Record<string, unknown>) => {
      bag.enqueued.push(input);
      return { job: { id: "1" }, created: true };
    }),
  },
}));

const { POST } = await import("./route");

const URL_BASE = "https://headpinz.com/api/crm/graph-webhook";
const envelope = () => fixtureText("graph-notification.json.txt");

const post = (body: string, url = URL_BASE) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

function subRow(over: Record<string, unknown> = {}) {
  return {
    id: "1",
    mailbox: KELSEA,
    folder: "inbox",
    subscriptionId: SUB_ID,
    clientState: CLIENT_STATE,
    expiresAt: null,
    status: "active",
    lastError: null,
    updatedAt: "2026-09-13T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  bag.sub = subRow();
  bag.fetched.length = 0;
  bag.inserted.length = 0;
  bag.enqueued.length = 0;
  bag.activities.length = 0;
  bag.fetchFails = false;
  bag.lead = {
    id: "1042",
    publicId: "L-1042",
    contactId: "77",
    rep: "1",
    status: "assigned",
    archivedAt: null,
    guest: { email: "dana@example.com" },
  };
});

describe("a verbatim Graph notification", () => {
  it("links the message to its lead, end to end through the real verifier", async () => {
    const res = await POST(post(envelope()));
    expect(res.status).toBe(202);
    const json = (await res.json()) as { outcomes: { status: string; matchedBy?: string }[] };
    expect(json.outcomes).toEqual([
      { status: "linked", linkId: "500", leadId: "1042", matchedBy: "from" },
    ]);
    expect(bag.activities[0]).toMatchObject({ kind: "email", direction: "in" });
  });

  it("reads the message id from `resource`, not from a guessed field", async () => {
    await POST(post(envelope()));
    expect(bag.fetched).toEqual([{ mailbox: KELSEA, messageId: INBOUND_ID }]);
  });

  it("stores the SUBSCRIPTION's mailbox — `resource` names it by directory OID", async () => {
    await POST(post(envelope()));
    // The OID in the fixture must never reach the row: `directionOf` compares
    // this value with the from-address, so a GUID files every Sent Items copy
    // as inbound.
    expect(bag.inserted[0]).toMatchObject({ mailbox: KELSEA, direction: "in" });
    expect(String(bag.inserted[0].mailbox)).not.toMatch(/^[0-9a-f]{8}-/);
  });

  it("never touches Graph when the clientState does not match", async () => {
    bag.sub = subRow({ clientState: "a-different-secret" });
    const res = await POST(post(envelope()));
    expect(res.status).toBe(202);
    expect(bag.fetched).toHaveLength(0);
    expect(bag.inserted).toHaveLength(0);
    const json = (await res.json()) as { outcomes: { status: string; reason?: string }[] };
    expect(json.outcomes).toEqual([{ status: "dropped", reason: "state_mismatch" }]);
  });

  it("never touches Graph for a subscription we have no row for", async () => {
    bag.sub = null;
    await POST(post(envelope()));
    expect(bag.fetched).toHaveLength(0);
  });

  it("hands a Graph hiccup to crm_jobs under the shipped key", async () => {
    bag.fetchFails = true;
    await POST(post(envelope()));
    expect(bag.enqueued).toEqual([
      {
        kind: "graph-fetch-message",
        idempotencyKey: `graph-fetch-message:${KELSEA}:${INBOUND_ID}`,
        payload: { mailbox: KELSEA, messageId: INBOUND_ID, error: "down" },
        createdBy: "graph-webhook",
      },
    ]);
  });
});

describe("the handshake Graph performs before any of that exists", () => {
  it("echoes the token from a POST that carries no JSON body at all", async () => {
    const req = new NextRequest(`${URL_BASE}?validationToken=abc`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("abc");
    expect(bag.fetched).toHaveLength(0);
  });
});
