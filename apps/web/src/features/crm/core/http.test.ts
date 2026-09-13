import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";

/**
 * The `withCrmRoute` chain, pinned step by step (brief §3.4).
 *
 * `@/auth` and the reps lookup are mocked; `lib/admin-request-auth.ts` is the
 * REAL module, driven through `ADMIN_CAMERA_TOKEN` — the two-branch
 * `isAdminApiRequest` call is the thing this file exists to protect, so it is
 * exercised against the real predicate rather than a stub of it.
 */

const bag = vi.hoisted(() => ({
  session: null as unknown,
  authImpl: null as null | (() => Promise<unknown>),
}));

vi.mock("@/auth", () => ({
  auth: () => (bag.authImpl ? bag.authImpl() : Promise.resolve(bag.session)),
  hasAdminAccess: (s: { roles?: string[] } | null | undefined) => !!s?.roles?.includes("access"),
}));

vi.mock("~/features/crm/reps", () => ({
  findRepByLoginEmail: async () => null,
}));

const { CrmHttpError, withCrmRoute } = await import("./http");

const STATIC = "static-admin-token-for-tests";
const URL_ME = "http://localhost:3000/api/admin/crm/me";

function rep() {
  return {
    user: { email: "Kelsea@headpinz.com", name: "Kelsea Kosco" },
    roles: ["access", "sales"],
    sub: "oid",
    expires: "2026-09-13T00:00:00.000Z",
  };
}
function director() {
  return {
    ...rep(),
    user: { email: "eric@headpinz.com", name: "Eric" },
    roles: ["access", "sales-director"],
  };
}

const get = (url: string, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: "GET", headers });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const echo = withCrmRoute(z.object({ q: z.string().optional() }), async ({ input, user }) => ({
  q: input.q ?? null,
  actor_email: user.email,
  role: user.role,
}));

beforeEach(() => {
  process.env.ADMIN_CAMERA_TOKEN = STATIC;
  delete process.env.ADMIN_API_SIGNING_SECRET;
  delete process.env.ADMIN_PROXY_KEY;
  bag.session = rep();
  bag.authImpl = null;
});
afterEach(() => {
  delete process.env.ADMIN_CAMERA_TOKEN;
});

describe("credential (step 3)", () => {
  it("no credential anywhere → 404 with the middleware's own API-gate body, never an {ok:false} envelope", async () => {
    // middleware.ts's /api/admin/* branch answers `{"error":"Not found"}` as
    // application/json; the route mirrors it byte for byte so nobody can tell
    // which layer refused, and crmFetch treats the non-envelope as "reload".
    const res = await echo(get(URL_ME));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.text()).toBe('{"error":"Not found"}');
  });

  it("a wrong header token → 404", async () => {
    const res = await echo(get(URL_ME, { "x-admin-token": "nope" }));
    expect(res.status).toBe(404);
  });

  it("the header token opens a GET", async () => {
    const res = await echo(get(`${URL_ME}?q=hi`, { "x-admin-token": STATIC }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      q: "hi",
      actor_email: "kelsea@headpinz.com",
      role: "rep",
    });
  });

  it("?token= opens a GET (the middleware accepts it there too)", async () => {
    const res = await echo(get(`${URL_ME}?token=${STATIC}`));
    expect(res.status).toBe(200);
  });

  it("body token BEATS the header: valid body + bad header → in", async () => {
    const res = await echo(post(URL_ME, { token: STATIC, q: "b" }, { "x-admin-token": "bad" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, q: "b" });
  });

  it("body token BEATS the header: bad body + valid header → 404", async () => {
    // This is the `isAdminApiRequest(req, {token})` contract: once a token key
    // is passed, the header is never consulted.
    const res = await echo(post(URL_ME, { token: "bad" }, { "x-admin-token": STATIC }));
    expect(res.status).toBe(404);
  });

  it("a POST with NO body token falls back to the header (the two-branch form)", async () => {
    // The regression the two-branch call prevents: `{token: undefined}` would
    // 404 this request.
    const res = await echo(post(URL_ME, { q: "x" }, { "x-admin-token": STATIC }));
    expect(res.status).toBe(200);
  });

  it("an unset ADMIN_CAMERA_TOKEN fails closed", async () => {
    delete process.env.ADMIN_CAMERA_TOKEN;
    const res = await echo(get(URL_ME, { "x-admin-token": STATIC }));
    expect(res.status).toBe(404);
  });
});

