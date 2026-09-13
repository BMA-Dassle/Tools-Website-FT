import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMsw } from "@/test/msw/server";
import { GRAPH_SENT_ID, graphHandlers } from "@/test/msw/handlers/graph";
import type { CrmRep, CrmUser } from "../../core/types";
import type { LeadView } from "../../leads/contracts";

/**
 * The send path end to end against MSW Graph, plus the two fallback routes.
 *
 * `@ft/db` is replaced by a recording tagged-template stub, and the three
 * modules that own a row (`email-links-db`, `activities`, `leads`) are mocked
 * at the boundary, so what this file asserts is the ORDER and the DECISIONS —
 * Neon before transport, the ImmutableId header, `sendMail` never used,
 * which failures fall back, which do not, and what the row records either way.
 */

const bag = vi.hoisted(() => {
  const links: Record<string, unknown>[] = [];
  return {
    links,
    /** Every rail, in the order it ran — R2's ordering is asserted from this. */
    order: [] as string[],
    inserted: [] as Record<string, unknown>[],
    setIds: [] as { id: string; graphId: string }[],
    sent: [] as { id: string; provider: string; graphError: string | null }[],
    pending: [] as { id: string; graphError: string }[],
    failed: [] as { id: string; error: string }[],
    retries: [] as Record<string, unknown>[],
    activities: [] as Record<string, unknown>[],
    touch: { recorded: false },
    patched: [] as { id: string; patch: Record<string, unknown> }[],
    sendGrid: { ok: true, status: 202 } as { ok: boolean; status: number | null; error?: string },
    sendGridCalls: [] as Record<string, unknown>[],
  };
});

vi.mock("../data/email-links-db", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "500",
    mailbox: "kelsea@headpinz.com",
    graphMessageId: null,
    conversationId: null,
    internetMessageId: null,
    inReplyTo: null,
    leadId: "1042",
    contactId: "77",
    repId: "1",
    direction: "out",
    subject: "S",
    preview: "B",
    fromEmail: "kelsea@headpinz.com",
    toEmails: ["dana@example.com"],
    ccEmails: [],
    sentAt: null,
    matchedBy: "composer",
    webLink: null,
    sendStatus: "pending",
    provider: null,
    sendError: null,
    graphError: null,
    body: "B",
    actorEmail: "kelsea@headpinz.com",
    templateId: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: null,
    ...over,
  });
  return {
    insertOutboundLink: vi.fn(async (input: Record<string, unknown>) => {
      // R2's ordering is a REAL assertion only if both rails record into the
      // same array: with only the Graph mock pushing, `["graph"]` would hold
      // whether the insert ran first, last, or not at all.
      bag.order.push("neon");
      bag.inserted.push(input);
      return row({ toEmails: input.toEmails, ccEmails: input.ccEmails });
    }),
    setLinkGraphMessageId: vi.fn(async (id: string, graphId: string) => {
      bag.setIds.push({ id, graphId });
    }),
    markLinkSent: vi.fn(
      async (id: string, provider: string, opts: { graphError?: string | null } = {}) => {
        bag.sent.push({ id, provider, graphError: opts.graphError ?? null });
        return row({
          sendStatus: "sent",
          provider,
          graphMessageId: provider === "graph" ? GRAPH_SENT_ID : null,
          sentAt: "2026-09-13T00:00:01.000Z",
        });
      },
    ),
    markLinkPending: vi.fn(async (id: string, graphError: string) => {
      bag.pending.push({ id, graphError });
      return row({ sendStatus: "pending", sendError: graphError, graphError });
    }),
    markLinkFailed: vi.fn(async (id: string, error: string) => {
      bag.failed.push({ id, error });
      return row({ sendStatus: "failed", sendError: error });
    }),
  };
});

vi.mock("../../activities", () => ({
  recordActivity: vi.fn(async (a: Record<string, unknown>) => {
    bag.activities.push(a);
    return "9";
  }),
}));

vi.mock("../../leads", () => ({
  getLead: vi.fn(async () => null),
  noteOutboundTouch: vi.fn(async () => ({ recorded: bag.touch.recorded, firstTouchAt: null })),
  updateLeadFields: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    bag.patched.push({ id, patch });
    return null;
  }),
}));

vi.mock("@/lib/sendgrid", () => ({
  sendEmail: vi.fn(async (opts: Record<string, unknown>) => {
    bag.sendGridCalls.push(opts);
    return bag.sendGrid;
  }),
}));

