import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SSO_PROVIDER_ID, buildAuthConfig, hasAdminAccess } from "./auth";
import { REQUIRED_ROLE } from "~/features/sso/session";

/**
 * The Auth.js configuration, asserted rather than assumed.
 *
 * Every value here is one that fails INVISIBLY when it is wrong: the wrong
 * provider id sends the gateway a callback URL that is not registered; a
 * missing scope means `roles` never arrives and everyone is refused; `trustHost`
 * unset means a sign-in begun on the admin host comes back to the brand host
 * with no state cookie; a hard-coded algorithm breaks the day the gateway
 * rotates to a new key type. None of those produce a stack trace — they produce
 * "sign-in doesn't work" and a long afternoon.
 */

const ENV = ["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET", "AUTH_SECRET"];

beforeEach(() => {
  process.env.SSO_ISSUER = "https://auth.headpinz.com/oidc";
  process.env.SSO_CLIENT_ID = "fasttrax-admin";
  process.env.SSO_CLIENT_SECRET = "dev-secret";
  process.env.AUTH_SECRET = "auth-secret";
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

/**
 * The provider entry as a plain bag of fields.
 *
 * Auth.js's `Provider` union covers OAuth, OIDC, email, credentials and WebAuthn
 * and can also be a factory function, so TypeScript will not narrow it to the
 * OIDC literal this file writes. The double assertion is the honest way to say
 * "read the object I know I wrote"; the assertions below are what verify it.
 */
const provider = () => buildAuthConfig().providers[0] as unknown as Record<string, unknown>;

describe("buildAuthConfig", () => {
  it("is a FACTORY — it reads the env at call time, not at import", () => {
    // `NextAuth(() => buildAuthConfig())` is what makes a Vercel env change take
    // effect on the next request instead of the next cold start. A hoisted
    // `process.env` read at module scope silently defeats it.
    expect(provider().issuer).toBe("https://auth.headpinz.com/oidc");
    process.env.SSO_ISSUER = "http://localhost:3100/oidc";
    expect(provider().issuer).toBe("http://localhost:3100/oidc");
  });

  it("registers ONE oidc provider whose id fixes the callback path", () => {
    const cfg = buildAuthConfig();
    expect(cfg.providers).toHaveLength(1);
    expect(SSO_PROVIDER_ID).toBe("headpinz");
    expect(provider().id).toBe("headpinz");
    expect(provider().type).toBe("oidc");
    // /api/auth/callback/headpinz — the value registered with the gateway.
    expect(`/api/auth/callback/${SSO_PROVIDER_ID}`).toBe("/api/auth/callback/headpinz");
  });

  it("asks for the roles scope — without it nobody is ever authorized", () => {
    const authorization = provider().authorization as { params: { scope: string } };
    expect(authorization.params.scope.split(/\s+/).sort()).toEqual([
      "email",
      "openid",
      "profile",
      "roles",
    ]);
  });

  it("defaults the client id but never invents a secret", () => {
    expect(provider().clientId).toBe("fasttrax-admin");
    delete process.env.SSO_CLIENT_ID;
    expect(provider().clientId).toBe("fasttrax-admin");
    delete process.env.SSO_CLIENT_SECRET;
    expect(provider().clientSecret).toBeUndefined();
  });

  it("runs the full check set — PKCE, state and nonce", () => {
    expect(provider().checks).toEqual(expect.arrayContaining(["pkce", "state", "nonce"]));
  });

  it("names NO signing algorithm — the key is resolved by kid from the JWKS", () => {
    // The gateway signs RS256 today and may add or switch. Pinning an algorithm
    // here would break sign-in on the day it rotates, for no benefit.
    const json = JSON.stringify(buildAuthConfig());
    expect(json).not.toMatch(/RS256|ES256|HS256|id_token_signed_response_alg/);
  });

  it("trusts the host — this deployment answers on four kinds of hostname", () => {
    // fasttraxent.com, headpinz.com, admin.fasttraxent.com and every preview
    // alias. The callback Auth.js builds must match the host the person started
    // on, or the state cookie is missing when they come back.
    expect(buildAuthConfig().trustHost).toBe(true);
  });

  it("keeps sessions in a JWT, capped at eight hours", () => {
    expect(buildAuthConfig().session).toEqual({ strategy: "jwt", maxAge: 8 * 60 * 60 });
  });

  it("routes failures to the page that explains them", () => {
    expect(buildAuthConfig().pages?.error).toBe("/sso/error");
  });

  it("never implements the debug logger — it prints tokens", () => {
    expect(buildAuthConfig().logger?.debug).toBeUndefined();
  });
});

describe("the profile → token → session hop carries roles and email", () => {
  const cfg = () => buildAuthConfig();

  it("maps the gateway's claims onto a user", () => {
    const p = provider().profile as (profile: Record<string, unknown>) => Record<string, unknown>;
    expect(p({ sub: "abc", name: "Eric Osborn", email: "eric@headpinz.com" })).toEqual({
      id: "abc",
      name: "Eric Osborn",
      email: "eric@headpinz.com",
    });
  });

  it("falls back to upn when the account has no mail attribute", () => {
    const p = provider().profile as (profile: Record<string, unknown>) => Record<string, unknown>;
    expect(p({ sub: "abc", name: "No Mail", upn: "nomail@headpinz.com" })).toMatchObject({
      email: "nomail@headpinz.com",
    });
  });

  it("copies roles onto the JWT on the sign-in pass and leaves it alone after", () => {
    const jwt = cfg().callbacks!.jwt!;
    const signedIn = jwt({
      token: {},
      profile: { roles: ["access"], email: "eric@headpinz.com" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as Record<string, unknown>;
    expect(signedIn).toMatchObject({ roles: ["access"], email: "eric@headpinz.com" });

    // No profile = a later request. The token must pass through untouched, not
    // be rebuilt with an empty roles array — that would sign everyone out on
    // their second page view.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const later = jwt({ token: signedIn } as any) as Record<string, unknown>;
    expect(later).toMatchObject({ roles: ["access"] });
  });

  it("treats a missing or malformed roles claim as no roles, not as a crash", () => {
    const jwt = cfg().callbacks!.jwt!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(jwt({ token: {}, profile: { email: "x@y.z" } } as any)).toMatchObject({ roles: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(jwt({ token: {}, profile: { roles: "access" } } as any)).toMatchObject({ roles: [] });
  });

  it("surfaces roles on the session the server components read", () => {
    const session = cfg().callbacks!.session!;
    const out = session({
      session: { user: {}, expires: "2026-08-29T00:00:00.000Z" },
      token: { roles: ["access"] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as { roles: string[] };
    expect(out.roles).toEqual(["access"]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session({ session: {}, token: {} } as any) as { roles: string[] }).roles).toEqual([]);
  });
});

describe("hasAdminAccess", () => {
  it("is the same one rule the edge gate applies", () => {
    expect(REQUIRED_ROLE).toBe("access");
    expect(hasAdminAccess({ roles: ["access"] })).toBe(true);
    expect(hasAdminAccess({ roles: ["marketing"] })).toBe(false);
    expect(hasAdminAccess({ roles: [] })).toBe(false);
    expect(hasAdminAccess(null)).toBe(false);
    expect(hasAdminAccess(undefined)).toBe(false);
  });
});
