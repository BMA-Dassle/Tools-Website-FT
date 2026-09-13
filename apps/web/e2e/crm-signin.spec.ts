import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { E2E } from "../playwright.config";
import { ADMIN_NAV_GROUP_ID, TEST_IDS } from "../src/features/crm/core/contracts";

/**
 * THE CRM SIGN-IN PROOF (brief §3.10). The `admin-sso.spec.ts` sweep also
 * visits `/admin/crm`, but it asserts only pathname + "no sign-in error" +
 * token count, which is vacuous for a shell that renders nothing. This suite
 * signs in as each of the three fixtures the `crm-roles` gateway worktree
 * carries and asserts what the ROLE sees:
 *
 *   eric  (fasttrax-admin.sales + sales-director)  → 200, the shell, the director-only
 *         "Admin" nav group, a REAL statuses table on /admin/crm/statuses; and,
 *         like every SSO board, no ADMIN_CAMERA_TOKEN in the bytes and a freshly
 *         minted credential in its place.
 *   rep   (Kelsea, fasttrax-admin.sales only)      → 200 with NO Admin group; /admin/crm/queue
 *         renders the in-app "not for your role" screen (status 200, never Next's 404).
 *   mgr   (fasttrax-admin.access only)             → 404 from requireCrmUser().
 *   nobody (fresh context)                         → 307 to /sso/signin.
 *
 * Run: SSO_GATEWAY_DIR=C:/GIT/tools-auth/.claude/worktrees/crm-roles E2E_ADMIN_SSO=1
 *      npx playwright test -c apps/web/playwright.config.ts e2e/crm-signin.spec.ts
 * (`E2E_ADMIN_SSO=1` is the ONLY flag that starts the three servers; the
 * config's default gateway worktree lacks the sales roles.)
 *
 * The helpers below mirror `admin-sso.spec.ts` (module-private there):
 * `beMicrosoftUser`, `documentBytes`, `countOf`, `MINTED`. Keep them in step.
 *
 * Screenshots land in apps/web/test-results/crm-shots/<name>-<width>.png at
 * 1280 and 390 px (test-results/ is gitignored; never commit a PNG).
 */

const enabled = process.env.E2E_ADMIN_SSO === "1";
test.skip(!enabled, "set E2E_ADMIN_SSO=1 to run the CRM sign-in suite");

const TOKEN = E2E.adminCameraToken;
const SHOTS = path.resolve(__dirname, "../test-results/crm-shots");
const WIDTHS = [1280, 390] as const;

/** The `<expMs>.<hex>` shape `mintAdminApiToken()` produces. */
const MINTED = /\b\d{13}\.[0-9a-f]{32,}\b/;

async function beMicrosoftUser(context: BrowserContext, fixture: string) {
  await context.addCookies([
    { name: "mock_entra_session", value: fixture, domain: "localhost", path: "/" },
  ]);
}

