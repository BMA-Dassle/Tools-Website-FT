import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import { recordSsoError, logSso, SSO_E } from "~/features/sso/log";
import { REQUIRED_ROLE } from "~/features/sso/session";

/**
 * The staff front door: Microsoft sign-in, brokered by the HeadPinz SSO
 * gateway, for the admin tools this app serves at `/admin/<tool>`.
 *
 * WHY IT LIVES HERE NOW. Until this PR the sign-in lived in a separate Next
 * project (`apps/admin`) that authenticated the person and then proxied every
 * request to this deployment with the static `ADMIN_CAMERA_TOKEN` injected into
 * the path. That shell was the answer to the wrong wall: it was built to get
 * off Vercel Authentication, and once a real OIDC gateway existed the extra
 * deployment bought nothing and cost plenty — a second env block, a shared
 * proxy key, a routing table drift-pinned to this app's directory listing, and
 * the static token serialised into every board's RSC payload (audit item #8).
 * The gate belongs in the app that owns the routes. The shell keeps working
 * untouched until PR B retires it.
 *
 * WHAT COMES BACK. The gateway has already filtered `roles` to THIS client and
 * stripped the prefix, so we get `["access"]`, not `["fasttrax-admin.access"]`.
 * Holding `access` is the whole authorization rule. Role changes in Entra take
 * effect on the next sign-in (≤8h), or immediately if an admin revokes the
 * gateway session.
 *
 * ALGORITHM AGILITY IS NOT OPTIONAL. The gateway signs RS256 today and may add
 * or switch. Auth.js resolves the signing key by `kid` from the issuer's JWKS,
 * so nothing here names an algorithm — do not "helpfully" pin one.
 *
 * NOT IMPORTED BY THE MIDDLEWARE, on purpose. `middleware.ts` answers every
 * request to the public storefront; importing this would make one missing env
 * var 500 the whole site rather than 404 the admin tools. The middleware reads
 * the session cookie directly instead (`~/features/sso/session`), which is a
 * pure, edge-safe function of the cookie and `AUTH_SECRET`.
 */

/** Roles arrive on the profile; Auth.js's stock types don't know about them. */
declare module "next-auth" {
  interface Session {
    roles?: string[];
  }
}

export { REQUIRED_ROLE };

/** Auth.js provider id → the callback path `/api/auth/callback/headpinz`. */
export const SSO_PROVIDER_ID = "headpinz";

/**
 * THE ENV MUST EXIST BEFORE THIS DEPLOYS. Auth.js validates its configuration
 * on the first request, not at build: with `AUTH_SECRET` or `SSO_ISSUER`
 * missing, `auth()` throws. Every caller in this app treats a throw as "no
 * session" and fails closed (the v2 pages 404, `/sso/signin` redirects to
 * `/sso/error?code=SSO_E_CONFIG`), so a missing env block locks staff out
 * rather than breaking guests — but it still locks staff out. Set `SSO_ISSUER`,
 * `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` and `AUTH_SECRET` on `tools-website-ft`
 * FIRST. (tasks/todo.md carries the same warning in the rollout order.)
 *
 * Hence the factory: the config is built when a request needs it, so the values
 * come from the runtime environment rather than from whatever was set the
 * moment this module happened to be imported. Auth.js takes a config function
 * for exactly this. Never hoist any `process.env` read out of here.
 */
export function buildAuthConfig(): NextAuthConfig {
  return {
    providers: [
      {
        id: SSO_PROVIDER_ID,
        name: "HeadPinz SSO",
        type: "oidc",
        issuer: process.env.SSO_ISSUER ?? "",
        clientId: process.env.SSO_CLIENT_ID ?? "fasttrax-admin",
        clientSecret: process.env.SSO_CLIENT_SECRET,
        // client_secret_basic is the gateway's registration for this confidential
        // client; Auth.js negotiates it from the discovery document.
        authorization: { params: { scope: "openid profile email roles" } },
        checks: ["pkce", "state", "nonce"],
        profile(profile) {
          return {
            id: String(profile.sub),
            name: (profile.name as string) ?? null,
            email: ((profile.email ?? profile.upn) as string) ?? null,
          };
        },
      },
    ],
    session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
    callbacks: {
      // `profile` is present only on the sign-in pass; every later call just
      // carries what we copied then.
      jwt({ token, profile }) {
        if (profile) {
          const roles = Array.isArray(profile.roles) ? (profile.roles as string[]) : [];
          return { ...token, roles, email: (profile.email ?? profile.upn) as string | undefined };
        }
        return token;
      },
      session({ session, token }) {
        const roles = Array.isArray((token as { roles?: unknown }).roles)
          ? (token as { roles: string[] }).roles
          : [];
        return { ...session, roles };
      },
    },
    // The error page names the code and the gateway request id — the two things
    // needed to trace a failure from the user's screen to the gateway's audit log.
    pages: { error: "/sso/error" },
    events: {
      signIn({ user }) {
        logSso("info", "sso.signin.ok", { email: user?.email ?? undefined });
      },
      signOut() {
        logSso("info", "sso.signout");
      },
    },
    logger: {
      error(error) {
        recordSsoError({
          code: error?.name === "CallbackRouteError" ? SSO_E.CALLBACK_FAILED : SSO_E.UNKNOWN,
          message: error?.message,
        });
      },
      warn(code) {
        logSso("warn", "sso.warn", { code });
      },
      // debug() is deliberately unimplemented — it prints tokens.
    },
    /**
     * MANDATORY HERE, not a copied default. This one deployment answers on
     * `fasttraxent.com`, `headpinz.com`, `admin.fasttraxent.com` and every
     * Vercel preview alias, and the callback URL Auth.js builds has to match the
     * host the person actually started on — otherwise a sign-in begun on the
     * admin host comes back to the brand host and the state cookie is missing.
     */
    trustHost: true,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildAuthConfig());

/** True when a session may use the admin tools. The ONE authorization rule. */
export function hasAdminAccess(session: { roles?: string[] } | null | undefined): boolean {
  return !!session?.roles?.includes(REQUIRED_ROLE);
}
