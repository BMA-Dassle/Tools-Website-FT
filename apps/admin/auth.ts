import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import { recordSsoError, logSso, SSO_E } from "./src/sso-log";

/**
 * The shell's front door: Microsoft sign-in, brokered by the HeadPinz SSO
 * gateway.
 *
 * This project used to be walled by Vercel Authentication — which works, but
 * gates on "has a Vercel account on this team", not on "is a HeadPinz staff
 * member with the FastTrax admin role", and gives us no audit trail of who
 * opened which board. The gateway is a standards-compliant OpenID Provider, so
 * this file is the stock Auth.js recipe and nothing more; every app that joins
 * later copies it verbatim with a different client id.
 *
 * WHAT COMES BACK. The gateway has already filtered `roles` to THIS client and
 * stripped the prefix, so we get `["access"]`, not `["fasttrax-admin.access"]`.
 * Holding `access` is the whole authorization rule. Role changes in Entra take
 * effect on the next sign-in (≤8h), or immediately if an admin revokes the
 * gateway session.
 *
 * ALGORITHM AGILITY IS NOT OPTIONAL. The gateway signs ES256 today and may add
 * or switch to RS256. Auth.js resolves the signing key by `kid` from the
 * issuer's JWKS, so nothing here names an algorithm — do not "helpfully" pin
 * one.
 *
 * EDGE-SAFE. `proxy.ts` imports this, and the proxy runs on the edge, so the
 * session strategy is `jwt` (no adapter, no database) and the logger is a
 * console shim rather than pino. See src/sso-log.ts.
 */

/** Roles arrive on the profile; Auth.js's stock types don't know about them. */
declare module "next-auth" {
  interface Session {
    roles?: string[];
  }
}

/** Presence of this role means "may use the FastTrax admin tools". */
export const REQUIRED_ROLE = "access";

/** Read at call time, never at module scope — env is not available at build. */
const issuer = () => process.env.SSO_ISSUER ?? "";
const clientId = () => process.env.SSO_CLIENT_ID ?? "fasttrax-admin";

export const authConfig: NextAuthConfig = {
  providers: [
    {
      id: "headpinz",
      name: "HeadPinz SSO",
      type: "oidc",
      issuer: issuer(),
      clientId: clientId(),
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
  // Behind Vercel's proxy the forwarded host is the real one.
  trustHost: true,
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/** True when a session may use this app. The ONE authorization rule. */
export function hasAccess(session: { roles?: string[] } | null | undefined): boolean {
  return !!session?.roles?.includes(REQUIRED_ROLE);
}
