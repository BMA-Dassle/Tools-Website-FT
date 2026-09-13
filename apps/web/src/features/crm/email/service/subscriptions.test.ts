import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphSubscriptionRow } from "../data/email-links-db";
import { GraphError, type GraphSubscription } from "./graph-client";
import {
  clientStateMatches,
  ensureSubscriptions,
  graphWebhookUrl,
  needsRenewal,
  newClientState,
  RENEW_WITHIN_MS,
  type SubscriptionDeps,
} from "./subscriptions";

const NOW = new Date("2026-09-13T12:00:00Z");
const ENV = { ...process.env };

function row(over: Partial<GraphSubscriptionRow> = {}): GraphSubscriptionRow {
  return {
    id: "1",
    mailbox: "kelsea@headpinz.com",
    folder: "inbox",
    subscriptionId: null,
    clientState: "state-kelsea",
    expiresAt: null,
    status: "active",
    lastError: null,
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

function sub(over: Partial<GraphSubscription> = {}): GraphSubscription {
  return {
    id: "sub-1",
    resource: "/users/kelsea@headpinz.com/mailFolders/inbox/messages",
    changeType: "created",
    notificationUrl: "https://headpinz.com/api/crm/graph-webhook",
    expirationDateTime: "2026-09-16T10:00:00.000Z",
    ...over,
  };
}

function deps(over: Partial<SubscriptionDeps> = {}): SubscriptionDeps {
  return {
    create: vi.fn(async () => sub()),
    renew: vi.fn(async (id: string, expirationDateTime: string) => sub({ id, expirationDateTime })),
    list: vi.fn(async () => []),
    upsert: vi.fn(async (mailbox, folder) => row({ mailbox, folder })),
    record: vi.fn(async () => undefined),
    recordError: vi.fn(async () => undefined),
    configured: () => true,
    webhookUrl: () => "https://headpinz.com/api/crm/graph-webhook",
    newState: () => "state-kelsea",
    ...over,
  };
}

beforeEach(() => {
  process.env = { ...ENV };
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("graphWebhookUrl", () => {
  it("is null when unset — we do not guess a host", () => {
    delete process.env.CRM_GRAPH_WEBHOOK_URL;
    expect(graphWebhookUrl()).toBeNull();
  });

  it("refuses a non-https URL", () => {
    const env = (value: string): NodeJS.ProcessEnv =>
      ({ ...ENV, CRM_GRAPH_WEBHOOK_URL: value }) as NodeJS.ProcessEnv;
    expect(graphWebhookUrl(env("http://localhost:3000/x"))).toBeNull();
    expect(graphWebhookUrl(env(" https://headpinz.com/x "))).toBe("https://headpinz.com/x");
  });
});

describe("clientState", () => {
  it("mints something long and URL-safe", () => {
    const a = newClientState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(newClientState()).not.toBe(a);
  });

  it("compares exactly — a prefix or a different length never matches", () => {
    expect(clientStateMatches("abc123", "abc123")).toBe(true);
    expect(clientStateMatches("abc123", "abc12")).toBe(false);
    expect(clientStateMatches("abc123", "abc124")).toBe(false);
    expect(clientStateMatches("abc123", null)).toBe(false);
    expect(clientStateMatches("abc123", undefined)).toBe(false);
    expect(clientStateMatches("abc123", "")).toBe(false);
  });
});

describe("needsRenewal", () => {
  it("says yes to a row Graph has never seen", () => {
    expect(needsRenewal(row(), NOW)).toBe(true);
    expect(needsRenewal(row({ subscriptionId: "s", expiresAt: null }), NOW)).toBe(true);
    expect(needsRenewal(row({ subscriptionId: "s", expiresAt: "not a date" }), NOW)).toBe(true);
  });

  it("renews inside the window and leaves a fresh one alone", () => {
    const inside = new Date(NOW.getTime() + RENEW_WITHIN_MS - 60_000).toISOString();
    const outside = new Date(NOW.getTime() + RENEW_WITHIN_MS + 60_000).toISOString();
    expect(needsRenewal(row({ subscriptionId: "s", expiresAt: inside }), NOW)).toBe(true);
    expect(needsRenewal(row({ subscriptionId: "s", expiresAt: outside }), NOW)).toBe(false);
  });
});

describe("ensureSubscriptions", () => {
  it("REFUSES without CRM_GRAPH_WEBHOOK_URL — a preview cannot answer Graph's probe", async () => {
    const d = deps({ webhookUrl: () => null });
    const r = await ensureSubscriptions(["kelsea@headpinz.com"], NOW, d);
    expect(r.skipped).toBe("no_webhook_url");
    expect(d.create).not.toHaveBeenCalled();
    expect(d.upsert).not.toHaveBeenCalled();
  });

  it("refuses when Graph is not configured at all", async () => {
    const d = deps({ configured: () => false });
    expect((await ensureSubscriptions(["a@b.com"], NOW, d)).skipped).toBe("not_configured");
  });

  it("creates inbox AND sentitems for each mailbox, with an expiry inside Graph's cap", async () => {
    const d = deps();
    const r = await ensureSubscriptions(["Kelsea@HeadPinz.com"], NOW, d);
    expect(r.outcomes.map((o) => `${o.mailbox}/${o.folder}/${o.action}`)).toEqual([
      "kelsea@headpinz.com/inbox/created",
      "kelsea@headpinz.com/sentitems/created",
    ]);
    const call = (d.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      expirationDateTime: string;
      clientState: string;
      resource: string;
    };
    const minutes = (Date.parse(call.expirationDateTime) - NOW.getTime()) / 60_000;
    expect(minutes).toBeLessThanOrEqual(4230);
    expect(minutes).toBeGreaterThan(4000);
    expect(call.clientState).toBe("state-kelsea");
    expect(call.resource).toBe("/users/kelsea@headpinz.com/mailFolders/inbox/messages");
  });

  it("renews a subscription that is close to lapsing", async () => {
    const soon = new Date(NOW.getTime() + 60_000).toISOString();
    const d = deps({
      upsert: vi.fn(async (m, f) =>
        row({ mailbox: m, folder: f, subscriptionId: "s-9", expiresAt: soon }),
      ),
    });
    const r = await ensureSubscriptions(["a@b.com"], NOW, d);
    expect(r.outcomes.every((o) => o.action === "renewed")).toBe(true);
    expect(d.renew).toHaveBeenCalledTimes(2);
    expect(d.create).not.toHaveBeenCalled();
  });

  it("RECREATES when Graph has forgotten the subscription (404 on PATCH)", async () => {
    const soon = new Date(NOW.getTime() + 60_000).toISOString();
    const d = deps({
      upsert: vi.fn(async (m, f) =>
        row({ mailbox: m, folder: f, subscriptionId: "gone", expiresAt: soon }),
      ),
      renew: vi.fn(async () => {
        throw new GraphError(404, "ResourceNotFound", "not found", "");
      }),
    });
    const r = await ensureSubscriptions(["a@b.com"], NOW, d);
    expect(r.outcomes.every((o) => o.action === "recreated")).toBe(true);
    expect(d.create).toHaveBeenCalledTimes(2);
  });

  it("does nothing to a subscription that is still fresh", async () => {
    const later = new Date(NOW.getTime() + 60 * 60 * 60_000).toISOString();
    const d = deps({
      upsert: vi.fn(async (m, f) =>
        row({ mailbox: m, folder: f, subscriptionId: "s", expiresAt: later }),
      ),
    });
    const r = await ensureSubscriptions(["a@b.com"], NOW, d);
    expect(r.outcomes.every((o) => o.action === "ok")).toBe(true);
    expect(d.create).not.toHaveBeenCalled();
    expect(d.renew).not.toHaveBeenCalled();
  });

  it("records one mailbox's failure and keeps going", async () => {
    let calls = 0;
    const d = deps({
      create: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new GraphError(400, "InvalidRequest", "bad url", "");
        return sub();
      }),
    });
    const r = await ensureSubscriptions(["a@b.com"], NOW, d);
    expect(r.outcomes.map((o) => o.action)).toEqual(["failed", "created"]);
    expect(r.outcomes[0].error).toBe("bad url");
    expect(d.recordError).toHaveBeenCalledTimes(1);
  });
});
