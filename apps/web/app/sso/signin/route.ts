import { NextResponse, type NextRequest } from "next/server";

import { signIn, SSO_PROVIDER_ID } from "@/auth";
import { logSso, SSO_E } from "~/features/sso/log";
import { safeCallbackPath } from "~/features/sso/redirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /sso/signin?callbackUrl=/admin/pit` — the staff sign-in entry point.
 *
 * THE AUTO-HOP. There is exactly one provider, so there is nothing to choose:
 * this skips Auth.js's built-in provider-chooser page (`/api/auth/signin`) and
 * starts the authorization request itself. One click becomes zero. The
 * middleware sends every unauthenticated admin page GET here; `/sso/*` is a
 * `self` path in the routing table, so it is reachable without a session
 * (there would be no way in otherwise).
 *
 * Auth.js's server-side `signIn()` builds the authorize URL, writes the PKCE /
 * state / nonce cookies, and then throws Next's `NEXT_REDIRECT` — which Next
 * turns into the 307 to the gateway. It must therefore be called *outside* any
 * try/catch, or the redirect gets swallowed as an error and the person sees a
 * blank page.
 *
 * `callbackUrl` is attacker-supplied — this endpoint sits on the same origin as
 * the public storefront, so anyone can link to it — and is sanitised to a
 * same-origin relative path first. See `~/features/sso/redirect`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const redirectTo = safeCallbackPath(req.nextUrl.searchParams.get("callbackUrl"));

  // Fail loudly-but-nicely on a misconfigured deploy. Without this the Auth.js
  // config error surfaces as a bare 500 with no SSO_E_* code, and the person
  // reporting it has nothing to quote.
  const missing = ["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_CLIENT_SECRET", "AUTH_SECRET"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    logSso("error", "sso.signin.config_error", { missing });
    const errorUrl = req.nextUrl.clone();
    errorUrl.pathname = "/sso/error";
    errorUrl.search = "";
    errorUrl.searchParams.set("code", SSO_E.CONFIG);
    return NextResponse.redirect(errorUrl);
  }

  await signIn(SSO_PROVIDER_ID, { redirectTo });

  // Unreachable in practice — `signIn` above always throws NEXT_REDIRECT. Kept
  // so the handler still answers with a redirect if that ever stops holding.
  return NextResponse.redirect(new URL(redirectTo, req.nextUrl.origin));
}
