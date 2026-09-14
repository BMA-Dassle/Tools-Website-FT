import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmRep } from "../../core/types";

/**
 * WHOSE CONVERSATIONS — the three scopes, at the SQL boundary.
 *
 * The bug this pins: `repId: null` used to mean BOTH "director, show the team"
 * and "we could not find a rep row for this session". `core/identity.ts:70-78`
 * degrades `rep` to `null` on purpose whenever the roster lookup throws, so one
 * transient Neon error promoted an ordinary rep to a team-wide reader — and
 * `markConversationRead` then zeroed every colleague's unread count for that
 * person, which is the exact opposite of the rule its own comment stated.
 *
 * A person we cannot identify now gets the EMPTY view, never the widest one.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
// A PARTIAL mock: `threads.ts` reaches the leads sub (links-db's schema guard),
// which reaches `bmi-office.ts` and its `BMI_ID_FIELDS`. Only the connection is
// replaced; every real constant stays real.
vi.mock("@ft/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ft/db")>()),
  sql: () => db.q,
  isDbConfigured: () => true,
}));

const { listThreads, unreadTotal } = await import("../data/threads-db");
const { conversationScopeFor, loadConversations, markConversationRead } = await import("./threads");

function rep(over: Partial<CrmRep> = {}): CrmRep {
  return {
    id: "7",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    role: "rep",
    email: "kelsea@headpinz.com",
    ssoSub: null,
    bmiUserId: null,
    bmiUserIds: null,
    bmiUsername: null,
    sevenShiftsUserId: null,
    voxDid: "+12392058142",
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: [],
    active: true,
    sortOrder: 10,
    ...over,
  };
}

beforeEach(() => db.reset());

describe("conversationScopeFor", () => {
  it("a director who asked for the team gets the team", () => {
    expect(conversationScopeFor(rep(), true)).toEqual({ kind: "team" });
    // Even a director with no rep row of their own.
    expect(conversationScopeFor(null, true)).toEqual({ kind: "team" });
  });

  it("a rep gets their own", () => {
    expect(conversationScopeFor(rep(), false)).toEqual({ kind: "rep", repId: "7" });
  });

  it("NO REP ROW GETS NOTHING — never the team", () => {
    expect(conversationScopeFor(null, false)).toEqual({ kind: "none" });
  });
});

describe("listThreads", () => {
  it("scope 'none' runs no query at all and returns nothing", async () => {
    const out = await listThreads({ scope: { kind: "none" } });
    expect(out).toEqual([]);
    expect(db.statements).toEqual([]);
  });

  it("defaults to 'none' when no scope is passed — a forgotten argument shows nothing", async () => {
    expect(await listThreads()).toEqual([]);
    expect(db.statements).toEqual([]);
  });

  it("scope 'rep' filters on rep_id; scope 'team' passes null for the filter", async () => {
    await listThreads({ scope: { kind: "rep", repId: "7" } });
    const mine = db.matching(/FROM crm_sms_threads t/).at(-1);
    expect(mine?.params[0]).toBe("7");

    db.reset();
    await listThreads({ scope: { kind: "team" } });
    const team = db.matching(/FROM crm_sms_threads t/).at(-1);
    expect(team?.params[0]).toBeNull();
  });
});

describe("unreadTotal", () => {
  it("scope 'none' is zero without a query", async () => {
    expect(await unreadTotal({ kind: "none" })).toBe(0);
    expect(db.statements).toEqual([]);
  });

  it("scope 'rep' sums only that rep's", async () => {
    db.respond = () => [{ n: 4 }];
    expect(await unreadTotal({ kind: "rep", repId: "7" })).toBe(4);
    expect(db.matching(/SUM\(unread_count\)/).at(-1)?.params[0]).toBe("7");
  });
});

describe("loadConversations", () => {
  it("A SIGNED-IN USER WITH NO REP ROW GETS AN EMPTY PAGE, not the whole team's", async () => {
    db.respond = () => {
      throw new Error("scope 'none' must not reach Neon");
    };
    const page = await loadConversations({
      scope: conversationScopeFor(null, false),
      reps: [rep()],
    });
    expect(page).toEqual({ conversations: [], nextCursor: null, unread: 0 });
    expect(db.statements).toEqual([]);
  });
});

describe("markConversationRead", () => {
  it("A DIRECTOR READING OVER A SHOULDER MARKS NOTHING READ", async () => {
    // Two threads exist for this person, neither of them the caller's.
    db.respond = (stmt) =>
      /FROM crm_sms_threads t\s+WHERE t.contact_id/.test(stmt.text)
        ? [threadRow("1", "7"), threadRow("2", "8")]
        : [{ n: 0 }];

    const out = await markConversationRead("c-9", null);

    expect(out).toEqual({ unread: 0 });
    expect(db.matching(/UPDATE crm_sms_threads\s+SET unread_count = 0/)).toEqual([]);
  });

  it("a rep clears only their OWN threads for that person", async () => {
    db.respond = (stmt) =>
      /FROM crm_sms_threads t\s+WHERE t.contact_id/.test(stmt.text)
        ? [threadRow("1", "7"), threadRow("2", "8")]
        : [{ n: 1 }];

    await markConversationRead("c-9", rep());

    const update = db.matching(/UPDATE crm_sms_threads\s+SET unread_count = 0/).at(-1);
    expect(update?.params[0]).toEqual(["1"]);
  });
});

function threadRow(id: string, repId: string) {
  return {
    id,
    rep_id: repId,
    rep_did: "+1239205814" + repId,
    guest_e164: "+12395551234",
    contact_id: "9",
    lead_id: null,
    last_message_at: "2026-09-13T12:00:00.000Z",
    last_inbound_at: null,
    read_at: null,
    unread_count: 1,
    stopped_at: null,
    created_at: "2026-09-13T00:00:00.000Z",
    updated_at: "2026-09-13T00:00:00.000Z",
  };
}
