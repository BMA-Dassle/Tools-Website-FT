import { createHmac } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { E2E } from "../playwright.config";
import {
  DEVICE_TOKEN_TOOLS,
  SSO_ADMIN_TOOLS,
  TOKEN_ONLY_TOOLS,
} from "../src/lib/constants/admin-tools";

/**
 * ADMIN SSO, END TO END: a browser, this app, the real HeadPinz gateway, and a
 * mock Entra. Nothing here is stubbed on our side of the wire.
 *
 * The unit suites prove which branch of the gate fires. This suite exists for
 * the three things they structurally cannot reach:
 *
 *   1. Does a person with a Microsoft account actually END UP ON THE BOARD? The
 *      redirect chain crosses three servers, two cookie jars and an OIDC code
 *      exchange; every one of those is a place a `trustHost`, a callback path or
 *      a cookie prefix can be wrong in a way that no unit test would notice.
 *
 *   2. Is the static ADMIN_CAMERA_TOKEN still in the bytes the browser gets?
 *      tasks/admin-sso-lockdown.md audit item #8 found it TWICE in the HTML of
 *      every board served through the proxy shell — put there by Next
 *      serialising the resolved `[token]` route segment, with no application
 *      code involved. That is the leak this whole pivot is for, and the only
 *      instrument that can measure it is a page load and a substring count.
 *
 *   3. Do the surfaces that DELIBERATELY kept the token still open with no
 *      session at all, in a real browser with an empty cookie jar? A trackside
 *      kiosk and two wall displays are the failure mode nobody sees in CI —
 *      they fail at 9am on a Saturday, in front of guests.
 *
 * ── THE LISTS ARE NOT WRITTEN DOWN HERE ──────────────────────────────────────
 * Every membership question below is asked of `~/lib/constants/admin-tools`,
 * the one registry the middleware and the host router read. A hard-coded list
 * in a test file is a list that rots: this suite's ancestor asserted
 * `/admin/camera-assign` was an SSO board, which stopped being true the day the
 * owner sent it back trackside. Driving off the registry means a tool added to
 * SSO tomorrow is swept for the token automatically, and a tool MOVED between
 * lists changes which assertions apply to it rather than quietly passing the
 * wrong ones.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Run with `E2E_ADMIN_SSO=1`; see playwright.config.ts for the setup.
 */

const enabled = process.env.E2E_ADMIN_SSO === "1";
test.skip(!enabled, "set E2E_ADMIN_SSO=1 to run the SSO end-to-end suite");

const TOKEN = E2E.adminCameraToken;

/**
 * The three surfaces that keep `/admin/{ADMIN_CAMERA_TOKEN}/<slug>` forever:
 * the two unattended wall displays and the trackside kiosk tool. The registry
 * keeps them in two sets because the REASONS differ (a display nobody signs
 * into vs. a shared kiosk worked standing up between heats), and the
 * consequences differ too — rotating the token is blocked on a device plan for
 * the first pair and not for the second. Every assertion in this file about
 * "does not redirect / renders with no session / has no clean URL" applies to
 * the union, so the union is what it iterates.
 */
const TOKEN_KEPT_TOOLS = [...DEVICE_TOKEN_TOOLS, ...TOKEN_ONLY_TOOLS].sort();

/**
 * The boards that get the FULL treatment — sign in, render, mint, and watch
 * their own `/api/admin/*` XHRs — rather than just a token count.
 *
 * WHY A SAMPLE AT ALL. The token count is cheap (one navigation on an
 * already-signed-in context) and runs against EVERY slug in `SSO_ADMIN_TOOLS`,
 * so nothing escapes the measurement this suite exists for. The deep checks
 * cost a board's worth of Neon/BMI round trips each, and eighteen of those buy
 * repetition rather than coverage: they all run the same `requireSsoAdmin()`
 * through the same middleware branch.
 *
 * WHY THESE FIVE. `reservations` is the audit's original subject and the
 * busiest `/api/admin/*` caller. `checkin` and `sales` are the two highest-
 * traffic desk boards. `videos` and `e-tickets` are the pair that moved to SSO
 * *because* their URL was a forwardable bearer credential for a screen of guest
 * emails and phone numbers — the tools with the most to lose if the gate is
 * wrong.
 */
const DEEP_SAMPLE = ["reservations", "checkin", "sales", "videos", "e-tickets"] as const;

