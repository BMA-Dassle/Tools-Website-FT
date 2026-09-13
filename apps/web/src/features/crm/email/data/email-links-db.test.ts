import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `crm_email_links` at the SQL boundary (brief §3.10): what the statements
 * actually say, with no Neon. The properties that matter are the ones a later
 * reader would otherwise have to take on trust — the outbound insert really
 * does leave `graph_message_id` NULL, the inbound insert really is
 * `ON CONFLICT DO NOTHING`, and the list reads are keyset, never OFFSET.
 */

// `await vi.hoisted(async () => …)` rather than a top-level import: a hoisted
// factory runs BEFORE the file's imports are initialised, so naming an
// imported binding in it is a TDZ crash (schema.test.ts uses the same shape).
const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => true }));

const {
  clampLimit,
  insertGraphLinkOnce,
  insertOutboundLink,
  listEmailThreads,
  listLeadEmails,
  mapEmailLinkRow,
  upsertSubscriptionRow,
  MAX_PAGE,
} = await import("./email-links-db");

const OUT = {
  mailbox: "kelsea@headpinz.com",
  leadId: "1042",
  contactId: "77",
  repId: "1",
  subject: "Subject",
  body: "Hi Dana,\n\nGreat to connect!",
  toEmails: ["dana@example.com"],
  ccEmails: [] as string[],
  actorEmail: "kelsea@headpinz.com",
  templateId: null,
  internetMessageId: "<CRM-L-1042-x@headpinz.com>",
  inReplyTo: null,
};

const RAW_ROW = {
  id: "500",
  mailbox: "kelsea@headpinz.com",
  graph_message_id: null,
  conversation_id: null,
  internet_message_id: "<CRM-L-1042-x@headpinz.com>",
  in_reply_to: null,
  lead_id: "1042",
  contact_id: "77",
  rep_id: "1",
  direction: "out",
  subject: "Subject",
  preview: "Hi Dana,",
  from_email: "kelsea@headpinz.com",
  to_emails: ["dana@example.com"],
  cc_emails: null,
  sent_at: null,
  matched_by: "composer",
  web_link: null,
  send_status: "pending",
  provider: null,
  send_error: null,
  graph_error: null,
  body: "Hi Dana,",
  actor_email: "kelsea@headpinz.com",
  template_id: null,
  created_at: "2026-09-13T00:00:00.000Z",
  updated_at: null,
};

beforeEach(() => {
  db.reset();
});

describe("schema", () => {
  // ONE test, because `ensureEmailSchema` is memoised per module instance:
  // the DDL is issued on the first call in this file and never again.
  it("drops the NOT NULL on graph_message_id, adds its columns idempotently, and keeps the unique key", async () => {
    db.respond = () => [RAW_ROW];
    await insertOutboundLink(OUT);

    const alters = db.matching(/ALTER TABLE crm_email_links/);
    // ONE statement, not ten: the ensure runs on every cold start.
    expect(alters).toHaveLength(1);
    const alter = alters[0].text;
    // An outbound row has no Graph id yet, and a SendGrid-sent row never will.
    expect(alter).toMatch(/ALTER COLUMN graph_message_id DROP NOT NULL/);
    // Every added column is idempotent — a bare `ADD COLUMN` would throw the
    // second time the process starts and take the whole schema down with it.
    const adds = alter.match(/ADD COLUMN/g) ?? [];
    const guarded = alter.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(adds.length);

    const create = db.matching(/CREATE TABLE IF NOT EXISTS crm_email_links/)[0];
    expect(create.text).toMatch(/UNIQUE \(mailbox, graph_message_id\)/);
  });
});

