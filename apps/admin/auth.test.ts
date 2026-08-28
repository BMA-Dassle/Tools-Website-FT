import { afterEach, describe, expect, it } from "vitest";
import { buildAuthConfig, hasAccess, REQUIRED_ROLE } from "./auth";

/**
 * The shell's Auth.js configuration, pinned on the two things that are easy to
 * get wrong and impossible to see failing until a deploy:
 *
 *  1. WHEN the environment is read. Auth.js validates its config on the first
 *     REQUEST, so any `process.env` read hoisted to module scope silently bakes
 *     in whatever was set at import time — a Vercel variable added after the
 *     bundle was built, or a value changed between requests, never lands. The
 *     config is a factory precisely so this cannot happen; these tests fail if
 *     someone hoists a read back out of it.
 *  2. WHAT authorization means here — one role, no synonyms.
 */

const ENV_KEYS = ["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The single OIDC provider, typed loosely — Auth.js's union is wide. */
function provider() {
  const p = buildAuthConfig().providers[0] as unknown as {
    id: string;
    type: string;
    issuer?: string;
    clientId?: string;
    clientSecret?: string;
    checks?: string[];
    authorization?: { params?: { scope?: string } };
  };
  return p;
}

describe("buildAuthConfig — env is read per call, never at module scope", () => {
  it("picks up an issuer/client set AFTER this module was imported", () => {
    process.env.SSO_ISSUER = "https://auth.headpinz.com/oidc";
    process.env.SSO_CLIENT_ID = "fasttrax-admin";
    process.env.SSO_CLIENT_SECRET = "s3cret";
    expect(provider()).toMatchObject({
      issuer: "https://auth.headpinz.com/oidc",
      clientId: "fasttrax-admin",
      clientSecret: "s3cret",
    });
  });

  it("sees a CHANGED value on the next call — a rotated secret needs no rebuild", () => {
    process.env.SSO_CLIENT_SECRET = "first";
    expect(provider().clientSecret).toBe("first");
    process.env.SSO_CLIENT_SECRET = "second";
    expect(provider().clientSecret).toBe("second");
  });

  it("defaults the client id and leaves the issuer empty rather than guessing", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(provider()).toMatchObject({ clientId: "fasttrax-admin", issuer: "" });
    expect(provider().clientSecret).toBeUndefined();
  });
});

describe("buildAuthConfig — the parts the gateway contract depends on", () => {
  it("is the stock OIDC recipe: pkce+state+nonce, roles in scope, jwt session", () => {
    const cfg = buildAuthConfig();
    const p = provider();
    expect(p).toMatchObject({ id: "headpinz", type: "oidc" });
    expect(p.checks).toEqual(["pkce", "state", "nonce"]);
    expect(p.authorization?.params?.scope).toContain("roles");
    // jwt, not database: proxy.ts runs this on the edge on every request.
    expect(cfg.session).toMatchObject({ strategy: "jwt" });
    // No algorithm is named anywhere — the gateway may rotate ES256 → RS256.
    expect(JSON.stringify(cfg)).not.toMatch(/ES256|RS256/);
  });

  it("sends failures to the page that shows a code and a request id", () => {
    expect(buildAuthConfig().pages?.error).toBe("/sso/error");
  });
});

describe("hasAccess — the ONE authorization rule", () => {
  it("requires the role and nothing else stands in for it", () => {
    expect(hasAccess({ roles: [REQUIRED_ROLE] })).toBe(true);
    expect(hasAccess({ roles: ["admin", REQUIRED_ROLE] })).toBe(true);
    expect(hasAccess({ roles: ["admin"] })).toBe(false);
    expect(hasAccess({ roles: [] })).toBe(false);
    expect(hasAccess({})).toBe(false);
    expect(hasAccess(null)).toBe(false);
    expect(hasAccess(undefined)).toBe(false);
  });
});
