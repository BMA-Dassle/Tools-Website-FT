import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "@auth/core/jwt";
import { middleware } from "./middleware";
import { SESSION_COOKIE, SECURE_SESSION_COOKIE } from "~/features/sso/session";
import {
  ADMIN_TOOL_SLUGS,
  DEVICE_TOKEN_TOOLS,
  SSO_ADMIN_TOOLS,
  TOKEN_ONLY_TOOLS,
} from "~/lib/constants/admin-tools";

/**
 * THE SSO MATRIX for the admin gate's newest credential: a Microsoft session.
 *
 * REAL COOKIES, NOT MOCKS. Every session in this file is minted with
 * `@auth/core/jwt`'s own `encode` — the exact function Auth.js uses to write
 * the cookie — and read back by the middleware's `decode`. That is the whole
 * point: the middleware does NOT wrap itself in Auth.js's `auth()` helper (see
 * the reasoning in `~/features/sso/session`), so the one thing that could
 * silently break is the middleware and `auth.ts` disagreeing about the cookie.
 * A mocked session would prove the branching and hide exactly that.
 *
 * The credential this file adds does not touch any other: `/admin/{token}/*`,
 * `/admin/embed/*` and `/api/admin/*` behave bit-for-bit as before, which is
 * `middleware.admin-gate.test.ts`'s job to keep proving — that file did not
 * change in this PR.
 */

const AUTH_SECRET = "sso-test-secret-not-a-real-one";
const TOKEN = "c".repeat(32);
const PROXY_KEY = "p".repeat(40);

/** A migrated tool and an unattended display, named once so the intent of each
 *  assertion below reads as "staffed" or "wall board" rather than as a slug. */
const STAFFED = "reservations";
const DISPLAY = "pit";

const ENV_KEYS = [
  "ADMIN_CAMERA_TOKEN",
  "ADMIN_ETICKETS_TOKEN",
  "ADMIN_PROXY_KEY",
  "ADMIN_API_SIGNING_SECRET",
  "ADMIN_EMBED_SECRET",
  "SALES_API_KEYS",
  "AUTH_SECRET",
  "ADMIN_HOSTS",
];

function env(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  env({
    ADMIN_CAMERA_TOKEN: TOKEN,
    ADMIN_PROXY_KEY: PROXY_KEY,
    AUTH_SECRET,
    ADMIN_ETICKETS_TOKEN: undefined,
    ADMIN_HOSTS: undefined,
  });
});

afterEach(() => env(Object.fromEntries(ENV_KEYS.map((k) => [k, undefined]))));

/**
 * A cookie Auth.js itself would have written. `salt` is the cookie NAME — the
 * two travel together, which is the detail that makes a hand-rolled decode
 * either work or silently never match.
 */
async function sessionCookie(
  payload: Record<string, unknown>,
  secret = AUTH_SECRET,
  name: string = SESSION_COOKIE,
): Promise<string> {
  const token = await encode({
    token: payload,
    secret,
    salt: name,
    maxAge: 8 * 60 * 60,
  });
  return `${name}=${token}`;
}

const staff = () =>
  sessionCookie({ email: "eric@headpinz.com", name: "Eric Osborn", roles: ["access"] });
const noRole = () =>
  sessionCookie({ email: "mkt@headpinz.com", name: "Marketing", roles: ["marketing"] });

/** http, so the cookie name is the unprefixed one `encode` was salted with. */
function req(
  url: string,
  { headers = {}, host = "fasttraxent.com", nav = false, method = "GET", https = false } = {} as {
    headers?: Record<string, string>;
    host?: string;
    nav?: boolean;
    method?: string;
    https?: boolean;
  },
): NextRequest {
  const h: Record<string, string> = { host, ...headers };
  if (nav) {
    h["sec-fetch-mode"] = "navigate";
    h.accept = "text/html,application/xhtml+xml";
  }
  return new NextRequest(new URL(url, `${https ? "https" : "http"}://${host}`), {
    headers: h,
    method,
  });
}

