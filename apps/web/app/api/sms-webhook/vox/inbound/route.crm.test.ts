import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE MO WEBHOOK, REPLAYED THROUGH THE ROUTE ITSELF.
 *
 * `sms/service/inbound.test.ts` replays the captured payload through the
 * SERVICE seam (`parseMoPayload` → `handleInbound` → the effect). That leaves
 * the route's OWN wiring untested, and this is a public, guest-facing surface:
 *
 *   • `await allowedDids()` — a sync → async change on the hot path (C1);
 *   • the `enqueueReview` arrow that hands the message to `routeInbound`;
 *   • the `opted_out` / `opted_in` gate that decides whether a thread gets its
 *     STOP line;
 *   • and the `VOX_MO_TOKEN` gate that arms all of the above.
 *
 * So this test POSTs the RAW BYTES of the captured production payload
 * (`test/msw/fixtures/vox-mo.json.txt`, ids and numbers already redacted) with
 * the content type the real caller sends, through the exported `POST`. Neon is
 * the recording stub — every write the CRM branch makes is asserted as SQL, and
 * "wrote nothing" is asserted as the absence of an INSERT.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ft/db")>()),
  sql: () => db.q,
  isDbConfigured: () => true,
}));

/** Redis is the capture ring and the review queue — in-memory is enough. */
const redisCalls = vi.hoisted(() => ({ sets: [] as string[], lpush: [] as string[] }));
/** The review queue's own key (`features/sms/review-queue.ts`). */
const REVIEW_KEY = "sms:inbound:review";
vi.mock("@/lib/redis", () => {
  const tx = {
    incr: () => tx,
    expire: () => tx,
    set: () => tx,
    lpush: (k: string) => {
      redisCalls.lpush.push(k);
      return tx;
    },
    ltrim: () => tx,
    hincrby: () => tx,
    exec: async () => [],
  };
  return {
    default: {
      multi: () => tx,
      set: async (k: string) => {
        redisCalls.sets.push(k);
        return "OK";
      },
      get: async () => null,
      hincrby: async () => 1,
      expire: async () => 1,
      lrange: async () => [],
      hgetall: async () => ({}),
      llen: async () => 0,
    },
  };
});

/** The one real transport: the STOP auto-reply. Never actually sent. */
const sent = vi.hoisted(() => [] as { to: string; from: string | undefined }[]);
vi.mock("@/lib/sms-retry", () => ({
  voxSend: async (to: string, _body: string, opts?: { fromOverride?: string }) => {
    sent.push({ to, from: opts?.fromOverride });
    return { ok: true, status: 200, provider: "vox", sentFrom: opts?.fromOverride };
  },
}));

const { POST } = await import("./route");
const { fixtureText } = await import("@/test/msw/handlers/fixture");
const { resetDidCache } = await import("~/features/crm/sms");

const REP_DID = "+12392058142";
const A2P_DID = "+12394412867";
const GUEST = "+12395551234";
const TOKEN = "mo-token-under-test";

const repRow = {
  id: "7",
  slug: "kelsea",
  display_name: "Kelsea Kosco",
  first_name: "Kelsea",
  initials: "KK",
  role: "rep",
  email: "kelsea@headpinz.com",
  sso_sub: null,
  bmi_user_id: "28267036",
  bmi_username: "Kelsea Kosco",
  seven_shifts_user_id: null,
  vox_did: REP_DID,
  threecx_extension: null,
  teams_chat_id: null,
  phone_e164: null,
  centres: ["HPFM"],
  active: true,
  sort_order: 10,
};

const threadRow = {
  id: "55",
  rep_id: "7",
  rep_did: REP_DID,
  guest_e164: GUEST,
  contact_id: null,
  lead_id: null,
  last_message_at: null,
  last_inbound_at: null,
  read_at: null,
  unread_count: 0,
  stopped_at: null,
  created_at: "2026-09-13T00:00:00.000Z",
  updated_at: "2026-09-13T00:00:00.000Z",
};

const messageRow = {
  id: "901",
  thread_id: "55",
  lead_id: null,
  direction: "in",
  kind: "sms",
  body: "Yes, 6pm works for us",
  sent_from: GUEST,
  provider: "vox",
  provider_message_id: "vx_mo_01J7QA0B1C2D3E4F5G6H7J8K9M",
  delivery_status: null,
  delivery_error: null,
  send_status: "received",
  fallback_did: false,
  template_id: null,
  actor_email: null,
  occurred_at: "2026-09-12T23:31:12.000Z",
};

/** Neon, shaped: the roster has Kelsea, every write succeeds, nobody is known. */
function neonAnswers(stmt: { text: string }): unknown[] {
  if (/FROM crm_reps r/.test(stmt.text)) return [repRow];
  if (/SELECT vox_did FROM crm_reps/.test(stmt.text)) return [{ vox_did: REP_DID }];
  if (/INSERT INTO crm_sms_threads/.test(stmt.text)) return [threadRow];
  if (/INSERT INTO crm_sms_messages/.test(stmt.text)) return [messageRow];
  if (/INSERT INTO crm_activities/.test(stmt.text)) return [{ id: "1" }];
  return [];
}

/** The captured production body, byte for byte, with only `to` / `body` swapped. */
function capturedBody(over: Record<string, unknown> = {}): string {
  const raw = JSON.parse(fixtureText("vox-mo.json.txt")) as Record<string, unknown>;
  return JSON.stringify({ ...raw, ...over });
}

