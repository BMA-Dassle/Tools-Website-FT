import { expect, test, type Page } from "@playwright/test";
import { KIOSK_E2E } from "../playwright.kiosk.config";

/**
 * TODAY'S CREW, END TO END: a real browser, the deployed kiosk, the real
 * /api/kiosk/todays-crew read over real Neon rows.
 *
 * The unit suites prove the rules (who is offered, when the sheet pops, what
 * the pill says). This suite exists for the things they structurally cannot
 * reach — the three that bit the family picker the week before (2026-09-05):
 *
 *   1. Does the pill exist BEFORE the lookup lands? The owner's requirement is
 *      a loading state, not a pill that "randomly appears". Only a clock and a
 *      DOM can measure that.
 *   2. Is the sheet actually above the action bar? `.k-flow-body` and
 *      `.k-z-actions` are equal-z-index siblings, and a "full-screen" overlay
 *      rendered inside the body loses to the action bar on DOM order. The
 *      family sheet shipped that way. `elementFromPoint` is the only honest
 *      instrument.
 *   3. Do the three pills sit on ONE line (owner 2026-09-06)? A wrap is a
 *      layout fact.
 *
 * ── SETUP (each run) ─────────────────────────────────────────────────────────
 *   1. npx tsx scripts/seed-todays-crew-smoke.mts --person <testPersonId> \
 *        --co "<id>:<First Last>" --co "<id>:<First Last>"
 *      (the test account is whoever THE test phone resolves to; the co-racers
 *      must be real test persons — see the seed script's header).
 *   2. The deployment must allow the test kiosk's OTP bypass
 *      (KIOSK_CHECKIN_OTP_BYPASS_KIOSK_IDS includes fort-myers:99) — otherwise
 *      the sign-in texts a code and this suite cannot proceed.
 *   3. E2E_KIOSK_CREW=1 E2E_BASE_URL=https://<deploy> E2E_CREW_NAMES="First Last,First Last" \
 *        [E2E_SELF_NAME="<the test account's name as the lookup lists it>"] \
 *        npx playwright test -c apps/web/playwright.kiosk.config.ts
 *   4. npx tsx scripts/seed-todays-crew-smoke.mts --clean
 * ─────────────────────────────────────────────────────────────────────────────
 */

const enabled = process.env.E2E_KIOSK_CREW === "1";
test.skip(!enabled, "set E2E_KIOSK_CREW=1 (and E2E_BASE_URL, E2E_CREW_NAMES) to run");

const SELF_NAME = process.env.E2E_SELF_NAME || "";

/** Provision the test kiosk and land on the Your Crew page. */
async function openCrewPage(page: Page) {
  // The launch URL provisions the device (center + kiosk number → localStorage).
  await page.goto(`/kiosk?${KIOSK_E2E.kioskQuery}`);
  await page.goto("/kiosk/racers");
  await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
}

/** Drive the returning-racer lookup with THE test phone on the test kiosk (OTP
 *  bypass). Returns the moment the roster card exists — that is t=0 for the
 *  pending-pill clock. */
async function signInTestAccount(page: Page): Promise<number> {
  await page
    .getByRole("button", { name: /sign in/i })
    .first()
    .click();
  const phoneMode = page.getByRole("button", { name: /phone/i });
  if (
    await phoneMode
      .first()
      .isVisible()
      .catch(() => false)
  )
    await phoneMode.first().click();
  await page.getByPlaceholder("(555) 555-1234").fill(KIOSK_E2E.testPhone);
  await page.getByRole("button", { name: /look up/i }).click();
  // Verified (bypass) → pick the account. A household on the test number
  // renders several cards; SELF_NAME picks ours, else the first card.
  await expect(page.getByText(/verified/i).first()).toBeVisible();
  const card = SELF_NAME
    ? page.getByRole("button", { name: new RegExp(SELF_NAME, "i") }).first()
    : page.locator("button").filter({ hasText: /./ }).nth(0);
  await card.click();
  const confirm = page.getByRole("button", { name: /^(continue|add selected|add \d+ people)$/i });
  if (
    await confirm
      .first()
      .isVisible()
      .catch(() => false)
  )
    await confirm.first().click();
  const t0 = Date.now();
  // The roster card carries the "My race history" action once a member exists.
  await expect(page.getByRole("button", { name: /race history/i }).first()).toBeVisible();
  return t0;
}