const { GraphError, resetGraphReadinessCache, resetGraphTokenCache } =
  await import("./graph-client");
const { sendCrmEmail, shouldFallBack, textToHtml, defaultSendDeps } = await import("./send");

const server = installMsw(...graphHandlers);

const ENV = { ...process.env };

function rep(over: Partial<CrmRep> = {}): CrmRep {
  return {
    id: "1",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    role: "rep",
    email: "kelsea@headpinz.com",
    ssoSub: null,
    bmiUserId: "28267036",
    bmiUsername: "Kelsea Kosco",
    sevenShiftsUserId: null,
    voxDid: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: ["HPFM"],
    active: true,
    sortOrder: 10,
    ...over,
  };
}

function user(over: Partial<CrmUser> = {}): CrmUser {
  return {
    email: "kelsea@headpinz.com",
    name: "Kelsea Kosco",
    sub: null,
    roles: ["access", "sales"],
    role: "rep",
    rep: rep(),
    ...over,
  };
}

function lead(over: Partial<LeadView> = {}): LeadView {
  return {
    id: "1042",
    publicId: "L-1042",
    contactId: "77",
    accountId: null,
    centre: "HPFM",
    eventDate: "2026-12-12",
    eventTime: "18:00",
    guests: 42,
    type: "corporate",
    source: "web",
    isProspect: false,
    status: "assigned",
    rep: "1",
    assignedAt: null,
    heldForRep: null,
    firstTouchAt: null,
    nextAction: null,
    valueCents: 0,
    lostReason: null,
    notes: null,
    bmi: {
      projectId: null,
      projectNumber: null,
      stateId: null,
      stateName: null,
      personId: null,
      syncedAt: null,
    },
    mintStatus: "none",
    mintError: null,
    mintAttempts: 0,
    gfShortId: null,
    lastYearBmiProjectId: null,
    coldRowId: null,
    createdBy: null,
    createdAt: "2026-09-12T12:00:00.000Z",
    updatedAt: "2026-09-12T12:00:00.000Z",
    archivedAt: null,
    kids: false,
    guest: {
      first: "Dana",
      last: "Acme",
      phone: null,
      email: "dana@example.com",
      company: null,
      prefers: "email",
    },
    repSlug: "kelsea",
    repName: "Kelsea Kosco",
    // B7 made this a required field on LeadView; an email fixture has no
    // guest request of its own.
    requestedRep: null,
    ...over,
  };
}

