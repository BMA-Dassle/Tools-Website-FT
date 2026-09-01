import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The shell is the ONLY human door into the FastTrax admin tools, so this file
 * is the door's contract: who gets in, who gets bounced to Microsoft, who gets
 * told they lack a role, and — the part that is easy to get wrong — who gets a
 * 401 or a 404 instead of a redirect they can't use.
 *
 * `auth()` is stubbed to the identity function so the handler under test is
 * called directly with a request whose `.auth` we control. That is exactly what
 * Auth.js does at runtime (it resolves the session, attaches it, and calls the
 * handler); stubbing it keeps these tests free of a gateway, a network and a
 * cookie jar.
 */
vi.mock("./auth", () => ({
  auth: (handler: unknown) => handler,
  hasAccess: (session: { roles?: string[] } | null) => !!session?.roles?.includes("access"),
}));

const TOKEN = "a".repeat(32);
const PROXY_KEY = "p".repeat(40);
const UPSTREAM = "https://headpinz.com";

const STAFF = { user: { email: "eric@headpinz.com", name: "Eric Osborn" }, roles: ["access"] };
const NO_ROLE = { user: { email: "temp@headpinz.com", name: "Temp" }, roles: [] };

type Handler = (req: NextRequest & { auth: unknown }) => Response;

/**
 * The routing handler, not the default export. `auth()` is mocked to the
 * identity function above, so with a non-lazy config the two would be the same
 * object — but auth.ts uses a config FACTORY, for which next-auth returns an
 * async wrapper, so the default export has to await it (see proxy.ts). Driving
 * the named export keeps every case below synchronous; the shape of the default
 * export is pinned separately in proxy.contract.test.ts.
 */
async function proxy(): Promise<Handler> {
  return (await import("./proxy")).handleAdminRouting as unknown as Handler;
}

function req(
  path: string,
  opts: { auth?: unknown; method?: string; headers?: Record<string, string> } = {},
) {
  const r = new NextRequest(new URL(path, "https://admin.fasttraxent.com"), {
    method: opts.method ?? "GET",
    headers: { "sec-fetch-mode": "navigate", ...(opts.headers ?? {}) },
  });
  Object.defineProperty(r, "auth", { value: opts.auth ?? null, writable: true });
  return r as NextRequest & { auth: unknown };
}

/** An XHR from a board: not a navigation, so never redirectable. */
const xhr = (path: string, auth?: unknown) =>
  req(path, { auth, headers: { "sec-fetch-mode": "cors", accept: "application/json" } });

beforeEach(() => {
  process.env.ADMIN_CAMERA_TOKEN = TOKEN;
  process.env.ADMIN_PROXY_KEY = PROXY_KEY;
  delete process.env.ADMIN_UPSTREAM_ORIGIN;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.ADMIN_CAMERA_TOKEN;
  delete process.env.ADMIN_PROXY_KEY;
  delete process.env.ADMIN_UPSTREAM_ORIGIN;
});