async function gate(url: string, opts: Parameters<typeof req>[1] = {}) {
  const res = await middleware(req(url, opts));
  return {
    status: res.status,
    via: res.headers.get("x-middleware-request-x-admin-via"),
    adminRoute: res.headers.get("x-middleware-request-x-admin-route"),
    email: res.headers.get("x-middleware-request-x-sso-email"),
    name: res.headers.get("x-middleware-request-x-sso-name"),
    location: res.headers.get("location"),
    rewrite: res.headers.get("x-middleware-rewrite"),
    contentType: res.headers.get("content-type"),
  };
}

describe("SSO gate — /admin/<tool> on a brand host", () => {
  it("sends an unauthenticated NAVIGATION to /sso/signin carrying the path it asked for", async () => {
    const r = await gate(`/admin/${STAFFED}?loc=ft`, { nav: true });
    expect(r.status).toBe(307);
    const loc = new URL(r.location!);
    expect(loc.pathname).toBe("/sso/signin");
    expect(loc.searchParams.get("callbackUrl")).toBe(`/admin/${STAFFED}?loc=ft`);
  });

  it("404s an unauthenticated NON-navigation — an XHR must not be redirected to Microsoft", async () => {
    // A board's fetch that follows a 307 parses a login page as JSON and
    // reports a syntax error instead of "your session ended".
    const xhr = await gate(`/admin/${STAFFED}`, { headers: { accept: "application/json" } });
    expect(xhr).toMatchObject({ status: 404, contentType: "text/plain" });

    const subresource = await gate(`/admin/${STAFFED}`, {
      headers: { "sec-fetch-mode": "no-cors" },
    });
    expect(subresource.status).toBe(404);

    const post = await gate(`/admin/${STAFFED}`, { method: "POST", nav: true });
    expect(post.status).toBe(404);
  });

  it("404s an RSC PREFETCH — a router prefetch is not a person who can sign in", async () => {
    // Next prefetches with ?_rsc=… and no navigate mode. Redirecting one would
    // put an HTML sign-in page where the router expects a flight payload.
    const prefetch = await gate(`/admin/${STAFFED}?_rsc=1a2b3`, {
      headers: { rsc: "1", "sec-fetch-mode": "cors" },
    });
    expect(prefetch).toMatchObject({ status: 404, contentType: "text/plain" });
  });

  it("sends a signed-in user WITHOUT the role to /sso/error, never back to Microsoft", async () => {
    // A second sign-in cannot add a role. Looping them is the failure this
    // branch exists to prevent.
    const r = await gate(`/admin/${STAFFED}`, { nav: true, headers: { cookie: await noRole() } });
    expect(r.status).toBe(307);
    const loc = new URL(r.location!);
    expect(loc.pathname).toBe("/sso/error");
    expect(loc.searchParams.get("code")).toBe("SSO_E_NO_ROLE");
  });

  it("404s a roleless NON-navigation too — an HTML explanation helps nothing that parses JSON", async () => {
    expect(
      await gate(`/admin/${STAFFED}`, {
        headers: { cookie: await noRole(), accept: "application/json" },
      }),
    ).toMatchObject({ status: 404 });
  });

  it("lets a valid session through, stamped with who it is", async () => {
    const r = await gate(`/admin/${STAFFED}`, { nav: true, headers: { cookie: await staff() } });
    expect(r.status).toBe(200);
    expect(r.adminRoute).toBe("1");
    expect(r.via).toBe("sso");
    expect(r.email).toBe("eric@headpinz.com");
    expect(r.name).toBe("Eric Osborn");
  });

  it("reads the __Secure- cookie on https, where that is the only name a browser sends", async () => {
    // The prefix is chosen from the protocol AND is the HKDF salt, so a name
    // and its salt must travel together. Getting this wrong fails only in
    // production, where every request is https.
    const cookie = await sessionCookie(
      { email: "eric@headpinz.com", name: "Eric Osborn", roles: ["access"] },
      AUTH_SECRET,
      SECURE_SESSION_COOKIE,
    );
    const r = await gate(`/admin/${STAFFED}`, { nav: true, https: true, headers: { cookie } });
    expect(r).toMatchObject({ status: 200, via: "sso", email: "eric@headpinz.com" });
  });

  it("STRIPS an inbound x-sso-* — those headers are ours or absent, never the caller's", async () => {
    // Without the strip, a signed-in temp could sign the audit trail as anyone
    // by sending one header.
    const r = await gate(`/admin/${STAFFED}`, {
      nav: true,
      headers: {
        cookie: await staff(),
        "x-sso-email": "owner@headpinz.com",
        "x-sso-name": "Someone Else",
      },
    });
    expect(r.email).toBe("eric@headpinz.com");
    expect(r.name).toBe("Eric Osborn");
  });

  it("refuses a session signed with a retired AUTH_SECRET", async () => {
    const stale = await sessionCookie(
      { email: "e@h.com", roles: ["access"] },
      "an-older-auth-secret",
    );
    const r = await gate(`/admin/${STAFFED}`, { nav: true, headers: { cookie: stale } });
    expect(r.status).toBe(307);
    expect(new URL(r.location!).pathname).toBe("/sso/signin");
  });

  it("refuses a tampered cookie and fails closed with AUTH_SECRET unset", async () => {
    const good = await staff();
    const tampered = `${good.slice(0, -3)}aaa`;
    expect(
      await gate(`/admin/${STAFFED}`, { nav: true, headers: { cookie: tampered } }),
    ).toMatchObject({ status: 307 });

    env({ AUTH_SECRET: undefined });
    expect(await gate(`/admin/${STAFFED}`, { nav: true, headers: { cookie: good } })).toMatchObject(
      {
        status: 307,
      },
    );
  });

  it("gates EVERY migrated tool — no v2 board is left ungated", async () => {
    for (const slug of SSO_ADMIN_TOOLS) {
      expect(await gate(`/admin/${slug}`, { nav: true }), slug).toMatchObject({ status: 307 });
    }
  });
});