describe("session (step 4)", () => {
  const authed = () => get(URL_ME, { "x-admin-token": STATIC });

  it("valid credential + no session → 401 JSON {ok:false, error:'session'}", async () => {
    bag.session = null;
    const res = await echo(authed());
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(await res.json()).toEqual({ ok: false, error: "session" });
  });

  it("a session without a sales role → 403 JSON", async () => {
    bag.session = { ...rep(), roles: ["access"] };
    const res = await echo(authed());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "session" });
  });

  it("auth() throwing → 401, never 500", async () => {
    bag.authImpl = () => Promise.reject(new Error("AUTH_SECRET is missing"));
    const res = await echo(authed());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "session" });
  });

  it("director-only routes refuse a rep with 403 director_only and admit a director", async () => {
    const guarded = withCrmRoute(z.object({}), async ({ user }) => ({ who: user.email }), {
      director: true,
    });
    const asRep = await guarded(authed());
    expect(asRep.status).toBe(403);
    expect(await asRep.json()).toEqual({ ok: false, error: "director_only" });

    bag.session = director();
    const asDirector = await guarded(authed());
    expect(asDirector.status).toBe(200);
    expect(await asDirector.json()).toEqual({ ok: true, who: "eric@headpinz.com" });
  });

  it("the credential is checked BEFORE the session: no credential + no session is still 404", async () => {
    bag.session = null;
    const res = await echo(get(URL_ME));
    expect(res.status).toBe(404);
  });
});

describe("input (step 2) and the handler envelope (step 5)", () => {
  const hdr = { "x-admin-token": STATIC };

  it("a body that fails the schema → 400 with a short reason", async () => {
    const strict = withCrmRoute(z.object({ kind: z.enum(["noop", "seed"]) }), async () => ({}));
    const res = await strict(post(URL_ME, { kind: "nuke" }, hdr));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/^invalid_request: kind/);
  });

  it("malformed JSON is read as an empty body, so an all-optional schema still passes", async () => {
    const res = await echo(post(URL_ME, "{not json", hdr));
    expect(res.status).toBe(200);
  });

  it("route params arrive resolved (Next hands them as a promise)", async () => {
    const withId = withCrmRoute(z.object({}), async ({ params }) => ({ id: params.id }));
    const res = await withId(get(`http://localhost:3000/api/admin/crm/leads/L-7`, hdr), {
      params: Promise.resolve({ id: "L-7" }),
    });
    expect(await res.json()).toEqual({ ok: true, id: "L-7" });
  });

  it("a handler may return a Response and it passes through untouched", async () => {
    const raw = withCrmRoute(z.object({}), async () => new Response("csv,here", { status: 200 }));
    const res = await raw(get(URL_ME, hdr));
    expect(await res.text()).toBe("csv,here");
  });

  it("CrmHttpError becomes its status, with the Office prompt when given", async () => {
    const failing = withCrmRoute(z.object({}), async () => {
      throw new CrmHttpError(409, "office_prompt", {
        message: "Overbooking?",
        operationId: "op-1",
      });
    });
    const res = await failing(get(URL_ME, hdr));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: "office_prompt",
      officePrompt: { message: "Overbooking?", operationId: "op-1" },
    });
  });

  it("any other throw → 500 JSON, logged with actor_email", async () => {
    const boom = withCrmRoute(z.object({}), async () => {
      throw new Error("neon down");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await boom(get(URL_ME, hdr));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: "neon down" });
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls[0])).toContain("kelsea@headpinz.com");
    } finally {
      error.mockRestore();
    }
  });

  it("every JSON answer is no-store", async () => {
    const res = await echo(get(URL_ME, hdr));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