describe("no session", () => {
  it("sends a page GET to Auth.js, carrying the board they asked for", async () => {
    const res = (await proxy())(req("/pit?loc=ft"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/api/auth/signin");
    expect(loc.searchParams.get("callbackUrl")).toBe("/pit?loc=ft");
    expect(loc.origin).toBe("https://admin.fasttraxent.com");
  });

  it("401s an API call instead of redirecting it — a fetch cannot follow a login", async () => {
    const res = (await proxy())(xhr("/api/admin/videos/list"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "sso_expired" });
  });

  it("404s assets and non-navigations rather than polluting the callback", async () => {
    for (const r of [
      xhr("/_next/static/chunks/main.js"),
      req("/favicon.ico", { headers: { "sec-fetch-mode": "no-cors" } }),
      req("/pit", { method: "POST" }),
    ]) {
      expect((await proxy())(r).status, r.nextUrl.pathname).toBe(404);
    }
  });

  it("404s a path that is not a staff surface — no sign-in to advertise", async () => {
    for (const p of ["/", "/book", "/racing", "/pits"]) {
      expect((await proxy())(req(p)).status, p).toBe(404);
    }
  });

  it("lets Auth.js's own routes and the SSO pages through — gating them is a redirect loop", async () => {
    for (const p of [
      "/api/auth/signin",
      "/api/auth/callback/headpinz",
      "/sso/error",
      "/sso/diag",
    ]) {
      const res = (await proxy())(req(p));
      expect(res.status, p).toBe(200);
      expect(res.headers.get("location"), p).toBeNull();
    }
  });

  it("lets the callback through as a POST too — form_post responses are not GETs", async () => {
    const res = (await proxy())(
      req("/api/auth/callback/headpinz", { method: "POST", headers: { "sec-fetch-mode": "cors" } }),
    );
    expect(res.status).toBe(200);
  });
});

describe("signed in without the role", () => {
  it("explains rather than looping back to Microsoft", async () => {
    const res = (await proxy())(req("/pit", { auth: NO_ROLE }));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/sso/error");
    expect(loc.searchParams.get("code")).toBe("SSO_E_NO_ROLE");
    // The original query is dropped — it belonged to a board, not to an error.
    expect(loc.searchParams.get("loc")).toBeNull();
  });

  it("403s an API call — an XHR cannot read an HTML apology either", async () => {
    // Same reasoning as the 401 in the no-session block: a fetch that follows a
    // 302 gets a page and reports a JSON parse error. 403 rather than 401
    // because re-authenticating is exactly what will NOT help here.
    const res = (await proxy())(xhr("/api/admin/videos/list", NO_ROLE));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    await expect(res.json()).resolves.toEqual({ error: "sso_no_role" });
  });

  it("404s assets and non-navigations rather than redirecting them to a page", async () => {
    for (const r of [
      xhr("/_next/static/chunks/main.js", NO_ROLE),
      req("/favicon.ico", { auth: NO_ROLE, headers: { "sec-fetch-mode": "no-cors" } }),
      req("/pit", { auth: NO_ROLE, method: "POST" }),
    ]) {
      const res = (await proxy())(r);
      expect(res.status, r.nextUrl.pathname).toBe(404);
      expect(res.headers.get("location"), r.nextUrl.pathname).toBeNull();
    }
  });

  it("still reaches /sso/error itself, or the page could never render", async () => {
    expect((await proxy())(req("/sso/error?code=SSO_E_NO_ROLE", { auth: NO_ROLE })).status).toBe(
      200,
    );
  });
});

describe("signed in with the role — today's routing, unchanged", () => {
  it("rewrites a clean tool URL to the tokened admin path upstream", async () => {
    const res = (await proxy())(req("/pit?board=1", { auth: STAFF }));
    const rewrite = res.headers.get("x-middleware-rewrite")!;
    expect(rewrite).toBe(`${UPSTREAM}/admin/${TOKEN}/pit?board=1`);
  });

  it("carries the proxy key and the signed-in identity upstream", async () => {
    const res = (await proxy())(req("/reservations", { auth: STAFF }));
    expect(res.headers.get("x-middleware-request-x-admin-proxy-key")).toBe(PROXY_KEY);
    expect(res.headers.get("x-middleware-request-x-sso-email")).toBe("eric@headpinz.com");
    expect(res.headers.get("x-middleware-request-x-sso-name")).toBe("Eric Osborn");
  });

  it("forwards api traffic and assets at the same path", async () => {
    const api = (await proxy())(xhr("/api/admin/videos/list?limit=5", STAFF));
    expect(api.headers.get("x-middleware-rewrite")).toBe(
      `${UPSTREAM}/api/admin/videos/list?limit=5`,
    );
    const asset = (await proxy())(xhr("/_next/static/chunks/main.js", STAFF));
    expect(asset.headers.get("x-middleware-rewrite")).toBe(
      `${UPSTREAM}/_next/static/chunks/main.js`,
    );
  });

  it("307s a real-token URL back to the clean form, query intact", async () => {
    const res = (await proxy())(req(`/admin/${TOKEN}/pit?loc=ft`, { auth: STAFF }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://admin.fasttraxent.com/pit?loc=ft");
  });

  it("maps the daily-events shim clean→clean so no token ever hits a Location header", async () => {
    const res = (await proxy())(req("/daily-events?date=2026-08-28", { auth: STAFF }));
    expect(res.headers.get("location")).toBe(
      "https://admin.fasttraxent.com/daily-events-v2?date=2026-08-28",
    );
  });

  it("still 404s everything that is not a staff surface", async () => {
    for (const p of ["/", "/book", "/kiosk/admin", "/tv"]) {
      expect((await proxy())(req(p, { auth: STAFF })).status, p).toBe(404);
    }
  });

  it("honours ADMIN_UPSTREAM_ORIGIN for local dev", async () => {
    process.env.ADMIN_UPSTREAM_ORIGIN = "http://localhost:3111";
    const res = (await proxy())(req("/pit", { auth: STAFF }));
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      `http://localhost:3111/admin/${TOKEN}/pit`,
    );
  });

  it("fails closed to 404 when ADMIN_CAMERA_TOKEN is unset, even for staff", async () => {
    delete process.env.ADMIN_CAMERA_TOKEN;
    expect((await proxy())(req("/pit", { auth: STAFF })).status).toBe(404);
  });

  it("omits the identity headers when the session carries no name/email", async () => {
    const res = (await proxy())(req("/pit", { auth: { user: {}, roles: ["access"] } }));
    expect(res.headers.get("x-middleware-request-x-sso-email")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-sso-name")).toBeNull();
  });

  it("never lets the visitor write their own identity headers", async () => {
    // The upstream trusts x-sso-* BECAUSE they arrive with the proxy key. If a
    // caller's own header survived the copy, anyone signed in could sign the
    // admin audit trail as anyone else — and the nameless-session case above
    // was passing only because that test never sent one.
    const spoofed = {
      "x-sso-email": "ceo@headpinz.com",
      "x-sso-name": "Someone Else",
      "x-admin-proxy-key": "guessed",
    };
    const withSession = (await proxy())(req("/pit", { auth: STAFF, headers: spoofed }));
    expect(withSession.headers.get("x-middleware-request-x-sso-email")).toBe("eric@headpinz.com");
    expect(withSession.headers.get("x-middleware-request-x-sso-name")).toBe("Eric Osborn");
    expect(withSession.headers.get("x-middleware-request-x-admin-proxy-key")).toBe(PROXY_KEY);

    // …and with nothing to replace them with, they are dropped, not passed on.
    const nameless = (await proxy())(
      req("/pit", { auth: { user: {}, roles: ["access"] }, headers: spoofed }),
    );
    expect(nameless.headers.get("x-middleware-request-x-sso-email")).toBeNull();
    expect(nameless.headers.get("x-middleware-request-x-sso-name")).toBeNull();
  });

  it("drops a caller-supplied proxy key when this project has none of its own", async () => {
    delete process.env.ADMIN_PROXY_KEY;
    const res = (await proxy())(
      req("/pit", { auth: STAFF, headers: { "x-admin-proxy-key": "guessed" } }),
    );
    expect(res.headers.get("x-middleware-request-x-admin-proxy-key")).toBeNull();
  });
});