/**
 * THE FULL MATRIX, RUN AGAIN FOR THE TWO SLUGS THAT JUST JOINED.
 *
 * The assertions above prove the BRANCH on `reservations`; these prove the
 * REGISTRY — that `e-tickets` and `videos` actually reach that branch. The two
 * are separable failures: an edit that adds a slug to `SSO_ADMIN_TOOLS` but
 * leaves `isSsoToolPath` looking at the wrong list would keep every assertion
 * above green while the two new boards answered 404 to a signed-in human, or
 * (worse, if the lists were crossed the other way) served with no gate at all.
 *
 * Same real Auth.js cookies as everything else in this file — `encode()` from
 * `@auth/core/jwt`, salted with the cookie name, decoded by the middleware's
 * own `decode`. A mock would prove the branching and hide the one thing that
 * can silently break.
 */
describe("SSO gate — the two tools that moved onto sign-in (owner decision 2026-08-28)", () => {
  const MOVED = ["e-tickets", "videos"] as const;

  it("is on the SSO list, so this file is testing what it claims to test", () => {
    // Guards the matrix below against quietly becoming vacuous if the registry
    // changes: these cases only mean anything while these slugs are SSO tools.
    for (const slug of MOVED) {
      expect(SSO_ADMIN_TOOLS.has(slug), slug).toBe(true);
      expect(TOKEN_ONLY_TOOLS.has(slug), slug).toBe(false);
    }
  });

  it("sends an unauthenticated NAVIGATION to /sso/signin, carrying the path asked for", async () => {
    for (const slug of MOVED) {
      const r = await gate(`/admin/${slug}?q=abc`, { nav: true });
      expect(r.status, slug).toBe(307);
      const loc = new URL(r.location!);
      expect(loc.pathname, slug).toBe("/sso/signin");
      expect(loc.searchParams.get("callbackUrl"), slug).toBe(`/admin/${slug}?q=abc`);
    }
  });

  it("404s an unauthenticated XHR — a board's fetch must not be sent to Microsoft", async () => {
    // Both of these boards poll. A 307 followed by an XHR parses a sign-in page
    // as JSON and surfaces "Unexpected token <" instead of "your session ended".
    for (const slug of MOVED) {
      expect(
        await gate(`/admin/${slug}`, { headers: { accept: "application/json" } }),
        slug,
      ).toMatchObject({ status: 404, contentType: "text/plain" });
    }
  });

  it("sends a signed-in user WITHOUT the role to /sso/error, never back to Microsoft", async () => {
    for (const slug of MOVED) {
      const r = await gate(`/admin/${slug}`, { nav: true, headers: { cookie: await noRole() } });
      expect(r.status, slug).toBe(307);
      const loc = new URL(r.location!);
      expect(loc.pathname, slug).toBe("/sso/error");
      expect(loc.searchParams.get("code"), slug).toBe("SSO_E_NO_ROLE");
    }
  });

  it("lets a valid session through, stamped with who it is", async () => {
    const cookie = await staff();
    for (const slug of MOVED) {
      expect(await gate(`/admin/${slug}`, { nav: true, headers: { cookie } }), slug).toMatchObject({
        status: 200,
        adminRoute: "1",
        via: "sso",
        email: "eric@headpinz.com",
      });
    }
  });

  it("keeps their TOKEN url working, with no session, exactly as before", async () => {
    // The non-negotiable half of the move: nothing was deleted from the v1
    // tree, so every bookmark, cron and Teams card still resolves.
    for (const slug of MOVED) {
      expect(await gate(`/admin/${TOKEN}/${slug}`, { nav: true }), slug).toMatchObject({
        status: 200,
        adminRoute: "1",
        via: null,
      });
    }
  });

  it("leaves /admin/embed/videos on the HMAC branch, not the new SSO route", async () => {
    // `videos` joining SSO_ADMIN_TOOLS puts the string "videos" one segment
    // away from the portal's iframe surface. If `isSsoToolPath` ever read
    // segment 3 instead of segment 2, every embedded video log would start
    // 307ing an iframe at a Microsoft sign-in page.
    env({ ADMIN_EMBED_SECRET: "embed-secret" });
    expect(await gate("/admin/embed/videos", { nav: true })).toMatchObject({ status: 403 });
    expect(await gate("/admin/embed/e-tickets", { nav: true })).toMatchObject({ status: 403 });
  });
});

