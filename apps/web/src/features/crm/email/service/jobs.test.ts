import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "../../core/types";
import type { JobContext } from "../../jobs/registry";

/**
 * The two `crm_jobs` handlers, and the one thing a reader most needs pinned:
 * an UNCONFIGURED Graph parks rather than burning twenty attempts, and
 * `graph-renew` on a preview creates nothing because there is no webhook URL.
 */

const bag = vi.hoisted(() => ({
  reps: [] as { email: string | null }[],
  ensure: vi.fn(),
  getMessage: vi.fn(),
  sendDraft: vi.fn(),
  link: vi.fn(),
  linkRow: null as Record<string, unknown> | null,
  sent: [] as { id: string; provider: string; sentAt?: Date }[],
  failed: [] as { id: string; error: string }[],
}));

// `publicRoster` is not this sub's business, but the registry's `threecx-*`
// line now pulls `crm/calls` -> `calls/service/board.ts`, which binds it at
// module scope — so a factory that omits it makes importing the registry throw.
vi.mock("../../reps", () => ({
  listReps: vi.fn(async () => bag.reps),
  publicRoster: vi.fn(async () => []),
}));
vi.mock("../data/email-links-db", () => ({
  // `./subscriptions` binds these at module scope, so the factory has to carry
  // them or importing `./jobs` throws.
  GRAPH_FOLDERS: ["inbox", "sentitems"] as const,
  findSubscriptionById: vi.fn(async () => null),
  listSubscriptions: vi.fn(async () => []),
  recordSubscription: vi.fn(async () => undefined),
  recordSubscriptionError: vi.fn(async () => undefined),
  upsertSubscriptionRow: vi.fn(async () => null),
  getLink: vi.fn(async () => bag.linkRow),
  markLinkSent: vi.fn(async (id: string, provider: string, opts: { sentAt?: Date } = {}) => {
    bag.sent.push({ id, provider, sentAt: opts.sentAt });
    return null;
  }),
  markLinkFailed: vi.fn(async (id: string, error: string) => {
    bag.failed.push({ id, error });
    return null;
  }),
}));
vi.mock("./subscriptions", async () => {
  const actual = await vi.importActual<typeof import("./subscriptions")>("./subscriptions");
  return { ...actual, ensureSubscriptions: bag.ensure };
});
vi.mock("./webhook", () => ({ linkGraphMessage: bag.link }));

const { GraphError } = await import("./graph-client");
const {
  emailSendRetryIdempotencyKey,
  graphFetchIdempotencyKey,
  graphRenewIdempotencyKey,
  runEmailSendRetryJob,
  runGraphFetchMessageJob,
  runGraphRenewJob,
  subscribedMailboxes,
} = await import("./jobs");

vi.mock("./graph-client", async () => {
  const actual = await vi.importActual<typeof import("./graph-client")>("./graph-client");
  return { ...actual, getMessage: bag.getMessage, sendDraft: bag.sendDraft };
});

const ENV = { ...process.env };
const NOW = new Date("2026-09-13T02:30:00Z"); // 22:30 ET on the 12th

function ctx(payload: Record<string, unknown> = {}): JobContext {
  return {
    job: { id: "1", kind: "graph-renew", payload } as unknown as JobRow,
    payload,
    actorEmail: "eric@headpinz.com",
    now: NOW,
  };
}

function graphOn() {
  process.env.CRM_GRAPH_TENANT_ID = "t";
  process.env.CRM_GRAPH_CLIENT_ID = "c";
  process.env.CRM_GRAPH_CLIENT_SECRET = "s";
}