const input = () => ({
  lead: lead(),
  user: user(),
  subject: "Subject",
  body: "Line one\nLine two",
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

/**
 * The env AND the tenant consent, because the send path now checks both. The
 * shared `graph-token` fixture is an opaque string (PR1 pins it), so the roles
 * arrive through a local override rather than by editing that fixture.
 */
function graphOn(roles: string[] = ["Mail.Read", "Mail.ReadWrite", "Mail.Send"]) {
  process.env.CRM_GRAPH_TENANT_ID = "tenant";
  process.env.CRM_GRAPH_CLIENT_ID = "client";
  process.env.CRM_GRAPH_CLIENT_SECRET = "secret";
  delete process.env.CRM_EMAIL;
  const token = `${b64({ alg: "RS256" })}.${b64({ roles })}.sig`;
  server.use(
    graphTokenHandler(token),
    ...graphHandlers.filter((h) => !/oauth2/.test(String(h.info.path))),
  );
}

function graphTokenHandler(token: string) {
  // Imported lazily so the module graph above stays the one under test.
  const { http, HttpResponse } = mswModule;
  return http.post("https://login.microsoftonline.com/:tenant/oauth2/v2.0/token", () =>
    HttpResponse.json({ token_type: "Bearer", expires_in: 3599, access_token: token }),
  );
}

const mswModule = await import("msw");

/** `defaultSendDeps.enqueueRetry` would reach Neon; every test uses this. */
const testDeps = () => ({
  ...defaultSendDeps,
  enqueueRetry: async (input: Record<string, unknown>) => {
    bag.retries.push(input);
  },
});

beforeEach(() => {
  process.env = { ...ENV };
  resetGraphTokenCache();
  resetGraphReadinessCache();
  bag.order.length = 0;
  bag.pending.length = 0;
  bag.retries.length = 0;
  bag.inserted.length = 0;
  bag.setIds.length = 0;
  bag.sent.length = 0;
  bag.failed.length = 0;
  bag.activities.length = 0;
  bag.patched.length = 0;
  bag.sendGridCalls.length = 0;
  bag.touch.recorded = false;
  bag.sendGrid = { ok: true, status: 202 };
});

afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe("the Graph rail", () => {
  it("writes Neon BEFORE it touches Graph, then stores the IMMUTABLE id", async () => {
    graphOn();
    const deps = {
      ...testDeps(),
      randomToken: () => "01J7QA",
      createDraft: async (
        mailbox: string,
        draft: Parameters<typeof defaultSendDeps.createDraft>[1],
      ) => {
        bag.order.push("graph");
        return defaultSendDeps.createDraft(mailbox, draft);
      },
    };
    const before = bag.inserted.length;
    const res = await sendCrmEmail(input(), deps);
    expect(bag.inserted.length).toBe(before + 1);
    // The insert carries the body a rep typed, with NO graph id yet.
    expect(bag.inserted[0]).toMatchObject({
      mailbox: "kelsea@headpinz.com",
      toEmails: ["dana@example.com"],
      body: "Line one\nLine two",
      actorEmail: "kelsea@headpinz.com",
      internetMessageId: "<CRM-L-1042-01J7QA@headpinz.com>",
    });
    expect(bag.order).toEqual(["neon", "graph"]);
    // `Prefer: IdType="ImmutableId"` is what makes the fixture answer with the
    // SENT id rather than the draft id — the header is doing real work here.
    expect(bag.setIds).toEqual([{ id: "500", graphId: GRAPH_SENT_ID }]);
    expect(bag.sent).toEqual([{ id: "500", provider: "graph", graphError: null }]);
    expect(res.fellBack).toBe(false);
    expect(res.message.provider).toBe("graph");
  });

  it("sends the X-HP-Lead header and the CC list on the draft", async () => {
    graphOn();
    let body: Record<string, unknown> | null = null;
    // Layered ON TOP of graphOn's token override — `server.use` prepends, so
    // the token handler graphOn installed still answers.
    server.use(
      mswModule.http.post(
        "https://graph.microsoft.com/v1.0/users/:mailbox/messages",
        async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          const { rawJson } = await import("@/test/msw/server");
          const { graphFixtures } = await import("@/test/msw/handlers/graph");
          return rawJson(graphFixtures.sent(), { status: 201 });
        },
      ),
    );
    await sendCrmEmail(
      {
        ...input(),
        user: user({
          email: "paula@headpinz.com",
          rep: rep({ slug: "gs", email: "guestservices@headpinz.com" }),
        }),
      },
      testDeps(),
    );
    expect(body).toBeTruthy();
    expect(body!.internetMessageHeaders).toEqual([{ name: "X-HP-Lead", value: "L-1042" }]);
    expect(body!.ccRecipients).toEqual([{ emailAddress: { address: "paula@headpinz.com" } }]);
    expect(body!.body).toEqual({ contentType: "Text", content: "Line one\nLine two" });
  });

  it("never calls sendMail — the 202-with-no-id endpoint", async () => {
    graphOn();
    const seen: string[] = [];
    server.events.on("request:start", ({ request }) => seen.push(request.url));
    await sendCrmEmail(input(), testDeps());
    expect(seen.some((u) => /sendMail/i.test(u))).toBe(false);
    expect(seen.some((u) => /\/messages\/[^/]+\/send$/.test(u))).toBe(true);
  });

  it("records the activity and advances assigned → contacted on the first touch", async () => {
    graphOn();
    bag.touch.recorded = true;
    const res = await sendCrmEmail(input(), testDeps());
    expect(res.firstTouchRecorded).toBe(true);
    expect(bag.activities[0]).toMatchObject({
      kind: "email",
      direction: "out",
      outcome: "sent",
      externalKind: "crm_email_link",
      externalRef: "500",
    });
    expect(bag.patched).toEqual([{ id: "1042", patch: { statusId: "contacted" } }]);
  });

  it("leaves a status that is not `assigned` alone", async () => {
    graphOn();
    bag.touch.recorded = true;
    await sendCrmEmail({ ...input(), lead: lead({ status: "quote" }) }, testDeps());
    expect(bag.patched).toEqual([]);
  });
});

/**
 * A FAILURE AFTER THE DRAFT EXISTS IS NOT A FALLBACK. Graph has the message;
 * SendGrid would make it two. These cases are the reason `createDraft` and
 * `sendDraft` sit in separate try blocks.
 */
describe("a /send that fails after Graph accepted the draft", () => {
  const failSend = (status: number, code: string) => {
    server.use(
      mswModule.http.post("https://graph.microsoft.com/v1.0/users/:mailbox/messages/:id/send", () =>
        mswModule.HttpResponse.json({ error: { code, message: "no answer" } }, { status }),
      ),
    );
  };

  it("does NOT call SendGrid on a 503 — the guest must not get a second copy", async () => {
    graphOn();
    failSend(503, "ServiceUnavailable");
    const res = await sendCrmEmail(input(), testDeps());
    expect(bag.sendGridCalls).toHaveLength(0);
    expect(bag.sent).toHaveLength(0);
    expect(res.fellBack).toBe(false);
    expect(res.sendPending).toBe(true);
  });

  it("leaves the row pending with the Graph error, never failed and never sent", async () => {
    graphOn();
    failSend(429, "TooManyRequests");
    const res = await sendCrmEmail(input(), testDeps());
    expect(bag.pending).toEqual([{ id: "500", graphError: "no answer" }]);
    expect(bag.failed).toHaveLength(0);
    expect(res.message.sendStatus).toBe("pending");
    // The draft id we stored is still the one the retry will re-read.
    expect(bag.setIds).toEqual([{ id: "500", graphId: GRAPH_SENT_ID }]);
  });

  it("hands the orphan to email-send-retry under a key per link row", async () => {
    graphOn();
    failSend(503, "ServiceUnavailable");
    await sendCrmEmail(input(), testDeps());
    expect(bag.retries).toEqual([
      {
        linkId: "500",
        mailbox: "kelsea@headpinz.com",
        messageId: GRAPH_SENT_ID,
        error: "no answer",
      },
    ]);
  });

  it("records the activity as not-sent and never counts it as a first touch", async () => {
    graphOn();
    bag.touch.recorded = true;
    failSend(503, "ServiceUnavailable");
    const res = await sendCrmEmail(input(), testDeps());
    expect(bag.activities[0]).toMatchObject({ outcome: "failed" });
    expect(bag.patched).toEqual([]);
    expect(res.firstTouchRecorded).toBe(false);
  });

  it("still answers the composer rather than throwing — the message may yet go", async () => {
    graphOn();
    failSend(503, "ServiceUnavailable");
    await expect(sendCrmEmail(input(), testDeps())).resolves.toMatchObject({ sendPending: true });
  });
});

describe("the SendGrid fallback", () => {
  it("is the whole rail when CRM_GRAPH_* is not on this deployment", async () => {
    delete process.env.CRM_GRAPH_TENANT_ID;
    delete process.env.CRM_GRAPH_CLIENT_ID;
    delete process.env.CRM_GRAPH_CLIENT_SECRET;
    const res = await sendCrmEmail(input(), testDeps());
    expect(res.fellBack).toBe(true);
    expect(bag.sendGridCalls).toHaveLength(1);
    // from AND replyTo are the rep, never noreply@ (brief C2).
    expect(bag.sendGridCalls[0]).toMatchObject({
      to: "dana@example.com",
      from: { email: "kelsea@headpinz.com", name: "Kelsea Kosco" },
      replyTo: "kelsea@headpinz.com",
      subject: "Subject",
      text: "Line one\nLine two",
    });
    expect(bag.sent).toEqual([{ id: "500", provider: "sendgrid", graphError: null }]);
    // The row keeps graph_message_id NULL on this rail.
    expect(res.message.graphMessageId).toBeNull();
    expect(res.message.provider).toBe("sendgrid");
  });

  it("is the whole rail when the CRM_EMAIL kill switch is the string 'false'", async () => {
    graphOn();
    process.env.CRM_EMAIL = "false";
    const res = await sendCrmEmail(input(), testDeps());
    expect(res.fellBack).toBe(true);
    expect(res.graphError).toMatch(/CRM_EMAIL kill switch/);
    expect(bag.sendGridCalls).toHaveLength(1);
  });

  /**
   * THE STATE THE CRM ACTUALLY SHIPS IN (probed live 2026-09-13): the tenant
   * consented to Mail.Read + Mail.Send, which does NOT authorise creating a
   * draft. The send must not spend a doomed round trip on Graph, must go out,
   * and must say which permission is missing.
   */
  it("goes straight to SendGrid when Mail.ReadWrite has not been consented", async () => {
    graphOn(["Mail.Read", "Mail.Send"]);
    const seen: string[] = [];
    server.events.on("request:start", ({ request }) => seen.push(request.url));
    const res = await sendCrmEmail(input(), testDeps());
    expect(res.fellBack).toBe(true);
    expect(res.graphError).toContain("Mail.ReadWrite");
    expect(seen.some((u) => /graph\.microsoft\.com/.test(u))).toBe(false);
    expect(bag.sendGridCalls).toHaveLength(1);
    // The ROW keeps the whole sentence (a director reads it); the RESPONSE
    // carries the leading clause only (C2-9).
    expect(bag.sent[0].graphError).toContain('"HeadPinz Sales CRM" app registration.');
    expect(res.graphError!.length).toBeLessThan(bag.sent[0].graphError!.length);
  });

  it("catches a Graph 5xx and records WHY on the row", async () => {
    graphOn();
    const msw = await import("msw");
    server.use(
      msw.http.post("https://graph.microsoft.com/v1.0/users/:mailbox/messages", () =>
        msw.HttpResponse.json(
          { error: { code: "ServiceUnavailable", message: "down" } },
          {
            status: 503,
          },
        ),
      ),
    );
    const res = await sendCrmEmail(input(), testDeps());
    expect(res.fellBack).toBe(true);
    expect(res.graphError).toBe("down");
    expect(bag.sent).toEqual([{ id: "500", provider: "sendgrid", graphError: "down" }]);
  });

  it("catches 403 ErrorAccessDenied — the mailbox is not in the access policy yet", async () => {
    graphOn();
    const msw = await import("msw");
    server.use(
      msw.http.post("https://graph.microsoft.com/v1.0/users/:mailbox/messages", () =>
        msw.HttpResponse.json(
          { error: { code: "ErrorAccessDenied", message: "Blocked by AppOnly Access Policy" } },
          { status: 403 },
        ),
      ),
    );
    const res = await sendCrmEmail(input(), testDeps());
    expect(res.fellBack).toBe(true);
    expect(bag.sent[0].provider).toBe("sendgrid");
  });

  it("does NOT hide our own 400 behind the fallback", async () => {
    graphOn();
    const msw = await import("msw");
    server.use(
      msw.http.post("https://graph.microsoft.com/v1.0/users/:mailbox/messages", () =>
        msw.HttpResponse.json(
          { error: { code: "ErrorInvalidRecipients", message: "bad recipient" } },
          { status: 400 },
        ),
      ),
    );
    await expect(sendCrmEmail(input(), testDeps())).rejects.toThrow("bad recipient");
    expect(bag.sendGridCalls).toHaveLength(0);
    expect(bag.failed).toEqual([{ id: "500", error: "bad recipient" }]);
    // The failure is still a diary entry, and it never counts as a first touch.
    expect(bag.activities[0]).toMatchObject({ outcome: "failed" });
    expect(bag.patched).toEqual([]);
  });

  it("marks the row failed when SendGrid refuses too", async () => {
    delete process.env.CRM_GRAPH_TENANT_ID;
    bag.sendGrid = { ok: false, status: 401, error: "SENDGRID_API_KEY missing" };
    await expect(sendCrmEmail(input(), testDeps())).rejects.toThrow("SENDGRID_API_KEY missing");
    expect(bag.failed).toEqual([{ id: "500", error: "SENDGRID_API_KEY missing" }]);
  });
});

describe("guards", () => {
  it("refuses a lead with no address rather than sending nowhere", async () => {
    graphOn();
    await expect(
      sendCrmEmail(
        { ...input(), lead: lead({ guest: { ...lead().guest, email: null } }) },
        testDeps(),
      ),
    ).rejects.toThrow("no_recipient");
    expect(bag.inserted).toHaveLength(0);
  });

  it("classifies which Graph errors deserve the other rail", () => {
    expect(shouldFallBack(new GraphError(503, "x", "y", ""))).toBe(true);
    expect(shouldFallBack(new GraphError(429, "x", "y", ""))).toBe(true);
    expect(shouldFallBack(new GraphError(0, "network", "y", ""))).toBe(true);
    expect(shouldFallBack(new GraphError(403, "ErrorAccessDenied", "y", ""))).toBe(true);
    expect(shouldFallBack(new GraphError(403, "ErrorSomethingElse", "y", ""))).toBe(false);
    expect(shouldFallBack(new GraphError(400, "Bad", "y", ""))).toBe(false);
    expect(shouldFallBack(new Error("nope"))).toBe(false);
  });

  it("escapes the HTML part rather than trusting the rep's text", () => {
    expect(textToHtml("<script>x</script>")).toContain("&lt;script&gt;");
    expect(textToHtml("a & b")).toContain("a &amp; b");
  });
});
