import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { BUILDER_TEST_IDS } from "../src/features/crm/bmi/contracts";

/**
 * THE BUILDER'S LAYOUT PROOF (C5) — "Build in BMI" at 1280 and 390 px.
 *
 * ── WHY EVERY API CALL IS STUBBED ─────────────────────────────────────────
 *
 * This screen WRITES TO BMI OFFICE. Pointing it at the real routes would mean
 * a Playwright run creating projects and product lines on a live tenant, and
 * no test project exists at any centre. So every `/api/admin/crm/builder*`
 * response is served by `page.route()` from the fixture below: the render is
 * real, the React Query wiring is real, the CSS is real — and not one byte
 * reaches Office or Neon. The write RAIL is proven separately, against MSW, in
 * `src/features/crm/bmi/service/builder.test.ts`.
 *
 * ── WHAT THE FIXTURE IS FOR ───────────────────────────────────────────────
 *
 * It puts every state a rep can meet on ONE screen at once, because that is
 * the layout that has to survive 390 px: a written line, a line Office refused
 * with its own words, a line the kill switch never sent, a product row someone
 * added in the Office UI, the "syncing to centre" banner, and the templates
 * strip. A screenshot of the happy path proves nothing about the day it goes
 * wrong.
 *
 * Signed in as `eric` (sales + sales-director) so `canForce` is true and the
 * director-only "Force (overbook)" control is in the shot.
 *
 * Run: SSO_GATEWAY_DIR=C:/GIT/tools-auth/.claude/worktrees/crm-roles E2E_ADMIN_SSO=1
 *      npx playwright test -c apps/web/playwright.config.ts e2e/crm-builder.spec.ts
 *
 * Shots land in apps/web/test-results/crm-shots/ (gitignored; never commit a PNG).
 */

const enabled = process.env.E2E_ADMIN_SSO === "1";
test.skip(!enabled, "set E2E_ADMIN_SSO=1 to run the CRM builder layout suite");

const SHOTS = path.resolve(__dirname, "../test-results/crm-shots");
const WIDTHS = [1280, 390] as const;
const LEAD = "L-1042";

const byTestId = (id: string) => `[data-testid="${id}"]`;

async function beMicrosoftUser(context: BrowserContext, fixture: string) {
  await context.addCookies([
    { name: "mock_entra_session", value: fixture, domain: "localhost", path: "/" },
  ]);
}

// ---------------------------------------------------------------------------
// The fixture — every state on one screen
// ---------------------------------------------------------------------------

function quoteLine(patch: Record<string, unknown>) {
  return {
    id: "1",
    leadId: "1",
    bmiProjectId: "63000000009561501",
    productId: "14838862",
    productName: "Race pack",
    nameOverride: null,
    quantity: 2,
    pricePerUnitCents: 2499,
    priceDate: "2026-10-17",
    resourceId: null,
    scheduleBlocks: [],
    bmiProjectProductId: null,
    bmiScheduleIds: [],
    status: "pending",
    writeError: null,
    officePrompt: null,
    actorEmail: "eric@headpinz.com",
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
    ...patch,
  };
}