test.describe("Today's Crew on the kiosk", () => {
  test("the pill is pending BEFORE the lookup lands, then the sheet pops once", async ({
    page,
  }) => {
    await openCrewPage(page);
    const t0 = await signInTestAccount(page);

    // 1. Loading state: an aria-busy pill within 300 ms of the card appearing.
    const pending = page.locator('button[aria-busy="true"]');
    await expect(pending.first()).toBeVisible({ timeout: 300 });
    expect(Date.now() - t0, "pending pill must be drawn with the card").toBeLessThan(300 + 200);

    // 2. The sheet pops on its own with the seeded co-racers.
    const sheet = page.getByText(/today.s crew/i).first();
    await expect(sheet).toBeVisible();
    for (const name of KIOSK_E2E.crewNames) {
      await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    }

    // 3. The action bar is NOT tappable through the open sheet: the element
    //    under the centre of "Book something" must be the scrim / sheet, not
    //    the button (the equal-z-index trap that shipped on 2026-09-05).
    const bookBtn = page.getByRole("button", { name: /book something/i }).first();
    const box = await bookBtn.boundingBox();
    expect(box, "action bar button not found").not.toBeNull();
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName}.${el.className}` : "none";
      },
      [box!.x + box!.width / 2, box!.y + box!.height / 2],
    );
    expect(hit, "the action bar paints OVER the open sheet").not.toMatch(/k-btn-primary/);

    // 4. "Not today" leaves the live pill; tapping it reopens the sheet.
    await page.getByRole("button", { name: /not today/i }).click();
    const crewPill = page.getByRole("button", { name: /today.s crew · \d+/i }).first();
    await expect(crewPill).toBeVisible();
    await expect(crewPill).not.toHaveAttribute("aria-busy", "true");
    await crewPill.click();
    await expect(page.getByRole("button", { name: /select all/i })).toBeVisible();

    // 5. Select all → Add N players grows the roster by N.
    const cardsBefore = await page.getByRole("button", { name: /remove/i }).count();
    await page.getByRole("button", { name: /select all/i }).click();
    await page.getByRole("button", { name: /^add \d+ players?$/i }).click();
    await expect(page.getByRole("button", { name: /remove/i })).toHaveCount(
      cardsBefore + KIOSK_E2E.crewNames.length,
    );
    // …and the pill is gone: everyone has been added.
    await expect(page.getByRole("button", { name: /today.s crew · \d+/i })).toHaveCount(0);
  });

  test("the chip row stays on ONE line", async ({ page }) => {
    await openCrewPage(page);
    await signInTestAccount(page);
    await page
      .getByRole("button", { name: /not today/i })
      .click()
      .catch(() => {});
    // Every pill in the first roster card's chip row shares one offsetTop.
    const tops = await page.evaluate(() => {
      const row = document.querySelector(".flex.flex-nowrap.items-center");
      if (!row) return [] as number[];
      return Array.from(row.children).map((c) => (c as HTMLElement).offsetTop);
    });
    expect(tops.length, "chip row not found").toBeGreaterThan(0);
    expect(new Set(tops).size, `pills wrapped onto ${new Set(tops).size} lines`).toBe(1);
  });

  test("a second sign-in of the same person does not pop the sheet again", async ({ page }) => {
    await openCrewPage(page);
    await signInTestAccount(page);
    await page.getByRole("button", { name: /not today/i }).click();
    // Remove the member and sign in again — the offer was already made.
    await page
      .getByRole("button", { name: /remove/i })
      .first()
      .click();
    await signInTestAccount(page);
    await expect(page.getByRole("button", { name: /today.s crew · \d+/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /not today/i })).toHaveCount(0);
  });
});