async function documentBytes(page: Page): Promise<string> {
  const html = await page.content();
  const rsc = await page.evaluate(() => {
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

const byTestId = (id: string) => `[data-testid="${id}"]`;

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    // No horizontal overflow at either width (the phone rule in CLAUDE.md /
    // brief §6.3: zero horizontal scroll at 390). Tables and boards may be
    // wider only inside their own `overflow-x: auto` box, never the document.
    //
    // MEASURED BY TRYING TO SCROLL, not by `documentElement.scrollWidth`: with
    // the shell at 100dvh and `.content` as the scroller, Chromium still
    // reports the clipped descendants' extent on the root element (1646 px
    // tall / 699 px wide for the statuses page) while the window itself cannot
    // move a pixel — `scrollTo` is what a thumb does, so it is what we assert.
    const metrics = await page.evaluate(() => {
      const de = document.documentElement;
      const cw = de.clientWidth;
      const ih = window.innerHeight;
      const describe = (el: Element) => {
        const r = el.getBoundingClientRect();
        const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
        return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} ${Math.round(r.left)}..${Math.round(r.right)} x ${Math.round(r.top)}..${Math.round(r.bottom)}`;
      };
      // Outermost offenders first: anything painted past the right edge or
      // below the shell is what makes the DOCUMENT scroll instead of `.content`.
      // …and only the UNCLIPPED ones count: a box inside an `overflow:auto|hidden`
      // ancestor is that ancestor's scroll content, not the document's.
      const clipped = (el: Element) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p);
          if (o.overflow !== "visible" || o.overflowX !== "visible" || o.overflowY !== "visible")
            return true;
        }
        return false;
      };
      const wide: string[] = [];
      const tall: string[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (clipped(el)) continue;
        if (r.right > cw + 1 && wide.length < 8) wide.push(describe(el));
        if (r.bottom > ih + 1 && tall.length < 8) tall.push(describe(el));
      }
      window.scrollTo(cw * 4, ih * 4);
      const scrolledTo = { x: window.scrollX, y: window.scrollY };
      window.scrollTo(0, 0);
      const sizes: Record<string, string> = {};
      for (const sel of [".crm-root", ".shell", ".main", ".content"]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        sizes[sel] = `h=${cs.height} minH=${cs.minHeight} ov=${cs.overflow} disp=${cs.display}`;
      }
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: cw,
        scrollHeight: de.scrollHeight,
        innerHeight: ih,
        bodyScrollHeight: document.body.scrollHeight,
        scrolledTo,
        wide,
        tall,
        sizes,
      };
    });
    console.log(`[layout] ${name}@${width}: ${JSON.stringify(metrics)}`);
    expect(
      metrics.scrolledTo.x,
      `${name}@${width}: the window scrolls horizontally; unclipped offenders: ${metrics.wide.join(" | ")}`,
    ).toBe(0);
    expect(metrics.wide, `${name}@${width}: boxes painted past the right edge`).toEqual([]);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Sign in once and land on the CRM; returns the response of the FINAL navigation. */
async function signInTo(page: Page, pathname: string) {
  await page.goto(pathname, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
}

test.beforeAll(() => {
  expect(TOKEN.length, "ADMIN_CAMERA_TOKEN must be present in .env.local").toBeGreaterThan(16);
});

test.afterAll(async ({ request }) => {
  // Harmless housekeeping on the mock Entra: no __grant was issued, so there
  // is nothing to undo, but a reset keeps a re-run from inheriting state.
  await request.post(`${E2E.mockEntraOrigin}/__reset`).catch(() => undefined);
});

test.describe.serial("eric — sales-director", () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await beMicrosoftUser(ctx, "eric");
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    await ctx?.close();
  });

  test("/admin/crm — 200, the shell, no static token, a minted credential, the Admin group", async () => {
    await signInTo(page, "/admin/crm");
    expect(new URL(page.url()).pathname).toBe("/admin/crm");
    await expect(page.locator("body")).not.toContainText("Sign-in didn't work");

    // The final document (post-OIDC) is a plain GET we can re-issue for its status.
    const res = await page.request.get(`${E2E.webOrigin}/admin/crm`, { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const bytes = await documentBytes(page);
    expect(bytes.length).toBeGreaterThan(2000);
    expect(countOf(bytes, TOKEN), "ADMIN_CAMERA_TOKEN leaked into the CRM page").toBe(0);
    expect(bytes).toMatch(MINTED);

    await expect(page.locator(byTestId(TEST_IDS.app))).toBeVisible();
    await expect(page.locator(byTestId(TEST_IDS.navGroup(ADMIN_NAV_GROUP_ID)))).toBeVisible();
    await expect(page.locator(byTestId(TEST_IDS.navItem("statuses")))).toBeVisible();
    await shoot(page, "director-crm");
  });

  test("/admin/crm/statuses — the REAL statuses table", async () => {
    await page.goto("/admin/crm/statuses", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).pathname).toBe("/admin/crm/statuses");
    await expect(page.locator(byTestId(TEST_IDS.screen("statuses")))).toBeVisible();
    await expect(page.locator(byTestId(TEST_IDS.statusesTable))).toBeVisible();
    await expect(page.locator(byTestId(TEST_IDS.bmiWritesToggle))).toBeVisible();
    // The seed's ten rows, by id, in the table (the seed runs lazily on first schema touch).
    await expect(page.locator(byTestId(TEST_IDS.statusesTable))).toContainText("Contract sent");
    expect(countOf(await documentBytes(page), TOKEN)).toBe(0);
    await shoot(page, "director-statuses");
  });

  test("the CRM's own /api/admin/crm/* calls succeed with the minted credential", async () => {
    const adminCalls: { url: string; status: number }[] = [];
    page.on("response", (res) => {
      const p = new URL(res.url()).pathname;
      if (p.startsWith("/api/admin/crm/")) adminCalls.push({ url: p, status: res.status() });
    });
    await page.goto("/admin/crm/statuses", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    expect(adminCalls.length, "the statuses screen made no /api/admin/crm/* calls").toBeGreaterThan(
      0,
    );
    const failed = adminCalls.filter((c) => [401, 403, 404, 500].includes(c.status));
    expect(failed, JSON.stringify(failed)).toHaveLength(0);
  });
});

test.describe.serial("rep — Kelsea, sales only", () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await beMicrosoftUser(ctx, "rep");
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    await ctx?.close();
  });

  test("/admin/crm — 200 with NO Admin group", async () => {
    await signInTo(page, "/admin/crm");
    expect(new URL(page.url()).pathname).toBe("/admin/crm");
    const res = await page.request.get(`${E2E.webOrigin}/admin/crm`, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    await expect(page.locator(byTestId(TEST_IDS.app))).toBeVisible();
    await expect(page.locator(byTestId(TEST_IDS.navGroup(ADMIN_NAV_GROUP_ID)))).toHaveCount(0);
    await expect(page.locator(byTestId(TEST_IDS.navItem("statuses")))).toHaveCount(0);
    expect(countOf(await documentBytes(page), TOKEN)).toBe(0);
  });

  test("/admin/crm/queue — the in-app 'not for your role' screen, status 200, never Next's 404", async () => {
    const res = await page.goto("/admin/crm/queue", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/admin/crm/queue");
    await expect(page.locator(byTestId(TEST_IDS.notForRole))).toBeVisible();
    await expect(page.locator("body")).not.toContainText("This page could not be found");
    await shoot(page, "rep-queue");
  });
});

test.describe("mgr — access only, no sales role", () => {
  test("/admin/crm is a 404 from requireCrmUser()", async ({ page, context }) => {
    await beMicrosoftUser(context, "mgr");
    await signInTo(page, "/admin/crm");
    // The gateway lets `access` through; the CRM page itself refuses.
    expect(new URL(page.url()).pathname).toBe("/admin/crm");
    const res = await page.request.get(`${E2E.webOrigin}/admin/crm`, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
    await expect(page.locator(byTestId(TEST_IDS.app))).toHaveCount(0);
  });
});

test.describe("signed out", () => {
  test("a fresh context is sent to /sso/signin with the CRM as callback", async ({ request }) => {
    const res = await request.get("/admin/crm", {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(307);
    const loc = new URL(res.headers()["location"], E2E.webOrigin);
    expect(loc.pathname).toBe("/sso/signin");
    expect(loc.searchParams.get("callbackUrl")).toBe("/admin/crm");
  });

  test("an unauthenticated CRM API call is an opaque 404", async ({ request }) => {
    // The MIDDLEWARE answers first — its /api/admin/* branch refuses a missing
    // credential with `{"error":"Not found"}` (application/json), and
    // withCrmRoute mirrors that byte for byte for anything that gets past it.
    // Either way: 404, no session, no user, no envelope.
    const res = await request.get("/api/admin/crm/me", { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(await res.text()).toBe('{"error":"Not found"}');
  });
});
