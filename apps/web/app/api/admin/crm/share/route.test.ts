import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The share route, at the handler level. Three things are worth a test here,
 * and all three were wrong or untested at some point:
 *
 *   a revoke answers with THIS FILE's links   it used to call
 *        `listSharesFor({collateralId: null, leadId: null, limit: 50})` — the
 *        newest 50 rows in the whole table, i.e. capability tokens minted by
 *        other reps for other guests, handed to a caller who asked about one
 *        file and painted into the sheet as its history;
 *   revoke is director-only                   a rep can always mint another
 *        link; pulling one back is a curation act, like archiving;
 *   a share carrying a lead comes back with it  the headline path of this PR
 *        (share from a deal, attributed to the lead) — it 500d for weeks
 *        because the lead lookup could not be planned.
 */

/** Real-shaped tokens: 22 base64url characters, exactly what the minter makes. */
const T = vi.hoisted(() => ({
  old: "S2V5T2xkU2hhcmVUb2tlbg",
  fresh: "TmV3U2hhcmVUb2tlbkFiY2Q",
  unknown: "VW5rbm93blNoYXJlVG9rZW4",
}));

const bag = vi.hoisted(() => ({
  session: null as unknown,
  link: null as Record<string, unknown> | null,
  revoked: [] as string[],
  listedWith: [] as unknown[],
  audits: [] as unknown[],
}));

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(bag.session),
  hasAdminAccess: (s: { roles?: string[] } | null | undefined) => !!s?.roles?.includes("access"),
}));

vi.mock("~/features/crm/reps", () => ({ findRepByLoginEmail: async () => null }));

vi.mock("~/features/crm/core/data/audit-db", () => ({
  writeAudit: async (entry: unknown) => {
    bag.audits.push(entry);
  },
}));

vi.mock("~/features/crm/collateral", () => ({
  ShareError: class ShareError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  createShare: async (input: { collateralId: string; lead: string | null }) => ({
    share: {
      token: T.fresh,
      url: `https://headpinz.com/api/crm/share/${T.fresh}`,
      collateralId: input.collateralId,
      leadId: input.lead ? "4211" : null,
      channel: "link",
      openCount: 0,
      expiresAt: "2026-10-13T18:00:00.000Z",
      expiredAt: null,
      createdAt: "2026-09-13T18:00:00.000Z",
    },
    lead: input.lead ? { id: "4211", publicId: "L-1042", label: "L-1042 · Lee Health" } : null,
  }),
  findShareLead: async (value: string) =>
    value === "L-1042" ? { id: "4211", publicId: "L-1042", label: "L-1042 · Lee Health" } : null,
  getShareLink: async (token: string) => (token === T.old ? bag.link : null),
  listSharesFor: async (filter: unknown) => {
    bag.listedWith.push(filter);
    return [{ token: T.old, collateralId: "7" }];
  },
  revokeShare: async (token: string) => {
    bag.revoked.push(token);
    return true;
  },
  // Named only because `jobs/registry.ts` reads it from this barrel while the
  // route's import graph is assembled; nothing in this file calls it.
  shareLinkExpireHandler: async () => ({ ok: true }),
  shareLinkExpireIdempotencyKey: () => "share-link-expire:test",
}));

const { GET, POST } = await import("./route");

const STATIC = "static-admin-token-for-tests";
const URL_SHARE = "http://localhost:3000/api/admin/crm/share";

function session(roles: string[], email = "eric@headpinz.com") {
  return { user: { email, name: "Eric" }, roles, sub: "oid", expires: "2026-09-14T00:00:00.000Z" };
}

const get = (qs: string) =>
  new NextRequest(`${URL_SHARE}${qs}`, { method: "GET", headers: { "x-admin-token": STATIC } });

const post = (body: unknown) =>
  new NextRequest(URL_SHARE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": STATIC },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.ADMIN_CAMERA_TOKEN = STATIC;
  delete process.env.ADMIN_API_SIGNING_SECRET;
  delete process.env.ADMIN_PROXY_KEY;
  bag.session = session(["access", "sales-director"]);
  bag.link = { token: T.old, collateral_id: "7", expired_at: null };
  bag.revoked = [];
  bag.listedWith = [];
  bag.audits = [];
});

afterEach(() => {
  delete process.env.ADMIN_CAMERA_TOKEN;
});

describe("POST create", () => {
  it("mints a link for a file and says why text and email are not options yet", async () => {
    const res = await POST(post({ action: "create", collateralId: "7" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      share: { token: T.fresh, leadId: null },
      lead: null,
      delivery: { sms: "unavailable", email: "unavailable" },
    });
    expect(bag.audits[0]).toMatchObject({ action: "create", actorEmail: "eric@headpinz.com" });
  });

  it("attributes a share to the lead it was sent about", async () => {
    const res = await POST(post({ action: "create", collateralId: "7", lead: "L-1042" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      share: { leadId: "4211" },
      lead: { publicId: "L-1042" },
    });
  });

  it("lets a rep share — sharing is everyone's", async () => {
    bag.session = session(["access", "sales"], "kelsea@headpinz.com");
    const res = await POST(post({ action: "create", collateralId: "7" }));
    expect(res.status).toBe(200);
  });
});

describe("POST revoke", () => {
  it("is refused for a rep", async () => {
    bag.session = session(["access", "sales"], "kelsea@headpinz.com");
    const res = await POST(post({ action: "revoke", shareToken: T.old }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "director_only" });
    expect(bag.revoked).toEqual([]);
  });

  it("400s a token that is not share-token shaped, without touching the table", async () => {
    const res = await POST(post({ action: "revoke", shareToken: "tok-old" }));
    expect(res.status).toBe(400);
    expect(bag.revoked).toEqual([]);
  });

  it("404s an unknown token WITHOUT revoking anything", async () => {
    const res = await POST(post({ action: "revoke", shareToken: T.unknown }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "share_not_found" });
    expect(bag.revoked).toEqual([]);
  });

  it("answers with THIS file's links only — never the newest 50 in the table", async () => {
    const res = await POST(post({ action: "revoke", shareToken: T.old }));
    expect(res.status).toBe(200);
    expect(bag.revoked).toEqual([T.old]);
    expect(bag.listedWith).toEqual([{ collateralId: "7", limit: 50 }]);
    expect(await res.json()).toMatchObject({ ok: true, shares: [{ token: T.old }] });
    expect(bag.audits[0]).toMatchObject({ action: "revoke", entityId: T.old });
  });
});

describe("GET", () => {
  it("insists on a filter rather than listing the whole table", async () => {
    const res = await GET(get(""));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "collateralId_or_lead" });
    expect(bag.listedWith).toEqual([]);
  });

  it("answers an empty list for a lead that does not exist", async () => {
    const res = await GET(get("?lead=L-9999"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, shares: [] });
    expect(bag.listedWith).toEqual([]);
  });

  it("scopes by lead when one resolves", async () => {
    await GET(get("?lead=L-1042"));
    expect(bag.listedWith).toEqual([{ collateralId: null, leadId: "4211", limit: 50 }]);
  });
});
