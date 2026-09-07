import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Kiosk end-to-end smokes against a DEPLOYED build (a Vercel preview, or
 * production with a test kiosk) — a real browser driving the real kiosk pages.
 *
 * Kept apart from playwright.config.ts, which is the admin-SSO harness and
 * boots three local servers; these specs need none of that, only a URL.
 *
 * ── HOW TO RUN ───────────────────────────────────────────────────────────────
 *   1. Seed whatever the spec needs (each spec's header says what).
 *   2. E2E_KIOSK_CREW=1 E2E_BASE_URL=https://<preview>.vercel.app \
 *        npx playwright test -c apps/web/playwright.kiosk.config.ts
 *   3. Clean up the seed.
 *
 * Without the enabling flag every spec here skips itself, so `npm test` and CI
 * are unaffected. The kiosk renders at 1080×1920 inside a transformed canvas;
 * the viewport below is that portrait size so nothing is scaled twice.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const KIOSK_E2E = {
  baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
  /** The test kiosk — number 99 by owner convention (isTestKiosk). */
  kioskQuery: "center=fasttrax&kiosk=99",
  /** THE test phone number (owner). */
  testPhone: process.env.E2E_TEST_PHONE || "2395551234",
  /** Comma-separated "First Last" of the seeded co-racers. */
  crewNames: (process.env.E2E_CREW_NAMES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export default defineConfig({
  testDir: path.resolve(__dirname, "e2e"),
  testMatch: /kiosk-.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: KIOSK_E2E.baseURL,
    trace: "retain-on-failure",
    viewport: { width: 1080, height: 1920 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1080, height: 1920 } },
    },
  ],
});