beforeEach(() => {
  process.env = { ...ENV };
  bag.reps = [];
  bag.ensure.mockReset();
  bag.getMessage.mockReset();
  bag.sendDraft.mockReset();
  bag.link.mockReset();
  bag.linkRow = { id: "500", sendStatus: "pending", graphError: "no answer" };
  bag.sent.length = 0;
  bag.failed.length = 0;
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("idempotency keys", () => {
  it("renews once per ET calendar day, not per UTC day", () => {
    // 02:30 UTC is still the 12th in Eastern — a UTC key would say the 13th.
    expect(graphRenewIdempotencyKey(NOW)).toBe("graph-renew:2026-09-12");
  });

  it("fetches one message once, whatever case the mailbox arrives in", () => {
    expect(graphFetchIdempotencyKey("Kelsea@HeadPinz.com", "AA")).toBe(
      "graph-fetch-message:kelsea@headpinz.com:AA",
    );
  });
});

describe("subscribedMailboxes", () => {
  it("is the active reps that have one, deduplicated and lowercased", async () => {
    bag.reps = [
      { email: "Kelsea@HeadPinz.com" },
      { email: null },
      { email: "kelsea@headpinz.com" },
      { email: "guestservices@headpinz.com" },
    ];
    expect(await subscribedMailboxes()).toEqual([
      "kelsea@headpinz.com",
      "guestservices@headpinz.com",
    ]);
  });
});

describe("graph-renew", () => {
  it("PARKS when CRM_GRAPH_* is not configured", async () => {
    const r = await runGraphRenewJob(ctx());
    expect(r).toEqual({ ok: false, error: "CRM_GRAPH_* not configured", park: true });
    expect(bag.ensure).not.toHaveBeenCalled();
  });

  it("PARKS on a preview, where there is no webhook URL to validate", async () => {
    graphOn();
    bag.reps = [{ email: "kelsea@headpinz.com" }];
    bag.ensure.mockResolvedValue({
      skipped: "no_webhook_url",
      notificationUrl: null,
      outcomes: [],
    });
    const r = await runGraphRenewJob(ctx());
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ park: true });
  });

  it("succeeds when at least one subscription is in place", async () => {
    graphOn();
    bag.reps = [{ email: "kelsea@headpinz.com" }];
    bag.ensure.mockResolvedValue({
      notificationUrl: "https://headpinz.com/api/crm/graph-webhook",
      outcomes: [
        { mailbox: "kelsea@headpinz.com", folder: "inbox", action: "created" },
        { mailbox: "kelsea@headpinz.com", folder: "sentitems", action: "failed", error: "nope" },
      ],
    });
    const r = await runGraphRenewJob(ctx());
    expect(r.ok).toBe(true);
  });

  it("fails (and is retried) when every subscription failed", async () => {
    graphOn();
    bag.reps = [{ email: "kelsea@headpinz.com" }];
    bag.ensure.mockResolvedValue({
      notificationUrl: "https://headpinz.com/api/crm/graph-webhook",
      outcomes: [{ mailbox: "a", folder: "inbox", action: "failed", error: "Graph 503" }],
    });
    expect(await runGraphRenewJob(ctx())).toEqual({ ok: false, error: "Graph 503" });
  });
});

describe("graph-fetch-message", () => {
  it("PARKS a payload it cannot act on", async () => {
    graphOn();
    expect(await runGraphFetchMessageJob(ctx({ mailbox: "a@b.com" }))).toMatchObject({
      park: true,
    });
  });

  it("does the SAME work the webhook does, so a retry cannot differ", async () => {
    graphOn();
    bag.getMessage.mockResolvedValue({ id: "AA" });
    bag.link.mockResolvedValue({ status: "linked", linkId: "500" });
    const r = await runGraphFetchMessageJob(ctx({ mailbox: "a@b.com", messageId: "AA" }));
    expect(bag.link).toHaveBeenCalledWith("a@b.com", { id: "AA" });
    expect(r).toEqual({ ok: true, result: { status: "linked", linkId: "500" } });
  });

  it("PARKS a message Graph no longer has, and retries anything else", async () => {
    graphOn();
    bag.getMessage.mockRejectedValue(new GraphError(404, "ErrorItemNotFound", "gone", ""));
    expect(
      await runGraphFetchMessageJob(ctx({ mailbox: "a@b.com", messageId: "AA" })),
    ).toMatchObject({ ok: false, park: true });
    bag.getMessage.mockRejectedValue(new GraphError(503, "x", "down", ""));
    const retry = await runGraphFetchMessageJob(ctx({ mailbox: "a@b.com", messageId: "AA" }));
    expect(retry).toEqual({ ok: false, error: "down" });
  });
});

