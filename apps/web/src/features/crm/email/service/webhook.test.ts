import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureText } from "@/test/msw/handlers/fixture";
import type { GraphSubscriptionRow } from "../data/email-links-db";
import type { GraphMessage } from "./graph-client";

/**
 * The public webhook's decisions. `clientState` is the ONLY thing standing
 * between a stranger's POST and a `getMessage` call, so most of this file is
 * about refusing — and about refusing WITHOUT touching Graph.
 */

const bag = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
  insertReturns: null as Record<string, unknown> | null,
  activities: [] as Record<string, unknown>[],
  leadsByEmail: [] as Record<string, unknown>[],
  linkByImid: null as { leadId: string | null } | null,
  leadByRef: null as Record<string, unknown> | null,
}));

vi.mock("../data/email-links-db", () => ({
  insertGraphLinkOnce: vi.fn(async (input: Record<string, unknown>) => {
    bag.inserted.push(input);
    return bag.insertReturns;
  }),
  findLinkByInternetMessageId: vi.fn(async () => bag.linkByImid),
  findSubscriptionById: vi.fn(async () => null),
  // `./subscriptions` (imported below for `clientStateMatches`) binds these at
  // module scope, so the mock has to carry them or its import throws.
  GRAPH_FOLDERS: ["inbox", "sentitems"] as const,
  listSubscriptions: vi.fn(async () => []),
  recordSubscription: vi.fn(async () => undefined),
  recordSubscriptionError: vi.fn(async () => undefined),
  upsertSubscriptionRow: vi.fn(async () => null),
}));

vi.mock("../../activities", () => ({
  recordActivity: vi.fn(async (a: Record<string, unknown>) => {
    bag.activities.push(a);
    return "1";
  }),
}));

vi.mock("../../leads", () => ({
  listLeads: vi.fn(async () => ({ leads: bag.leadsByEmail, nextCursor: null })),
  getLead: vi.fn(async () => bag.leadByRef),
}));

const { clientStateMatches } = await import("./subscriptions");
const { handleNotification, linkGraphMessage, parseResource, toMatchedLead } =
  await import("./webhook");

const KELSEA = "kelsea@headpinz.com";
const inbound = () => JSON.parse(fixtureText("graph-inbound-message.json.txt")) as GraphMessage;

function subRow(over: Partial<GraphSubscriptionRow> = {}): GraphSubscriptionRow {
  return {
    id: "1",
    mailbox: KELSEA,
    folder: "inbox",
    subscriptionId: "sub-1",
    clientState: "the-secret",
    expiresAt: null,
    status: "active",
    lastError: null,
    updatedAt: "2026-09-13T00:00:00Z",
    ...over,
  };
}

function leadRow(over: Record<string, unknown> = {}) {
  return {
    id: "1042",
    publicId: "L-1042",
    contactId: "77",
    rep: "1",
    status: "assigned",
    archivedAt: null,
    guest: { email: "dana@example.com" },
    ...over,
  };
}

const linkRow = {
  id: "500",
  mailbox: KELSEA,
  graphMessageId: "AAMk-inbound",
  direction: "in" as const,
  subject: "RE: HeadPinz",
  preview: "Thanks",
  sentAt: "2026-09-13T13:05:22Z",
  matchedBy: "from",
  webLink: null,
};

beforeEach(() => {
  bag.inserted.length = 0;
  bag.activities.length = 0;
  bag.leadsByEmail.length = 0;
  bag.insertReturns = linkRow as unknown as Record<string, unknown>;
  bag.linkByImid = null;
  bag.leadByRef = null;
});

describe("parseResource", () => {
  it("reads both shapes Graph sends", () => {
    expect(parseResource("Users/abc-oid/Messages/AAMk123")).toEqual({
      mailbox: "abc-oid",
      messageId: "AAMk123",
    });
    expect(parseResource("/users/kelsea%40headpinz.com/mailFolders/inbox/messages/AA-1")).toEqual({
      mailbox: KELSEA,
      messageId: "AA-1",
    });
    expect(parseResource(undefined)).toEqual({ mailbox: null, messageId: null });
  });
});