function post(body: string, query = `?k=${TOKEN}`) {
  return POST(
    new NextRequest(`https://headpinz.com/api/sms-webhook/vox/inbound${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

const inserted = (table: string) => db.matching(new RegExp(`INSERT INTO ${table}`));

beforeEach(() => {
  db.reset();
  db.respond = neonAnswers;
  redisCalls.sets.length = 0;
  redisCalls.lpush.length = 0;
  sent.length = 0;
  resetDidCache();
  vi.stubEnv("VOX_MO_TOKEN", TOKEN);
  vi.stubEnv("SMS_A2P_DID", A2P_DID);
});

describe("an MO on a REP's DID, replayed through the route", () => {
  it("is accepted, parsed against the UNION of env and roster DIDs, and lands in the thread", async () => {
    const res = await post(capturedBody({ to: REP_DID }));
    const json = (await res.json()) as { ok: boolean; captured: boolean; outcome: string };

    expect(json).toMatchObject({ ok: true, captured: true });
    // `allowedDids()` had to await the roster for this to parse at all — the
    // rep DID is in no env var.
    expect(json.outcome).not.toBe("not_parsed");
    expect(inserted("crm_sms_threads")).toHaveLength(1);
    expect(inserted("crm_sms_messages")).toHaveLength(1);
    const message = inserted("crm_sms_messages")[0];
    expect(message.params).toContain("vx_mo_01J7QA0B1C2D3E4F5G6H7J8K9M");
    expect(message.params).toContain("in");
    // An activity for the deal timeline, keyed by the Vox id so a retry is a no-op.
    expect(inserted("crm_activities")).toHaveLength(1);
  });

  it("a DUPLICATE callback leaves exactly one message row", async () => {
    let first = true;
    db.respond = (stmt) => {
      if (/INSERT INTO crm_sms_messages/.test(stmt.text)) {
        if (!first) return []; // the partial unique index refuses the second
        first = false;
        return [messageRow];
      }
      return neonAnswers(stmt);
    };

    await post(capturedBody({ to: REP_DID }));
    const afterFirst = db.matching(/UPDATE crm_sms_threads[\s\S]*unread_count = unread_count \+ 1/);
    await post(capturedBody({ to: REP_DID }));
    const afterSecond = db.matching(
      /UPDATE crm_sms_threads[\s\S]*unread_count = unread_count \+ 1/,
    );

    expect(afterFirst).toHaveLength(1);
    // The second arrival stops before the unread bump, so the count is still 1.
    expect(afterSecond).toHaveLength(1);
  });
});

describe("an MO on the A2P DID", () => {
  it("goes to the review queue and writes NO CRM row — today's behaviour, untouched", async () => {
    const res = await post(capturedBody({ to: A2P_DID }));
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(inserted("crm_sms_messages")).toEqual([]);
    expect(inserted("crm_sms_threads")).toEqual([]);
  });
});

describe("STOP on a rep's DID", () => {
  it("suppresses, answers FROM THAT DID, and leaves a system line in the thread", async () => {
    const res = await post(capturedBody({ to: REP_DID, body: "STOP" }));
    const json = (await res.json()) as { outcome: string };

    expect(json.outcome).toBe("opted_out");
    // The consent ledger — the thing that actually decides.
    expect(
      inserted("sms_consent_events").length + inserted("sms_suppression").length,
    ).toBeGreaterThan(0);
    // The reply goes back to the number the guest texted, NOT the A2P one. With
    // rep DIDs in `allowedDids()` the old `allowedDids()[0]` would have answered
    // a STOP to Kelsea's number from a number the guest has never seen.
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(REP_DID);
    expect(sent[0].from).not.toBe(A2P_DID);
    // And the rep can see why their composer is now closed.
    const systemLine = inserted("crm_sms_messages").find((s) => s.params.includes("vox-keyword"));
    expect(systemLine).toBeDefined();
    expect(db.matching(/UPDATE crm_sms_threads\s+SET stopped_at/)).toHaveLength(1);
  });
});

describe("the token gate", () => {
  it("a WRONG ?k= is counted and dropped — nothing is parsed, nothing is written", async () => {
    const res = await post(capturedBody({ to: REP_DID }), "?k=not-the-token");
    expect((await res.json()) as { ok: boolean; error: string }).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(inserted("crm_sms_messages")).toEqual([]);
    expect(inserted("crm_sms_threads")).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("WITH VOX_MO_TOKEN UNSET the CRM branch is disarmed: review queue, no crm_sms_messages row", async () => {
    // Fail-open bring-up mode. An anonymous caller must not be able to
    // MANUFACTURE an inbound message — `hasInboundFrom` treats exactly that row
    // as the R8 consent basis that unlocks texting a cold contact.
    vi.stubEnv("VOX_MO_TOKEN", "");

    const res = await post(capturedBody({ to: REP_DID }), "");
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true, captured: true });

    expect(inserted("crm_sms_messages")).toEqual([]);
    expect(inserted("crm_sms_threads")).toEqual([]);
    // The message is not lost: it is captured in the ring AND parked in the
    // review queue, which is exactly where an A2P message goes today.
    expect(redisCalls.lpush).toContain(REVIEW_KEY);
  });

  it("and a STOP in that mode still reaches the ledger but never touches a CRM thread", async () => {
    vi.stubEnv("VOX_MO_TOKEN", "");
    await post(capturedBody({ to: REP_DID, body: "STOP" }), "");

    expect(inserted("crm_sms_messages")).toEqual([]);
    expect(db.matching(/UPDATE crm_sms_threads\s+SET stopped_at/)).toEqual([]);
    // Consent is still recorded — taking consent away never needs arming.
    expect(
      inserted("sms_consent_events").length + inserted("sms_suppression").length,
    ).toBeGreaterThan(0);
  });
});
