import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The admin-SSO end-to-end suite: a real browser, a real OIDC gateway, a real
 * Microsoft stand-in, and this app.
 *
 * WHY IT IS NOT PART OF `npm test`. It needs three servers and a checkout of
 * the gateway repo, so it is opt-in: run it with `E2E_ADMIN_SSO=1`. Without
 * that flag the suite is skipped rather than failing, and CI is unaffected.
 *
 * WHY IT EXISTS AT ALL. Every unit test around the gate asserts a DECISION —
 * which branch fires, what header is set, what the routing table returns. None
 * of them can answer the question the whole pivot was for: does the static
 * `ADMIN_CAMERA_TOKEN` still end up in the bytes a browser receives? That is a
 * property of Next's RSC serialisation, not of our code (see
 * tasks/admin-sso-lockdown.md audit item #8 — the token was found twice in the
 * HTML of every proxied board, put there by the resolved `[token]` segment with
 * no application code involved). The only way to answer it is to load the page
 * and count.
 *
 * ── HOW TO RUN ───────────────────────────────────────────────────────────────
 *   1. Have the gateway worktree at C:/GIT/tools-auth/.claude/worktrees/sso
 *      (override with SSO_GATEWAY_DIR).
 *   2. Build this app once: `npm run build -w fasttrax-web`.
 *   3. `E2E_ADMIN_SSO=1 npx playwright test -c apps/web/playwright.config.ts`
 *      (or `npm run e2e:sso -w fasttrax-web` with the flag exported).
 *
 * Playwright starts and stops all three servers itself, so there is nothing to
 * clean up by hand.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ENABLED = process.env.E2E_ADMIN_SSO === "1";

const GATEWAY_DIR = process.env.SSO_GATEWAY_DIR || "C:/GIT/tools-auth/.claude/worktrees/sso";

/** Ports. 3111 is the port registered as this client's dev redirect_uri with
 *  the gateway (`src/config/clients.ts`) — it is not a free choice. */
const WEB_PORT = 3111;
const GATEWAY_PORT = 3100;
const MOCK_ENTRA_PORT = 3200;

/** One `.env.local`, parsed. Missing file → `{}`. */
function parseEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // An EMPTY value is not an answer — it is a placeholder. Keeping it would
    // shadow the same key in the lower-priority file and silently disable the
    // assertion that depends on it (the embed and api-key checks skipped
    // themselves for exactly this reason on the first run).
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The app's environment, READ-ONLY, layered: this worktree's own `.env.local`
 * first, the primary checkout's on top, `E2E_ENV_FILE` last.
 *
 * The boards talk to Neon, BMI and Square; without the real values every page
 * renders an error state and the token count below would pass for the wrong
 * reason. No file here is written to and none is ever copied into the repo —
 * they are parsed and the result is handed to the child process.
 */
function readEnvLocal(): Record<string, string> {
  return {
    ...parseEnvFile(path.resolve(__dirname, ".env.local")),
    ...parseEnvFile("C:/GIT/Tools-Website-FT/apps/web/.env.local"),
    ...(process.env.E2E_ENV_FILE ? parseEnvFile(process.env.E2E_ENV_FILE) : {}),
  };
}

/**
 * FIXED, and deliberately so. Playwright loads this config in the runner AND
 * again in every worker process, so a `Math.random()` here would give the
 * server one value and the assertions another — which is precisely how the
 * first run of this suite got a 401 out of a `/sso/diag` call it had just
 * authenticated. These are local-harness values on a localhost server that
 * holds no production credential; the gateway's own dev defaults are the same
 * kind of value.
 */
const LOCAL_AUTH_SECRET = "e2e-local-auth-secret-not-a-production-value";
const LOCAL_DIAG_SECRET = "e2e-local-diag-secret-not-a-production-value";

/**
 * `ADMIN_EMBED_SECRET` and `SALES_API_KEYS` are blank in every local `.env.local`
 * — they exist only on Vercel. Left blank, the two "the other credentials still
 * work" tests would SKIP, which is a green suite that proved nothing about the
 * exact branches most at risk from a new gate. So the harness supplies its own
 * values and asserts against those: what is under test is that the middleware
 * still honours an embed HMAC and an api-key, not what the production secrets
 * happen to be. A real value in the env still wins.
 */
