import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public route, driven END TO END at the handler level — the one surface
 * in this CRM a guest touches, on a phone, from a link that has been sitting
 * in their messages for weeks.
 *
 * What is asserted, and why each one is a real failure rather than a nicety:
 *   302 to the blob URL          the whole point; a 200 with HTML would break
 *                                "tap the link, see the flyer";
 *   the open is recorded FIRST   a redirect that forgot to count is a share
 *                                report nobody can trust;
 *   410 says it in two languages the guest-facing copy rule — a Spanish-speaking
 *                                guest meeting an English-only dead end is the
 *                                half-translated screen the rule forbids;
 *   an expired link records NO open  otherwise "opens" counts dead taps;
 *   404 for an unknown token, with no hint  the answer must not tell a stranger
 *                                whether a token exists;
 *   no-store on EVERY answer     a CDN or mail proxy caching the 302 keeps
 *                                serving a revoked link and fakes the count;
 *   no admin credential anywhere the route must not read a session — if it
 *                                did, the first guest would get a 404.
 */

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  opens: [] as [string, string][],
}));

vi.mock("~/features/crm/collateral", async () => {
  const real = await vi.importActual<typeof import("~/features/crm/collateral/service/share")>(
    "~/features/crm/collateral/service/share",
  );
  return {
    openShare: real.openShare,
    getShareLinkForOpen: async () => store.row,
    recordShareOpen: async (token: string, key: string) => {
      store.opens.push([token, key]);
      return store.opens.length;
    },
  };
});

const { GET } = await import("./route");

const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNA";
const BLOB = "https://blob.example.com/crm/collateral/2026-09-13/pricing-abc.pdf";

function live(over: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    collateral_id: "7",
    lead_id: null,
    contact_id: null,
    rep_id: null,
    channel: "link",
    opened_at: null,
    last_opened_at: null,
    open_count: 0,
    expires_at: "2099-01-01T00:00:00.000Z",
    expired_at: null,
    created_by: "kelsea@headpinz.com",
    created_at: "2026-09-13T18:00:00.000Z",
    last_open_key: null,
    blob_url: BLOB,
    title: "Group Pricing HPFM 2026",
    collateral_archived_at: null,
    ...over,
  };
}

function req(token: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://headpinz.com/api/crm/share/${token}`, { headers });
}

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  store.row = live();
  store.opens = [];
});

describe("GET /api/crm/share/[token]", () => {
  it("records the open and 302s to the file", async () => {
    const res = await GET(
      req(TOKEN, { "x-forwarded-for": "1.2.3.4", "user-agent": "iPhone" }),
      ctx(TOKEN),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(BLOB);
    expect(store.opens).toHaveLength(1);
    expect(store.opens[0][0]).toBe(TOKEN);
    // The key is a hash, so the viewer is not in the row.
    expect(store.opens[0][1]).not.toContain("1.2.3.4");
  });

  it("never lets a CDN or a mail proxy cache the redirect", async () => {
    const res = await GET(req(TOKEN), ctx(TOKEN));
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers 410 in English AND Spanish once the link has expired", async () => {
    store.row = live({ expires_at: "2026-01-01T00:00:00.000Z" });
    const res = await GET(req(TOKEN), ctx(TOKEN));
    const body = await res.text();

    expect(res.status).toBe(410);
    expect(body).toContain("This link has expired");
    expect(body).toContain("Este enlace ha vencido");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(store.opens).toHaveLength(0);
  });

  it("says nothing about the file in the 410 — the link may have been forwarded", async () => {
    store.row = live({ expired_at: "2026-09-12T00:00:00.000Z" });
    const body = await (await GET(req(TOKEN), ctx(TOKEN))).text();
    expect(body).not.toContain("Group Pricing");
    expect(body).not.toContain(BLOB);
    expect(body).not.toContain(TOKEN);
  });

  it("treats an archived file as gone, so pulling a flyer kills its links", async () => {
    store.row = live({ collateral_archived_at: "2026-09-12T00:00:00.000Z" });
    expect((await GET(req(TOKEN), ctx(TOKEN))).status).toBe(410);
  });

  it("404s an unknown token the same way it 404s a malformed one", async () => {
    store.row = null;
    const unknown = await GET(req(TOKEN), ctx(TOKEN));
    const malformed = await GET(req("../../etc/passwd"), ctx("../../etc/passwd"));

    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await unknown.text()).toBe(await malformed.text());
    expect(store.opens).toHaveLength(0);
  });

  it("serves a guest with no session, no cookie and no admin token", async () => {
    const res = await GET(req(TOKEN), ctx(TOKEN));
    expect(res.status).toBe(302);
  });
});