/**
 * `/admin/daily-events` is registered as an SSO tool but is a REDIRECT, not a
 * board: both of its routes forward to `daily-events-v2`, and they do it
 * through `adminToolUrl()`, which returns an ABSOLUTE url on the staff origin
 * (`https://admin.fasttraxent.com/…` unless `ADMIN_PUBLIC_URL` says otherwise).
 *
 * So the sweep must not `goto` it: a browser would follow the 307 straight off
 * the harness and onto the real production admin host, where it would meet a
 * real Microsoft sign-in and the measurement would be of somebody else's
 * deployment. It is fetched WITHOUT following instead, and what gets counted is
 * the redirect's own bytes — the Location header included, since that is the
 * place a redirect shim would leak a credential if it built its target the way
 * the v1 route used to.
 */
const SSO_REDIRECT_TOOLS = new Set(["daily-events"]);

test.beforeAll(() => {
  // A blank token would make every "appears zero times" assertion below pass
  // vacuously — the single worst way for this suite to be green.
  expect(TOKEN.length, "ADMIN_CAMERA_TOKEN must be present in .env.local").toBeGreaterThan(16);

  // The deep sample names slugs by hand, so it is the one place that CAN drift
  // from the registry. Fail here, loudly, rather than silently deep-testing
  // four boards because one was renamed or moved back to the token.
  for (const slug of DEEP_SAMPLE) {
    expect(
      SSO_ADMIN_TOOLS.has(slug),
      `DEEP_SAMPLE names "${slug}", which is no longer an SSO tool — update the sample`,
    ).toBe(true);
  }

  // And the three token-kept surfaces are the ones the assertions below are
  // written for. A fourth arriving is a decision, not a detail: it should turn
  // this red until somebody looks at it.
  expect(TOKEN_KEPT_TOOLS, "the token-kept surfaces changed — re-read this suite").toEqual([
    "briefing",
    "camera-assign",
    "pit",
  ]);
});

/**
 * Sign in to the mock Microsoft as a named fixture.
 *
 * The mock resolves a user as `login_hint ?? its own session cookie ?? eric`.
 * Auth.js does not forward `login_hint`, so the session cookie is how a test
 * chooses somebody other than the default — set before the flow starts, it
 * decides who comes back.
 */
async function beMicrosoftUser(context: BrowserContext, fixture: string) {
  await context.addCookies([
    { name: "mock_entra_session", value: fixture, domain: "localhost", path: "/" },
  ]);
}

/** Walk the sign-in chain and land wherever it ends. */
async function signInAndOpen(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
}

/** Everything the browser received for one document: HTML plus the RSC flight
 *  payload the router streams in. Both are searched for the token. */
async function documentBytes(page: Page): Promise<string> {
  const html = await page.content();
  const rsc = await page.evaluate(() => {
    // Next parks the flight payload on self.__next_f as an array of chunks.
    const f = (self as unknown as { __next_f?: unknown[][] }).__next_f;
    if (!Array.isArray(f)) return "";
    return f.map((c) => (Array.isArray(c) ? c.map(String).join("") : String(c))).join("");
  });
  return `${html}\n${rsc}`;
}