/**
 * The lane that exists so a `/send` failure never becomes a second email. The
 * whole value of this handler is the RE-READ: `/send` can fail after Graph has
 * already queued the message, so "retry the send" without asking first is how
 * a guest receives it twice.
 */
describe("email-send-retry", () => {
  const payload = { linkId: "500", mailbox: "Kelsea@HeadPinz.com", messageId: "AAMk1" };

  it("keys one retry per link row", () => {
    expect(emailSendRetryIdempotencyKey("500")).toBe("email-send-retry:500");
  });

  it("RE-READS first and re-sends only a message still sitting in Drafts", async () => {
    graphOn();
    bag.getMessage.mockResolvedValue({ id: "AAMk1", isDraft: true });
    const r = await runEmailSendRetryJob(ctx(payload));
    expect(bag.getMessage).toHaveBeenCalledWith("Kelsea@HeadPinz.com", "AAMk1");
    expect(bag.sendDraft).toHaveBeenCalledWith("Kelsea@HeadPinz.com", "AAMk1");
    expect(bag.sent).toMatchObject([{ id: "500", provider: "graph" }]);
    expect(r).toMatchObject({ ok: true });
  });

  it("does NOT re-send a message that already left, and records Graph's own sent time", async () => {
    graphOn();
    bag.getMessage.mockResolvedValue({
      id: "AAMk1",
      isDraft: false,
      sentDateTime: "2026-09-13T18:44:10Z",
    });
    const r = await runEmailSendRetryJob(ctx(payload));
    expect(bag.sendDraft).not.toHaveBeenCalled();
    expect(bag.sent[0].sentAt?.toISOString()).toBe("2026-09-13T18:44:10.000Z");
    expect(r).toMatchObject({ ok: true, result: { outcome: "already_sent" } });
  });

  it("does nothing at all when the row is already marked sent", async () => {
    graphOn();
    bag.linkRow = { id: "500", sendStatus: "sent", graphError: null };
    const r = await runEmailSendRetryJob(ctx(payload));
    expect(bag.getMessage).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, result: { linkId: "500", already: "sent" } });
  });

  it("parks a draft that is gone and marks the row failed; anything else retries", async () => {
    graphOn();
    bag.getMessage.mockRejectedValue(new GraphError(404, "ErrorItemNotFound", "gone", ""));
    expect(await runEmailSendRetryJob(ctx(payload))).toMatchObject({ ok: false, park: true });
    expect(bag.failed).toEqual([{ id: "500", error: "gone" }]);
    bag.getMessage.mockRejectedValue(new GraphError(503, "x", "down", ""));
    expect(await runEmailSendRetryJob(ctx(payload))).toEqual({ ok: false, error: "down" });
  });

  it("parks a payload it cannot act on, and an unconfigured Graph", async () => {
    graphOn();
    expect(await runEmailSendRetryJob(ctx({ linkId: "500" }))).toMatchObject({ park: true });
    process.env = { ...ENV };
    expect(await runEmailSendRetryJob(ctx(payload))).toMatchObject({
      ok: false,
      park: true,
      error: "CRM_GRAPH_* not configured",
    });
  });
});

describe("the registry", () => {
  // The handlers load the whole email barrel through a dynamic import, which
  // is slow to transform on a cold run — the default 5 s budget is the test
  // harness's, not the job's.
  it("no longer answers 'not implemented' for either graph kind", async () => {
    const { HANDLERS, NOT_IMPLEMENTED_ERROR } = await import("../../jobs/registry");
    process.env = { ...ENV };
    const renew = await HANDLERS["graph-renew"](ctx());
    const fetchOne = await HANDLERS["graph-fetch-message"](ctx());
    expect(renew.ok === false ? renew.error : "").not.toBe(NOT_IMPLEMENTED_ERROR);
    expect(fetchOne.ok === false ? fetchOne.error : "").not.toBe(NOT_IMPLEMENTED_ERROR);
  }, 30_000);
});