describe("clientState is the gate", () => {
  const fetchMessage = vi.fn(async () => inbound());
  const findSubscription = vi.fn(async () => subRow());

  beforeEach(() => {
    fetchMessage.mockClear();
    findSubscription.mockClear();
  });

  const deps = () => ({ findSubscription, fetchMessage, statesMatch: clientStateMatches });

  it("DROPS a notification with no clientState, without calling Graph", async () => {
    const r = await handleNotification(
      { subscriptionId: "sub-1", resource: `Users/${KELSEA}/Messages/AA` },
      deps(),
    );
    expect(r).toEqual({ status: "dropped", reason: "no_client_state" });
    expect(fetchMessage).not.toHaveBeenCalled();
    expect(bag.inserted).toHaveLength(0);
  });

  it("DROPS a mismatched clientState, without calling Graph", async () => {
    const r = await handleNotification(
      { subscriptionId: "sub-1", clientState: "guessed", resource: `Users/${KELSEA}/Messages/AA` },
      deps(),
    );
    expect(r).toEqual({ status: "dropped", reason: "state_mismatch" });
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("DROPS a subscription id we never issued", async () => {
    const r = await handleNotification(
      { subscriptionId: "nope", clientState: "the-secret" },
      { ...deps(), findSubscription: vi.fn(async () => null) },
    );
    expect(r).toEqual({ status: "dropped", reason: "unknown_subscription" });
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("processes a notification whose state checks out", async () => {
    bag.leadsByEmail.push(leadRow());
    const r = await handleNotification(
      {
        subscriptionId: "sub-1",
        clientState: "the-secret",
        resource: `Users/${KELSEA}/Messages/AAMk-inbound`,
      },
      deps(),
    );
    expect(fetchMessage).toHaveBeenCalledWith(KELSEA, "AAMk-inbound");
    expect(r).toMatchObject({ status: "linked", leadId: "1042", matchedBy: "from" });
  });

  it("hands a failed fetch to the retry lane instead of losing it", async () => {
    const onFetchFailure = vi.fn(async () => undefined);
    const r = await handleNotification(
      {
        subscriptionId: "sub-1",
        clientState: "the-secret",
        resource: `Users/${KELSEA}/Messages/AA`,
      },
      {
        ...deps(),
        fetchMessage: vi.fn(async () => {
          throw new Error("Graph 503");
        }),
        onFetchFailure,
      },
    );
    expect(r).toEqual({ status: "failed", error: "Graph 503" });
    expect(onFetchFailure).toHaveBeenCalledWith(KELSEA, "AA", "Graph 503");
  });
});

describe("linkGraphMessage", () => {
  it("stores the message against its lead and writes ONE activity", async () => {
    bag.leadsByEmail.push(leadRow());
    const r = await linkGraphMessage(KELSEA, inbound());
    expect(r).toMatchObject({ status: "linked", linkId: "500" });
    expect(bag.inserted[0]).toMatchObject({
      mailbox: KELSEA,
      direction: "in",
      fromEmail: "dana@example.com",
      leadId: "1042",
      matchedBy: "from",
      inReplyTo: "<CRM-L-1042-01J7QA@headpinz.com>",
    });
    expect(bag.activities).toHaveLength(1);
    expect(bag.activities[0]).toMatchObject({
      kind: "email",
      direction: "in",
      externalKind: "crm_email_link",
      externalRef: "500",
    });
  });

  it("is IDEMPOTENT: a duplicate notification writes nothing and records nothing", async () => {
    bag.leadsByEmail.push(leadRow());
    bag.insertReturns = null; // what ON CONFLICT DO NOTHING returns
    const r = await linkGraphMessage(KELSEA, inbound());
    expect(r).toEqual({ status: "ignored", reason: "duplicate" });
    expect(bag.activities).toHaveLength(0);
  });

  it("KEEPS an unmatched message as a row rather than throwing it away", async () => {
    const r = await linkGraphMessage(KELSEA, inbound());
    expect(r).toEqual({ status: "ignored", reason: "no_match" });
    expect(bag.inserted[0]).toMatchObject({ leadId: null, matchedBy: null });
    expect(bag.activities).toHaveLength(0);
  });
});

describe("toMatchedLead", () => {
  it("treats lost and noresp as closed, everything else as open", () => {
    expect(toMatchedLead(leadRow() as never).statusKindOpen).toBe(true);
    expect(toMatchedLead(leadRow({ status: "lost" }) as never).statusKindOpen).toBe(false);
    expect(toMatchedLead(leadRow({ status: "noresp" }) as never).statusKindOpen).toBe(false);
    expect(toMatchedLead(leadRow({ archivedAt: "2026-01-01" }) as never).archived).toBe(true);
  });
});