function countOf(haystack: string, needle: string): number {
  if (!needle) return -1;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** The `<expMs>.<hex>` shape `mintAdminApiToken()` produces. */
const MINTED = /\b\d{13}\.[0-9a-f]{32,}\b/;

/**
 * EVERY SSO board, counted. One sign-in for the whole sweep — the session
 * cookie is what the gate reads, so a shared context is the same request the
 * per-test version would make, minus seventeen OIDC round trips.
 *
 * `.serial` because the shared context is torn down in `afterAll`; a failure
 * mid-sweep should not leave the rest running against a closed browser.
 */
test.describe.serial("the token is not in a signed-in board's bytes", () => {
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext();
    await beMicrosoftUser(ctx, "eric");
    // Walk the full chain ONCE so the rest of the sweep is a plain navigation.
    const page = await ctx.newPage();
    await signInAndOpen(page, "/admin/reservations");
    expect(new URL(page.url()).pathname, "the shared sign-in did not land on a board").toBe(
      "/admin/reservations",
    );
    await page.close();
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  for (const slug of [...SSO_ADMIN_TOOLS].sort()) {
    if (SSO_REDIRECT_TOOLS.has(slug)) {
      test(`/admin/${slug} — forwards to its v2 board, token x0`, async () => {
        const res = await ctx.request.get(`${E2E.webOrigin}/admin/${slug}`, {
          headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
          maxRedirects: 0,
        });
        expect(res.status(), `/admin/${slug} should be a redirect shim`).toBeGreaterThanOrEqual(
          300,
        );
        expect(res.status()).toBeLessThan(400);
        const location = res.headers()["location"] ?? "";
        expect(new URL(location, E2E.webOrigin).pathname).toBe("/daily-events-v2");

        const bytes = `${location}\n${await res.text()}`;
        const leaked = countOf(bytes, TOKEN);
        console.log(`[token-count] /admin/${slug} (redirect shim): ADMIN_CAMERA_TOKEN x${leaked}`);
        expect(leaked, `ADMIN_CAMERA_TOKEN appears ${leaked}× on /admin/${slug}`).toBe(0);
      });
      continue;
    }

    test(`/admin/${slug} — renders for a signed-in staff member, token x0`, async () => {
      const page = await ctx.newPage();
      try {
        const res = await page.goto(`/admin/${slug}`, { waitUntil: "domcontentloaded" });
        expect(res, `no response for /admin/${slug}`).not.toBeNull();
        await page.waitForLoadState("networkidle");

        // The session carried; nobody was bounced back to a sign-in.
        expect(new URL(page.url()).pathname).toBe(`/admin/${slug}`);
        await expect(page.locator("body")).not.toContainText("Sign-in didn't work");

        // THE POINT OF THE PIVOT: zero occurrences of the static token.
        const bytes = await documentBytes(page);
        const leaked = countOf(bytes, TOKEN);
        console.log(`[token-count] /admin/${slug}: ADMIN_CAMERA_TOKEN x${leaked}`);
        expect(leaked, `ADMIN_CAMERA_TOKEN appears ${leaked}× on /admin/${slug}`).toBe(0);
      } finally {
        await page.close();
      }
    });
  }
});

test.describe("a staffed board opens with a Microsoft session and no token in the URL", () => {
  for (const slug of DEEP_SAMPLE) {
    test(`/admin/${slug} — signs in, renders, and mints its own credential`, async ({
      page,
      context,
    }) => {
      await beMicrosoftUser(context, "eric");

      // 1. Unauthenticated navigation is bounced to our sign-in entry point,
      //    carrying the board it asked for.
      const first = await page.goto(`/admin/${slug}`, { waitUntil: "domcontentloaded" });
      expect(first, `no response for /admin/${slug}`).not.toBeNull();

      // 2. …which hops through the gateway and Microsoft and comes back here.
      await page.waitForLoadState("networkidle");
      expect(new URL(page.url()).pathname).toBe(`/admin/${slug}`);

      // 3. A board, not the error page and not an empty shell.
      await expect(page.locator("body")).not.toContainText("Sign-in didn't work");
      const bytes = await documentBytes(page);
      expect(bytes.length).toBeGreaterThan(2000);

      // 4. No static token…
      expect(countOf(bytes, TOKEN)).toBe(0);

      // 5. …and a freshly minted credential in its place.
      expect(bytes).toMatch(MINTED);
    });
  }

  test("the board's own /api/admin/* calls succeed on a v2 page", async ({ page, context }) => {
    await beMicrosoftUser(context, "eric");

    const adminCalls: { url: string; status: number }[] = [];
    page.on("response", (res) => {
      const p = new URL(res.url()).pathname;
      if (p.startsWith("/api/admin/")) adminCalls.push({ url: p, status: res.status() });
    });

    await signInAndOpen(page, "/admin/reservations");
    await page.waitForTimeout(3000);

    expect(adminCalls.length, "the board made no /api/admin/* calls").toBeGreaterThan(0);
    const failed = adminCalls.filter(
      (c) => c.status === 401 || c.status === 403 || c.status === 404,
    );
    console.log(`[api-admin] ${adminCalls.length} calls, ${failed.length} rejected`);
    expect(failed, JSON.stringify(failed)).toHaveLength(0);
  });
});

test.describe("the sign-in gate itself", () => {
  test("an unauthenticated NAVIGATION is redirected, not 404ed", async ({ page }) => {
    // No Microsoft session at all: follow only the first hop by watching where
    // the browser is sent before the gateway takes over.
    const hops: string[] = [];
    page.on("request", (r) => {
      if (r.isNavigationRequest()) hops.push(new URL(r.url()).pathname);
    });
    await page.goto("/admin/reservations", { waitUntil: "domcontentloaded" });
    expect(hops[0]).toBe("/admin/reservations");
    expect(hops).toContain("/sso/signin");
  });

  test("an unauthenticated XHR gets an opaque 404, never a redirect", async ({ request }) => {
    const res = await request.get("/admin/reservations", {
      headers: { accept: "application/json" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  test("mkt — no fasttrax-admin.access — is stopped at the gateway", async ({ page, context }) => {
    await beMicrosoftUser(context, "mkt");
    await signInAndOpen(page, "/admin/reservations");

    // The gateway refuses before ever issuing a code for this client, so the
    // journey ends on ITS /no-access page — this app never sees a session.
    const url = new URL(page.url());
    expect(url.origin).toBe(E2E.gatewayOrigin);
    expect(url.pathname).toBe("/no-access");
    await expect(page.getByTestId("no-access-title")).toBeVisible();

    // And the proof of "never sees a session": this app still refuses an XHR
    // from the same cookie jar, so no session cookie was ever written here.
    const res = await page.request.get(`${E2E.webOrigin}/admin/reservations`, {
      headers: { accept: "application/json" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
  });

  test("/sso/error explains a failure with its stable code", async ({ page }) => {
    await page.goto("/sso/error?code=SSO_E_NO_ROLE&requestId=req_abc123");
    await expect(page.locator("body")).toContainText("SSO_E_NO_ROLE");
    await expect(page.locator("body")).toContainText("req_abc123");
  });

  test("/sso/diag is 401 without the bearer and healthy with it", async ({ request }) => {
    expect((await request.get("/sso/diag")).status()).toBe(401);
    expect(
      (await request.get("/sso/diag", { headers: { authorization: "Bearer wrong" } })).status(),
    ).toBe(401);

    const ok = await request.get("/sso/diag", {
      headers: { authorization: `Bearer ${E2E.diagSecret}` },
    });
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body.discovery.ok, JSON.stringify(body.discovery)).toBe(true);
    expect(body.jwks.ok, JSON.stringify(body.jwks)).toBe(true);
    expect(body.clientId).toBe("fasttrax-admin");
    // Presence only — a diag endpoint that prints a secret is a secret leak.
    expect(JSON.stringify(body)).not.toContain(E2E.diagSecret);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});

/**
 * THE SURFACES THAT KEPT THE TOKEN, in a real browser with an empty cookie jar.
 *
 * `pit` and `briefing` are screens switched on and left running; `camera-assign`
 * is worked trackside on shared kiosks between heats. All three are the owner
 * decisions the registry records, and all three are the ones a well-meaning
 * "finish the migration" change would break first — silently, because nothing
 * in the unit suites loads them without a session.
 */
test.describe("the token-kept surfaces render with NO session at all", () => {
  for (const slug of TOKEN_KEPT_TOOLS) {
    test(`/admin/{token}/${slug} — 200, no bounce to a sign-in`, async ({ page }) => {
      const res = await page.goto(`/admin/${TOKEN}/${slug}`, { waitUntil: "domcontentloaded" });
      expect(res?.status(), slug).toBe(200);
      // Still on the tokened URL — the redirect lane must not have touched it.
      expect(new URL(page.url()).pathname, slug).toBe(`/admin/${TOKEN}/${slug}`);
      await expect(page.locator("body"), slug).not.toContainText("Sign-in didn't work");
    });
  }

  test("/admin/{token}/camera-assign/blue — the nested [track] route too", async ({ page }) => {
    const res = await page.goto(`/admin/${TOKEN}/camera-assign/blue`, {
      waitUntil: "domcontentloaded",
    });
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(`/admin/${TOKEN}/camera-assign/blue`);
  });

  test("none of them has a clean URL — /admin/<slug> 404s", async ({ request }) => {
    // The counterpart of the sweep above: a token-kept tool has no v2 page, so
    // the clean URL must be a 404 rather than a sign-in prompt for a board that
    // does not exist. This is the assertion the previous version of this suite
    // got wrong — it demanded /admin/camera-assign RENDER.
    for (const slug of TOKEN_KEPT_TOOLS) {
      const res = await request.get(`/admin/${slug}`, {
        headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
        maxRedirects: 0,
      });
      expect(res.status(), `/admin/${slug} should not exist`).toBe(404);
    }
    // …and the nested track route has no clean form either.
    expect(
      (
        await request.get("/admin/camera-assign/blue", {
          headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(404);
  });
});

/**
 * THE REDIRECT LANE (middleware.ts, after the legacy 308, before the render).
 *
 * Staff bookmarked the tokened URLs for years, so moving a tool to SSO did not
 * un-bookmark anything: the old URL kept serving the board with the credential
 * still in it. A valid tokened URL for an SSO tool now 307s to the clean one,
 * which turns the bookmark into a sign-in exactly once.
 *
 * Four things have to be true at the same time, and each is one assertion here.
 */
test.describe("the redirect lane", () => {
  test("a valid tokened URL for an SSO tool 307s to the clean URL", async ({ request }) => {
    const res = await request.get(`/admin/${TOKEN}/reservations`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    const loc = new URL(res.headers()["location"], E2E.webOrigin);
    expect(loc.pathname).toBe("/admin/reservations");
    // 307, NEVER 308: browsers heuristically cache a 308, and a cached
    // `{token} → clean` mapping outlives an ADMIN_CAMERA_TOKEN rotation.
    expect(res.status()).not.toBe(308);
  });

  test("the query string and deeper segments ride along", async ({ request }) => {
    // A real deep link: the event-detail shim under daily-events, which exists
    // in BOTH route trees precisely so a saved link behaves the same either way.
    const res = await request.get(
      `/admin/${TOKEN}/daily-events/12345?location=ft&date=2026-08-31`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(307);
    const loc = new URL(res.headers()["location"], E2E.webOrigin);
    expect(loc.pathname).toBe("/admin/daily-events/12345");
    expect(loc.searchParams.get("location")).toBe("ft");
    expect(loc.searchParams.get("date")).toBe("2026-08-31");
  });

  test("a token-kept tool is NOT redirected — it renders", async ({ request }) => {
    for (const slug of TOKEN_KEPT_TOOLS) {
      const res = await request.get(`/admin/${TOKEN}/${slug}`, { maxRedirects: 0 });
      expect(res.status(), `/admin/{token}/${slug} must render, not redirect`).toBe(200);
    }
    // The nested track route is on the same side of the line.
    expect(
      (await request.get(`/admin/${TOKEN}/camera-assign/blue`, { maxRedirects: 0 })).status(),
    ).toBe(200);
  });

  test("an INVALID token 404s rather than redirecting", async ({ request }) => {
    // A redirect here would tell an attacker which slugs exist. It must stay
    // the same opaque 404 the gate gives a typo.
    const bogus = "0".repeat(TOKEN.length);
    for (const slug of ["reservations", "camera-assign"]) {
      const res = await request.get(`/admin/${bogus}/${slug}`, { maxRedirects: 0 });
      expect(res.status(), slug).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
  });

  test("/api/admin/* and /admin/embed/* are outside the lane", async ({ request }) => {
    // An XHR that follows a 307 to an HTML sign-in page reports a JSON syntax
    // error instead of an auth failure, so `/api/admin/*` is never redirected —
    // it authenticates on its own terms and 200s with the static token.
    const api = await request.get(`/api/admin/sales/list?token=${TOKEN}`, { maxRedirects: 0 });
    expect(api.status()).not.toBe(307);

    // And the portal's HMAC iframe surface is never bounced to a sign-in
    // INSIDE an iframe: segment 2 is `embed`, never the token.
    const embed = await request.get("/admin/embed/bowling", { maxRedirects: 0 });
    expect(embed.status()).not.toBe(307);
  });
});

test.describe("nothing that works today stopped working", () => {
  /**
   * THE POSITIVE CONTROL, and it does double duty.
   *
   * A "the token appears zero times" assertion is only worth something if the
   * same instrument can find the token when it IS there. So: load a board
   * through a v1 `[token]` route and demand a NON-zero count. If this ever
   * reads zero, the counter is broken and every green assertion above is
   * meaningless — a typo in the needle, an empty env var and a page that failed
   * to render all read as "clean" otherwise.
   *
   * IT MOVED, AND WHY. The original control used `/admin/{token}/reservations`.
   * The redirect lane now 307s that URL to `/admin/reservations` before a byte
   * is rendered, so the control has to sit on a tokened URL that still RENDERS
   * — which is exactly the set of tools that kept the token. `camera-assign` is
   * the one of the three worked by a human at a keyboard, so it is the closest
   * like-for-like with the board the original measured.
   *
   * It is also the live measurement of audit item #8. The token is in these
   * bytes because Next serialises the resolved dynamic segment — no application
   * code puts it there, and nothing in the SSO work can remove it from a route
   * whose URL contains it. Which is exactly why the fix was to give staffed
   * tools a route with no token in the path, and why the item stays OPEN for
   * every token route until the device credential lands.
   */
  test("audit #8: the token IS still in a v1 page's bytes — the counter works", async ({
    page,
  }) => {
    await page.goto(`/admin/${TOKEN}/camera-assign`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    const bytes = await documentBytes(page);
    const leaked = countOf(bytes, TOKEN);
    console.log(
      `[token-count] /admin/{token}/camera-assign (v1 control): ADMIN_CAMERA_TOKEN x${leaked}`,
    );
    expect(
      leaked,
      "the v1 route should still leak the token; a 0 here means the counter is broken",
    ).toBeGreaterThan(0);
  });

  test("an /admin/embed HMAC URL still 200s, and a bad signature still 403s", async ({
    request,
  }) => {
    const ts = String(Date.now());
    const sig = createHmac("sha256", E2E.adminEmbedSecret).update(ts).digest("hex");
    expect((await request.get(`/admin/embed/bowling?ts=${ts}&sig=${sig}`)).status()).toBe(200);
    // The gate still REFUSES a wrong one — a 200 for everything would satisfy
    // the line above just as well.
    expect((await request.get(`/admin/embed/bowling?ts=${ts}&sig=deadbeef`)).status()).toBe(403);
  });

  test("an x-api-key call to /api/admin/sales/list still 200s, and a wrong key does not", async ({
    request,
  }) => {
    const ok = await request.get("/api/admin/sales/list", {
      headers: { "x-api-key": E2E.salesApiKey },
    });
    expect(ok.status()).toBe(200);
    expect(
      (await request.get("/api/admin/sales/list", { headers: { "x-api-key": "wrong" } })).status(),
    ).toBe(404);
  });
});

test.describe("the admin host alias", () => {
  /**
   * `admin.fasttraxent.com` is an admin host unconditionally, so overriding the
   * Host header is enough to exercise the alias against localhost.
   *
   * These go through the API request context rather than `page.goto`: Chromium
   * refuses a `Host` override on a NAVIGATION (`net::ERR_INVALID_ARGUMENT`),
   * which is the browser protecting itself, not a bug in the alias. What is
   * being asserted here is a middleware decision on one request, and the
   * request context makes exactly that request — with the browser's cookie jar
   * attached, so the session is real.
   */
  const asAdminHost = { Host: "admin.fasttraxent.com" };

  test("rewrites a clean tool URL onto the board for a signed-in staff member", async ({
    page,
    context,
  }) => {
    await beMicrosoftUser(context, "eric");
    // Sign in on the canonical host first; the session cookie is scoped to
    // `localhost`, so it rides along on the Host-overridden request below.
    await signInAndOpen(page, "/admin/reservations");

    const res = await page.request.get(`${E2E.webOrigin}/reservations`, {
      headers: asAdminHost,
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    const body = await res.text();
    // A board rendered, and the clean URL carried no credential into it.
    expect(body.length).toBeGreaterThan(2000);
    expect(countOf(body, TOKEN)).toBe(0);
  });

  test("serves a token-kept tool at its clean URL for a signed-in staff member", async ({
    page,
    context,
  }) => {
    // `admin.fasttraxent.com/pit` has worked for months and must survive the
    // domain move. It resolves as a `legacy-tool`: SSO-gated like everything
    // else on this host, but rewritten to the TOKENED path server-side, because
    // that is the only route the tool has. The browser never sees the token —
    // which is the whole difference the registry's two lists encode.
    await beMicrosoftUser(context, "eric");
    await signInAndOpen(page, "/admin/reservations");

    const res = await page.request.get(`${E2E.webOrigin}/pit`, {
      headers: asAdminHost,
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
  });

  test("sends an unauthenticated visitor to /sso/signin with the CLEAN callback", async ({
    request,
  }) => {
    const res = await request.get(`${E2E.webOrigin}/reservations`, {
      headers: { ...asAdminHost, accept: "text/html", "sec-fetch-mode": "navigate" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(307);
    const loc = new URL(res.headers()["location"], E2E.webOrigin);
    expect(loc.pathname).toBe("/sso/signin");
    // `/reservations`, not `/admin/reservations` — they land back where they
    // started, on a URL they have actually seen.
    expect(loc.searchParams.get("callbackUrl")).toBe("/reservations");
  });

  test("404s a guest route — the booking funnel never renders here", async ({ request }) => {
    for (const p of ["/book", "/racing", "/"]) {
      const res = await request.get(`${E2E.webOrigin}${p}`, {
        headers: asAdminHost,
        maxRedirects: 0,
      });
      expect(res.status(), p).toBe(404);
    }
  });
});