const BUILDER_STATE = {
  ok: true,
  lead: {
    publicId: LEAD,
    title: "Arthrex — engineering social",
    centre: "FT",
    clientKey: "headpinzftmyers",
    eventDate: "2026-10-17",
    eventTime: "18:00",
    guests: 24,
    statusId: "quote",
    bmiProjectId: "63000000009561501",
  },
  leadMissing: false,
  project: {
    projectId: "63000000009561501",
    clientKey: "headpinzftmyers",
    number: "H3311",
    name: "Arthrex — engineering social",
    date: "2026-10-17",
    time: "18:00",
    persons: 24,
    personId: "63000000009561437",
    stateId: "49130082",
    stateName: null,
  },
  lines: [
    quoteLine({
      id: "1",
      productName: "Race pack — 2 races",
      quantity: 4,
      status: "written",
      bmiProjectProductId: "63000000009561513",
      scheduleBlocks: [
        {
          resourceId: "11208654",
          start: "2026-10-17T18:00:00",
          stop: "2026-10-17T18:12:00",
          persons: 24,
        },
      ],
      bmiScheduleIds: ["63000000009561540"],
    }),
    quoteLine({
      id: "2",
      productName: "Duckpin lane (2 hours)",
      quantity: 4,
      pricePerUnitCents: 8900,
      status: "failed",
      bmiProjectProductId: "63000000009561514",
      writeError: "This heat is full — pick another.",
      officePrompt: {
        message:
          "Total persons (24) is higher than the capacity (14) in Red Track: " +
          "10/17/2026 6:24:00 PM - 10/17/2026 6:36:00 PM, overbooking is not allowed.",
        operationId: "8389cf8a268af9b19134286e9ae39f06",
      },
    }),
    quoteLine({ id: "3", productName: "Pizza (16 inch)", quantity: 6, pricePerUnitCents: 1899 }),
    quoteLine({
      id: "4",
      productName: "Soda pitcher",
      quantity: 6,
      pricePerUnitCents: 899,
      status: "paused",
      writeError: "BMI writes are paused by admin",
    }),
  ],
  officeOnly: [
    {
      bmiProjectProductId: "63000000009561599",
      productId: "999",
      name: "Room hire — added in Office",
      quantity: 1,
      totalCents: 15000,
    },
  ],
  changedInOffice: true,
  balance: {
    totalCents: 79_884,
    paidCents: 0,
    balanceCents: 79_884,
    readAt: "2026-09-13T12:05:00.000Z",
  },
  writes: { enabled: true, reason: null, message: null },
  sync: "syncing",
  canForce: true,
};

const TEMPLATES = {
  ok: true,
  templates: [
    {
      id: "1",
      name: "Corporate 24 — races + duckpin",
      centre: null,
      baselineGuests: 24,
      description: null,
      lines: [{ productId: "14838862", per: 6, min: 2 }],
      uses: 34,
      createdBy: "eric@headpinz.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "2",
      name: "School field trip",
      centre: "FT",
      baselineGuests: 40,
      description: null,
      lines: [{ productId: "14838863", per: 8 }],
      uses: 0,
      createdBy: "eric@headpinz.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const CATALOG = {
  ok: true,
  centre: "FT",
  date: "2026-10-17",
  source: "office",
  products: [
    { productId: "14838862", name: "Race pack — 2 races", priceCents: null },
    { productId: "14838863", name: "Race pack — 3 races", priceCents: null },
    { productId: "14838870", name: "Pizza (16 inch)", priceCents: null },
    { productId: "14838880", name: "Duckpin lane (2 hours)", priceCents: null },
  ],
};

/**
 * Serve every builder read from the fixture. A POST would be a WRITE, so it is
 * refused loudly rather than answered: nothing in this suite may mutate, and a
 * test that starts trying to should fail rather than quietly succeed.
 */
async function stubBuilderApi(page: Page) {
  await page.route("**/api/admin/crm/builder**", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "the layout suite must not mutate" }),
      });
    }
    const url = new URL(req.url());
    const body = url.pathname.endsWith("/templates")
      ? TEMPLATES
      : url.pathname.endsWith("/catalog")
        ? CATALOG
        : BUILDER_STATE;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