describe("camera-assign went BACK to the token (owner decision 2026-08-28)", () => {
  it("serves both of its token URLs with no session", async () => {
    // Trackside kiosks, one per track. This is the whole reason it came off
    // SSO, so it is the assertion that has to hold.
    for (const p of [`/admin/${TOKEN}/camera-assign`, `/admin/${TOKEN}/camera-assign/blue`]) {
      expect(await gate(p, { nav: true }), p).toMatchObject({
        status: 200,
        adminRoute: "1",
        via: null,
      });
    }
  });

  it("404s the token-less paths — no sign-in redirect, and no v2 page to render", async () => {
    // A 307 here would be the regression: a kiosk between heats sent to
    // Microsoft, with nothing at /admin/camera-assign to come back to. It must
    // fall through to the static-token check and 404, exactly as an unknown
    // admin path does.
    const cookie = await staff();
    for (const p of ["/admin/camera-assign", "/admin/camera-assign/blue"]) {
      expect(await gate(p, { nav: true }), p).toMatchObject({
        status: 404,
        contentType: "text/plain",
      });
      // …and a valid Microsoft session does not open it either. There is no
      // route there to open.
      expect(await gate(p, { nav: true, headers: { cookie } }), p).toMatchObject({ status: 404 });
    }
  });

  it("still resolves on the admin host, via the legacy tokened rewrite", async () => {
    // `admin.fasttraxent.com/camera-assign` is in staff hands and must keep
    // working — behind the same SSO gate, rewritten to the tokened board.
    const cookie = await staff();
    const r = await gate("/camera-assign/blue", {
      host: "admin.fasttraxent.com",
      nav: true,
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    expect(new URL(r.rewrite!).pathname).toBe(`/admin/${TOKEN}/camera-assign/blue`);
    expect(r.via).toBe("sso");
  });
});

describe("the unattended displays are NOT behind sign-in (owner decision 2026-08-28)", () => {
  it("keeps /admin/{token}/pit and /admin/{token}/briefing open to a device with no session", async () => {
    // These are wall screens. If the gate ever starts asking them for a
    // Microsoft session, the board is blank every morning until someone walks
    // over with a keyboard. This assertion is the guard on that decision.
    for (const slug of DEVICE_TOKEN_TOOLS) {
      expect(await gate(`/admin/${TOKEN}/${slug}`, { nav: true }), slug).toMatchObject({
        status: 200,
        adminRoute: "1",
        via: null,
      });
    }
  });

  it("does NOT invent an SSO route for them — /admin/pit stays a 404, not a sign-in", async () => {
    // A device tool has no v2 page, so the SSO branch must not claim the path:
    // a 307 here would send a wall display to Microsoft and it would never come
    // back. It falls through to the static-token check and 404s, exactly as it
    // did before this PR.
    for (const slug of DEVICE_TOKEN_TOOLS) {
      expect(await gate(`/admin/${slug}`, { nav: true }), slug).toMatchObject({
        status: 404,
        contentType: "text/plain",
      });
    }
  });
});

describe("the tools that have not migrated keep exactly today's behaviour", () => {
  it("serves their token URL, with no session, unchanged", async () => {
    for (const slug of TOKEN_ONLY_TOOLS) {
      expect(await gate(`/admin/${TOKEN}/${slug}`, { nav: true }), slug).toMatchObject({
        status: 200,
        adminRoute: "1",
        via: null,
      });
    }
  });

  it("404s their token-less path even for a valid session — there is no v2 page to render", async () => {
    const cookie = await staff();
    for (const slug of TOKEN_ONLY_TOOLS) {
      expect(await gate(`/admin/${slug}`, { nav: true, headers: { cookie } }), slug).toMatchObject({
        status: 404,
      });
    }
  });
});

/**
 * THE FULL MATRIX FOR THE FOURTEEN THAT JOINED ON 2026-08-30 ("move the rest").
 *
 * Same reasoning as the `e-tickets` / `videos` block above: the assertions on
 * `reservations` prove the BRANCH; these prove the REGISTRY actually reaches it
 * for every slug that moved. Driven off `SSO_ADMIN_TOOLS` so a nineteenth tool
 * is covered the day it is added — a hand-listed copy would go stale in the
 * "the gate does not fire" direction, which is the direction that does not
 * announce itself.
 */
describe("SSO gate — every migrated tool, end to end", () => {
  it("307s an unauthenticated NAVIGATION to /sso/signin, carrying the path asked for", async () => {
    for (const slug of SSO_ADMIN_TOOLS) {
      const r = await gate(`/admin/${slug}?q=abc`, { nav: true });
      expect(r.status, slug).toBe(307);
      const loc = new URL(r.location!);
      expect(loc.pathname, slug).toBe("/sso/signin");
      expect(loc.searchParams.get("callbackUrl"), slug).toBe(`/admin/${slug}?q=abc`);
    }
  });

  it("404s an unauthenticated XHR — a board's fetch must not be sent to Microsoft", async () => {
    for (const slug of SSO_ADMIN_TOOLS) {
      expect(
        await gate(`/admin/${slug}`, { headers: { accept: "application/json" } }),
        slug,
      ).toMatchObject({ status: 404, contentType: "text/plain" });
    }
  });

  it("sends a signed-in user WITHOUT the role to /sso/error, never back to Microsoft", async () => {
    const cookie = await noRole();
    for (const slug of SSO_ADMIN_TOOLS) {
      const r = await gate(`/admin/${slug}`, { nav: true, headers: { cookie } });
      expect(r.status, slug).toBe(307);
      const loc = new URL(r.location!);
      expect(loc.pathname, slug).toBe("/sso/error");
      expect(loc.searchParams.get("code"), slug).toBe("SSO_E_NO_ROLE");
    }
  });

  it("lets a valid session through, stamped with who it is", async () => {
    const cookie = await staff();
    for (const slug of SSO_ADMIN_TOOLS) {
      expect(await gate(`/admin/${slug}`, { nav: true, headers: { cookie } }), slug).toMatchObject({
        status: 200,
        adminRoute: "1",
        via: "sso",
        email: "eric@headpinz.com",
      });
    }
  });
});

describe("SSO gate — it does not touch any other credential", () => {
  it("leaves /admin/{token}/* to the static-token branch", async () => {
    // A token-only tool still renders from its tokened path with no session and
    // no `x-admin-via` — the static branch answered, exactly as it always did.
    expect(await gate(`/admin/${TOKEN}/camera-assign`)).toMatchObject({ status: 200, via: null });
    // …and an unknown token still 404s rather than being offered a sign-in.
    expect(await gate(`/admin/wrong/${STAFFED}`, { nav: true })).toMatchObject({ status: 404 });
  });

  it("leaves /admin/embed/* to the HMAC branch (403, not a sign-in redirect)", async () => {
    env({ ADMIN_EMBED_SECRET: "embed-secret" });
    // The portal has no Microsoft session; bouncing an iframe to a sign-in page
    // would break every embed.
    expect(await gate("/admin/embed/videos", { nav: true })).toMatchObject({ status: 403 });
  });

  it("leaves /api/admin/* alone — a browser XHR keeps using its minted token", async () => {
    expect(
      await gate("/api/admin/videos/list", { headers: { cookie: await staff() } }),
    ).toMatchObject({ status: 404 });
    expect(
      await gate("/api/admin/videos/list", { headers: { "x-admin-token": TOKEN } }),
    ).toMatchObject({ status: 200 });
  });

  it("lets the proxy key win, so the shell keeps working with no session at all", async () => {
    expect(
      await gate(`/admin/${STAFFED}`, { nav: true, headers: { "x-admin-proxy-key": PROXY_KEY } }),
    ).toMatchObject({ status: 200, via: "proxy-key" });
  });

  it("keeps a tool slug that EQUALS the static token on the v1 meaning", async () => {
    // Absurd in practice, deliberate in code: when segment 2 IS the configured
    // token it is a CREDENTIAL, and `isSsoToolPath` steps aside so the static
    // branch answers — 200 with no `x-admin-via`, exactly as a v1 path does.
    // Reinterpreting it as a tool name would have turned a working token URL
    // into a sign-in redirect for everyone holding it.
    env({ ADMIN_CAMERA_TOKEN: STAFFED });
    expect(await gate(`/admin/${STAFFED}`, { nav: true })).toMatchObject({
      status: 200,
      adminRoute: "1",
      via: null,
    });
  });

  it("leaves guest routing untouched", async () => {
    const r = await middleware(req("/racing"));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-middleware-request-x-admin-route")).toBeNull();
  });
});

describe("SSO plumbing paths are reachable without a session", () => {
  it("passes /sso/* and /api/auth/* through on both brand hosts", async () => {
    for (const host of ["fasttraxent.com", "headpinz.com"]) {
      for (const p of ["/sso/signin", "/sso/error", "/api/auth/callback/headpinz"]) {
        const res = await middleware(req(p, { host }));
        expect(res.status, `${host}${p}`).toBe(200);
        // Never /hp-rewritten: /hp/sso/error does not exist, and the one page
        // that explains a failed sign-in must not 404 on the HeadPinz host.
        expect(res.headers.get("x-middleware-rewrite"), `${host}${p}`).toBeNull();
      }
    }
  });
});

describe("admin host alias — admin.fasttraxent.com serves the tools and nothing else", () => {
  const HOST = "admin.fasttraxent.com";

  it("rewrites a MIGRATED tool onto the v2 route for a valid session", async () => {
    const r = await gate(`/${STAFFED}`, {
      host: HOST,
      nav: true,
      headers: { cookie: await staff() },
    });
    expect(r.status).toBe(200);
    expect(new URL(r.rewrite!).pathname).toBe(`/admin/${STAFFED}`);
    expect(r.via).toBe("sso");
    expect(r.email).toBe("eric@headpinz.com");
    // The whole point of the v2 route: no credential anywhere in the path Next
    // resolves, so nothing to serialise into the RSC payload (audit item #8).
    expect(r.rewrite).not.toContain(TOKEN);
  });

  it("keeps deeper segments and the query string", async () => {
    const cookie = await staff();
    // Deeper segments ride along on BOTH rewrites, and both forms are live:
    // `/daily-events/{projectId}` is a real portal deep link on an SSO tool, and
    // `/camera-assign/{track}` is a real trackside URL on the one tool that
    // kept its token.
    const deep = await gate("/daily-events/12345", { host: HOST, nav: true, headers: { cookie } });
    expect(new URL(deep.rewrite!).pathname).toBe("/admin/daily-events/12345");

    const legacyDeep = await gate("/camera-assign/blue", {
      host: HOST,
      nav: true,
      headers: { cookie },
    });
    expect(new URL(legacyDeep.rewrite!).pathname).toBe(`/admin/${TOKEN}/camera-assign/blue`);

    const q = await gate("/checkin?board=1&loc=ft", { host: HOST, nav: true, headers: { cookie } });
    const rewritten = new URL(q.rewrite!);
    expect(rewritten.pathname).toBe("/admin/checkin");
    expect(rewritten.searchParams.get("board")).toBe("1");
    expect(rewritten.searchParams.get("loc")).toBe("ft");
  });

  it("keeps an UN-MIGRATED tool working, via the tokened route, behind the same gate", async () => {
    // `admin.fasttraxent.com/camera-assign` is in staff hands and is what
    // `adminToolUrl()` produces for it. A tool that keeps its token still
    // resolves at its clean staff URL — same gate, legacy rewrite — because the
    // list decides the GATE only when there is a v2 page to rewrite onto.
    const anon = await gate("/camera-assign", { host: HOST, nav: true });
    expect(anon.status).toBe(307);
    expect(new URL(anon.location!).pathname).toBe("/sso/signin");

    const r = await gate("/camera-assign", {
      host: HOST,
      nav: true,
      headers: { cookie: await staff() },
    });
    expect(r.status).toBe(200);
    expect(new URL(r.rewrite!).pathname).toBe(`/admin/${TOKEN}/camera-assign`);
    expect(r.via).toBe("sso");
  });

  it("resolves EVERY registered slug on this host — nothing 404s that works today", async () => {
    const cookie = await staff();
    for (const slug of ADMIN_TOOL_SLUGS) {
      const r = await gate(`/${slug}`, { host: HOST, nav: true, headers: { cookie } });
      expect(r.status, slug).toBe(200);
      expect(new URL(r.rewrite!).pathname, slug).toBe(
        SSO_ADMIN_TOOLS.has(slug) ? `/admin/${slug}` : `/admin/${TOKEN}/${slug}`,
      );
    }
  });

  it("fails the legacy rewrite CLOSED when ADMIN_CAMERA_TOKEN is unset", async () => {
    // Rather than rewriting to `/admin//camera-assign` and letting Next decide.
    env({ ADMIN_CAMERA_TOKEN: undefined });
    expect(
      await gate("/camera-assign", { host: HOST, nav: true, headers: { cookie: await staff() } }),
    ).toMatchObject({ status: 404, contentType: "text/plain" });
  });

  it("sends an unauthenticated visitor to /sso/signin with the CLEAN path as callback", async () => {
    // Not "/admin/reservations" — they must land back where they started, on a
    // URL they have actually seen.
    const r = await gate(`/${STAFFED}`, { host: HOST, nav: true });
    expect(r.status).toBe(307);
    const loc = new URL(r.location!);
    expect(loc.pathname).toBe("/sso/signin");
    expect(loc.searchParams.get("callbackUrl")).toBe(`/${STAFFED}`);
  });

  it("404s an unauthenticated XHR here too, rather than redirecting it", async () => {
    expect(
      await gate(`/${STAFFED}`, { host: HOST, headers: { accept: "application/json" } }),
    ).toMatchObject({ status: 404, contentType: "text/plain" });
  });

  it("404s every guest route — the booking funnel must never render here", async () => {
    for (const p of ["/", "/book", "/book/race/v2", "/racing", "/kiosk", "/tv", "/fort-myers"]) {
      expect(await gate(p, { host: HOST, nav: true }), p).toMatchObject({
        status: 404,
        contentType: "text/plain",
      });
    }
  });

  it("resolves a slug that is ALSO a guest path to the admin board", async () => {
    // `/deals` is both a guest product page and a staff board. On the STAFF
    // host the staff board wins — the guest page keeps its canonical home on
    // headpinz.com, which is where every ad and email points anyway (and where
    // `publicOrigin()` sends anything built in a browser on this host). Since
    // "move the rest" the board is an SSO tool, so the rewrite is the clean
    // one — no credential anywhere in the path Next resolves.
    const r = await gate("/deals", { host: HOST, nav: true, headers: { cookie: await staff() } });
    expect(new URL(r.rewrite!).pathname).toBe("/admin/deals");
    expect(r.rewrite).not.toContain(TOKEN);
  });

  it("passes assets, /api/*, /sso/* and /api/auth/* through", async () => {
    for (const p of [
      "/_next/static/chunk.js",
      "/favicon.ico",
      "/api/bowling/status",
      "/sso/signin",
      "/api/auth/callback/headpinz",
    ]) {
      const r = await gate(p, { host: HOST });
      expect(r.status, p).toBe(200);
      expect(r.rewrite, p).toBeNull();
    }
  });

  it("passes the two owner-approved staff previews boards link to relatively", async () => {
    for (const p of ["/contract/abc123", "/v/HPW4K7M9PQR"]) {
      expect(await gate(p, { host: HOST, nav: true }), p).toMatchObject({ status: 200 });
    }
  });

  it("still runs the unified gate on /admin/* and /api/admin/* reached directly", async () => {
    expect(await gate(`/admin/${TOKEN}/${DISPLAY}`, { host: HOST })).toMatchObject({ status: 200 });
    expect(
      await gate("/api/admin/videos/list", { host: HOST, headers: { "x-admin-token": TOKEN } }),
    ).toMatchObject({ status: 200 });
    expect(await gate(`/admin/${STAFFED}`, { host: HOST, nav: true })).toMatchObject({
      status: 307,
    });
  });

  it("is off for every other host, and configurable by ADMIN_HOSTS", async () => {
    // A brand host serves /reservations as an ordinary app path, not an admin
    // route.
    expect((await gate(`/${STAFFED}`, { host: "fasttraxent.com", nav: true })).status).toBe(200);

    env({ ADMIN_HOSTS: "tools-website-ft-git-feat-admin-sso-headpinz.vercel.app" });
    const preview = await gate(`/${STAFFED}`, {
      host: "tools-website-ft-git-feat-admin-sso-headpinz.vercel.app",
      nav: true,
    });
    expect(preview.status).toBe(307);
    expect(new URL(preview.location!).pathname).toBe("/sso/signin");
  });

  it("does not disturb brand detection — the admin host is not HeadPinz", async () => {
    // `hostname.includes("headpinz.com")` is computed before this block and is
    // untouched by it; admin.fasttraxent.com was never a HeadPinz host, and its
    // guest paths 404 rather than being /hp-rewritten.
    const r = await gate("/fort-myers", { host: HOST, nav: true });
    expect(r).toMatchObject({ status: 404 });
    expect(r.rewrite).toBeNull();
  });

  it("still routes the HeadPinz brand host to /hp — the alias changed nothing there", async () => {
    const r = await middleware(req("/fort-myers", { host: "headpinz.com", nav: true }));
    expect(r.headers.get("x-middleware-rewrite")).toContain("/hp/fort-myers");
  });
});