describe("insertOutboundLink", () => {
  it("writes the row BEFORE any transport: NULL graph id, status 'pending'", async () => {
    db.respond = () => [RAW_ROW];
    const link = await insertOutboundLink(OUT);
    const insert = db.matching(/INSERT INTO crm_email_links/)[0];
    expect(insert.text).toMatch(/VALUES \(\$1, NULL,/);
    expect(insert.text).toMatch(/'pending', 'composer'/);
    expect(insert.params).toContain("Hi Dana,\n\nGreat to connect!");
    expect(insert.params).toContain("kelsea@headpinz.com");
    expect(link.sendStatus).toBe("pending");
    expect(link.graphMessageId).toBeNull();
  });
});

describe("insertGraphLinkOnce", () => {
  it("is ON CONFLICT DO NOTHING on (mailbox, graph_message_id)", async () => {
    db.respond = () => [];
    const r = await insertGraphLinkOnce({
      mailbox: "kelsea@headpinz.com",
      graphMessageId: "AA",
      conversationId: null,
      internetMessageId: null,
      inReplyTo: null,
      leadId: null,
      contactId: null,
      repId: null,
      direction: "in",
      subject: null,
      preview: null,
      fromEmail: null,
      toEmails: [],
      ccEmails: [],
      sentAt: null,
      matchedBy: null,
      webLink: null,
    });
    expect(r).toBeNull();
    const stmt = db.matching(/INSERT INTO crm_email_links/)[0];
    expect(stmt.text).toMatch(/ON CONFLICT \(mailbox, graph_message_id\) DO NOTHING/);
    expect(stmt.text).toMatch(/'received', 'graph'/);
  });
});

describe("reads are keyset, never OFFSET (R10)", () => {
  it("pages one lead's messages by (at, id) and asks for limit + 1", async () => {
    db.respond = () => [];
    await listLeadEmails("1042", {
      limit: 25,
      before: { sentAt: "2026-09-13T00:00:00Z", id: "9" },
    });
    const stmt = db.matching(/FROM crm_email_links/).at(-1)!;
    expect(stmt.text).not.toMatch(/OFFSET/i);
    expect(stmt.text).toMatch(/ORDER BY COALESCE\(sent_at, created_at\) DESC, id DESC/);
    expect(stmt.params).toContain(26);
  });

  it("scopes the thread list to one rep when asked", async () => {
    db.respond = () => [];
    await listEmailThreads({ repId: "1", limit: 10 });
    const stmt = db.matching(/ranked/).at(-1)!;
    expect(stmt.text).not.toMatch(/OFFSET/i);
    expect(stmt.text).toMatch(/l\.rep_id = \$1::bigint/);
    expect(stmt.params[0]).toBe("1");
  });

  it("clamps the limit to 200 whatever a caller asks for", () => {
    expect(clampLimit(10_000)).toBe(MAX_PAGE);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(50);
  });
});

describe("upsertSubscriptionRow", () => {
  it("keeps an existing clientState rather than rotating it on every run", async () => {
    db.respond = () => [
      {
        id: "1",
        mailbox: "kelsea@headpinz.com",
        folder: "inbox",
        subscription_id: null,
        client_state: "already-minted",
        expires_at: null,
        status: "active",
        last_error: null,
        updated_at: "2026-09-13T00:00:00Z",
      },
    ];
    const row = await upsertSubscriptionRow("Kelsea@HeadPinz.com", "inbox", "fresh");
    const stmt = db.matching(/INSERT INTO crm_graph_subscriptions/)[0];
    expect(stmt.text).toMatch(/ON CONFLICT \(mailbox, folder\) DO UPDATE SET updated_at = NOW\(\)/);
    expect(stmt.params[0]).toBe("kelsea@headpinz.com");
    expect(row.clientState).toBe("already-minted");
  });
});

describe("mapEmailLinkRow", () => {
  it("keeps every id a string and never lets a bad enum through", () => {
    const row = mapEmailLinkRow({
      ...RAW_ROW,
      send_status: "nonsense",
      provider: "carrier-pigeon",
    });
    expect(row.id).toBe("500");
    expect(row.leadId).toBe("1042");
    expect(row.sendStatus).toBe("received");
    expect(row.provider).toBeNull();
    expect(row.toEmails).toEqual(["dana@example.com"]);
    expect(row.ccEmails).toEqual([]);
  });
});