// ---------------------------------------------------------------------------
// The layout assertions — the same shape `crm-signin.spec.ts` uses
// ---------------------------------------------------------------------------

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);

    const metrics = await page.evaluate(() => {
      const de = document.documentElement;
      const cw = de.clientWidth;
      const ih = window.innerHeight;
      const describe = (el: Element) => {
        const r = el.getBoundingClientRect();
        const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
        return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} ${Math.round(r.left)}..${Math.round(r.right)}`;
      };
      // A box inside an `overflow:auto|hidden` ancestor is that ancestor's
      // scroll content, not the document's — tables and heat grids are allowed
      // to be wider than the screen inside their own scroller.
      const clipped = (el: Element) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p);
          if (o.overflow !== "visible" || o.overflowX !== "visible" || o.overflowY !== "visible")
            return true;
        }
        return false;
      };
      const wide: string[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (clipped(el)) continue;
        if (r.right > cw + 1 && wide.length < 8) wide.push(describe(el));
      }
      window.scrollTo(cw * 4, ih * 4);
      const scrolledTo = { x: window.scrollX, y: window.scrollY };
      window.scrollTo(0, 0);
      const floors: string[] = [];
      for (let el: Element | null = document.querySelector(".shell"); el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        const cls = (el.getAttribute("class") ?? "").split(/\s+/)[0] ?? "";
        if (parseFloat(cs.minHeight) >= ih - 1)
          floors.push(
            `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} min-height:${cs.minHeight}`,
          );
      }
      return { wide, scrolledTo, floors, bodyScrollHeight: document.body.scrollHeight, ih };
    });

    console.log(`[layout] ${name}@${width}: ${JSON.stringify(metrics)}`);
    expect(
      metrics.scrolledTo.x,
      `${name}@${width}: the window scrolls horizontally; offenders: ${metrics.wide.join(" | ")}`,
    ).toBe(0);
    expect(metrics.wide, `${name}@${width}: boxes painted past the right edge`).toEqual([]);
    expect(
      metrics.scrolledTo.y,
      `${name}@${width}: the DOCUMENT scrolls vertically — only .content may`,
    ).toBe(0);
    expect(
      metrics.floors,
      `${name}@${width}: a min-height floor at the viewport height is back above .content`,
    ).toEqual([]);

    await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

// ---------------------------------------------------------------------------

test.describe("eric — director, the builder with a quote on it", () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext();
    await beMicrosoftUser(ctx, "eric");
    page = await ctx.newPage();
    await stubBuilderApi(page);
  });
  test.afterAll(async () => {
    await ctx?.close();
  });

  test("renders the quote, the refusal and the Office banner at 1280 and 390", async () => {
    await page.goto(`/admin/crm/builder/${LEAD}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    await expect(page.locator(byTestId(BUILDER_TEST_IDS.screen))).toBeVisible();
    await expect(page.locator(byTestId(BUILDER_TEST_IDS.lines))).toBeVisible();

    // The line Office refused shows OFFICE'S OWN WORDS. This is the assertion
    // that matters most on this screen: a rep needs to read which heat is full
    // and by how much, not "something went wrong".
    const prompt = page.locator(byTestId(BUILDER_TEST_IDS.officePrompt)).first();
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("higher than the capacity");

    // An edit made in the Office UI is NAMED, never silently overwritten.
    const changed = page.locator(byTestId(BUILDER_TEST_IDS.changedInOffice));
    await expect(changed).toBeVisible();
    await expect(changed).toContainText("Room hire — added in Office");

    // Cloud is not the desk's copy, and the screen says so.
    await expect(page.locator(".banner.info")).toContainText("Syncing to the centre");

    // The quote's own total, from OUR rows — not Office's.
    await expect(page.locator(byTestId(BUILDER_TEST_IDS.balance))).toContainText("Quote total");

    // "Never used" beside "Used 34 times" is the whole stale-package feature.
    const templates = page.locator(byTestId(BUILDER_TEST_IDS.templates));
    await expect(templates).toContainText("Used 34 times");
    await expect(templates).toContainText("Never used");

    await shoot(page, "builder-director");
  });

  test("a rep-safe screen: no lead named is a sentence, not an empty page", async () => {
    await page.goto("/admin/crm/builder", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".banner.info")).toContainText("Open the builder from a deal");
  });
});
