import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * KEYSET PAGING ON THE WHOLE SORT KEY (R10).
 *
 * Both pagers order by `(timestamp DESC, id DESC)`. They used to cursor on the
 * timestamp alone with a strict `<`, so two rows sharing an instant — a
 * template send and the system line that follows it, or a burst of MO callbacks
 * — were silently dropped when the tie straddled a page boundary: the page
 * ended mid-tie and the next query excluded the entire tie.
 *
 * The fix is a composite cursor (`<iso>|<id>`) compared as a ROW VALUE, which
 * matches the ORDER BY exactly. These tests pin the encoding, the SQL, and the
 * tie case itself.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ft/db")>()),
  sql: () => db.q,
  isDbConfigured: () => true,
}));

const { decodeMessageCursor, encodeMessageCursor, listMessagesForThreads } =
  await import("./messages-db");
const { decodeThreadCursor, encodeThreadCursor, listThreads } = await import("./threads-db");

const SAME_INSTANT = "2026-09-13T12:00:00.000Z";

function messageRow(id: string, occurredAt = SAME_INSTANT) {
  return {
    id,
    thread_id: "55",
    lead_id: null,
    direction: "out",
    kind: "sms",
    body: `body ${id}`,
    sent_from: "+12392058142",
    provider: "vox",
    provider_message_id: `vx_${id}`,
    delivery_status: null,
    delivery_error: null,
    send_status: "sent",
    fallback_did: false,
    template_id: null,
    actor_email: "kelsea@headpinz.com",
    occurred_at: occurredAt,
  };
}

beforeEach(() => db.reset());

describe("cursor encoding", () => {
  it("round-trips, and refuses anything that is not one of ours", () => {
    const c = { occurredAt: SAME_INSTANT, id: "902" };
    expect(encodeMessageCursor(c)).toBe(`${SAME_INSTANT}|902`);
    expect(decodeMessageCursor(encodeMessageCursor(c))).toEqual(c);

    expect(decodeMessageCursor(null)).toBeNull();
    expect(decodeMessageCursor("")).toBeNull();
    // A bare timestamp — the OLD cursor shape — is refused rather than read as
    // half a key, so a stale link pages from the top instead of skipping rows.
    expect(decodeMessageCursor(SAME_INSTANT)).toBeNull();
    expect(decodeMessageCursor("|902")).toBeNull();
    expect(decodeMessageCursor(`${SAME_INSTANT}|not-an-id`)).toBeNull();

    const t = { lastMessageAt: SAME_INSTANT, id: "55" };
    expect(decodeThreadCursor(encodeThreadCursor(t))).toEqual(t);
    expect(decodeThreadCursor("garbage")).toBeNull();
  });
});

describe("listMessagesForThreads", () => {
  it("compares the ROW VALUE (occurred_at, id), matching its own ORDER BY", async () => {
    db.respond = () => [];
    await listMessagesForThreads(["55"], {
      limit: 1,
      before: { occurredAt: SAME_INSTANT, id: "902" },
    });
    const stmt = db.matching(/FROM crm_sms_messages/).at(-1);
    expect(stmt?.text).toContain("(occurred_at, id) < ($2::timestamptz, $3::bigint)");
    expect(stmt?.text).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(stmt?.params[1]).toBe(SAME_INSTANT);
    expect(stmt?.params[2]).toBe("902");
  });

  it("TWO MESSAGES AT THE SAME INSTANT, SPLIT ACROSS A limit:1 PAGE — the second is not lost", async () => {
    // Page one returns the newer of the tied pair (higher id wins on DESC).
    db.respond = (stmt) => (/FROM crm_sms_messages/.test(stmt.text) ? [messageRow("902")] : []);
    const first = await listMessagesForThreads(["55"], { limit: 1 });
    expect(first.map((m) => m.id)).toEqual(["902"]);

    // The cursor carries the id as well as the instant, so the tied sibling is
    // still inside the range. With the old timestamp-only `<` cursor the next
    // query's predicate would have been `occurred_at < <that same instant>`,
    // which excludes row 901 for ever.
    const cursor = encodeMessageCursor({
      occurredAt: first[0].occurredAt,
      id: first[0].id,
    });
    db.reset();
    db.respond = (stmt) => (/FROM crm_sms_messages/.test(stmt.text) ? [messageRow("901")] : []);
    const second = await listMessagesForThreads(["55"], {
      limit: 1,
      before: decodeMessageCursor(cursor),
    });

    expect(second.map((m) => m.id)).toEqual(["901"]);
    const stmt = db.matching(/FROM crm_sms_messages/).at(-1);
    // Same instant on both sides of the boundary — only the id separates them.
    expect(stmt?.params[1]).toBe(SAME_INSTANT);
    expect(stmt?.params[2]).toBe("902");
  });
});

describe("listThreads", () => {
  it("uses the composite cursor too", async () => {
    db.respond = () => [];
    await listThreads({
      scope: { kind: "rep", repId: "7" },
      limit: 1,
      before: { lastMessageAt: SAME_INSTANT, id: "55" },
    });
    const stmt = db.matching(/FROM crm_sms_threads t/).at(-1);
    expect(stmt?.text).toContain("(t.last_message_at, t.id) < ($2::timestamptz, $3::bigint)");
    expect(stmt?.text).toContain("ORDER BY t.last_message_at DESC, t.id DESC");
    expect(stmt?.params[1]).toBe(SAME_INSTANT);
    expect(stmt?.params[2]).toBe("55");
  });
});