const LOCAL_EMBED_SECRET = "e2e-local-embed-secret";
const LOCAL_SALES_API_KEY = "e2e-local-sales-api-key";

const appEnv = readEnvLocal();

export const E2E = {
  webOrigin: `http://localhost:${WEB_PORT}`,
  gatewayOrigin: `http://localhost:${GATEWAY_PORT}`,
  mockEntraOrigin: `http://localhost:${MOCK_ENTRA_PORT}`,
  /** The value that must appear ZERO times in a v2 board's bytes. */
  adminCameraToken: appEnv.ADMIN_CAMERA_TOKEN || "",
  adminEmbedSecret: appEnv.ADMIN_EMBED_SECRET || LOCAL_EMBED_SECRET,
  salesApiKey: (appEnv.SALES_API_KEYS || "").split(",")[0]?.trim() || LOCAL_SALES_API_KEY,
  diagSecret: LOCAL_DIAG_SECRET,
};

const webEnv: Record<string, string> = {
  ...appEnv,
  NODE_ENV: "production",
  PORT: String(WEB_PORT),
  SSO_ISSUER: `${E2E.gatewayOrigin}/oidc`,
  SSO_CLIENT_ID: "fasttrax-admin",
  // The gateway's dev default for this client (its src/env.ts). Never a
  // production secret — the gateway under test is the local one.
  SSO_CLIENT_SECRET: process.env.E2E_SSO_CLIENT_SECRET || "dev-fasttrax-admin-secret",
  AUTH_SECRET: LOCAL_AUTH_SECRET,
  AUTH_TRUST_HOST: "true",
  AUTH_URL: `http://localhost:${WEB_PORT}`,
  DIAG_SECRET: E2E.diagSecret,
  ADMIN_EMBED_SECRET: E2E.adminEmbedSecret,
  SALES_API_KEYS: E2E.salesApiKey,
  // `localhost:3111` is not an admin host by default; the admin-host tests set
  // the Host header to admin.fasttraxent.com, which IS one unconditionally.
  ADMIN_HOSTS: "",
  // ── The two switches the suite MEASURES, pinned rather than inherited ──────
  // The redirect lane (a valid tokened URL for an SSO tool 307s to the clean
  // one) has a kill switch, and an operator who set it in a local `.env.local`
  // would otherwise turn four assertions in "the redirect lane" into a silent
  // pass of the OPPOSITE behaviour. Empty string, not "true": the lane is ON,
  // which is how it ships.
  ADMIN_TOKEN_REDIRECT_DISABLED: "",
  // The trusted-proxy branch returns BEFORE the SSO branch, so a stray
  // ADMIN_PROXY_KEY would let a header-carrying request skip the gate entirely.
  // The shell is being retired; the harness never sets it.
  ADMIN_PROXY_KEY: "",
};

export default defineConfig({
  testDir: path.resolve(__dirname, "e2e"),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: E2E.webOrigin,
    trace: "retain-on-failure",
    // The gateway issues cookies for localhost:3100 and this app for
    // localhost:3111. Both are http, so nothing needs a certificate.
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: ENABLED
    ? [
        {
          // The Microsoft stand-in. Fixture users are chosen by `login_hint`:
          // eric (all roles), mgr, mkt (no fasttrax-admin role), nomail, norole.
          command: "npm run mock:entra",
          cwd: GATEWAY_DIR,
          url: `${E2E.mockEntraOrigin}/__log`,
          reuseExistingServer: true,
          timeout: 60_000,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          // The real gateway, pointed at the mock Entra and a local pglite DB.
          command: "npm run dev",
          cwd: GATEWAY_DIR,
          url: `${E2E.gatewayOrigin}/oidc/.well-known/openid-configuration`,
          reuseExistingServer: true,
          timeout: 180_000,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ENTRA_AUTHORITY_BASE: E2E.mockEntraOrigin,
            DATABASE_URL: "pglite://.data/sso",
          },
        },
        {
          // This app, from the production build, so the HTML and RSC payloads
          // the token count inspects are the ones staff would actually receive.
          command: `npx next start -p ${WEB_PORT}`,
          cwd: __dirname,
          url: `${E2E.webOrigin}/sso/error?code=SSO_E_UNKNOWN`,
          reuseExistingServer: false,
          timeout: 180_000,
          stdout: "pipe",
          stderr: "pipe",
          env: webEnv,
        },
      ]
    : undefined,
});
