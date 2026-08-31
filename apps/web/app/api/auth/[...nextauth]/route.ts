/**
 * Auth.js's own endpoints: `/api/auth/signin`, `/api/auth/callback/headpinz`,
 * `/api/auth/session`, `/api/auth/signout`, `/api/auth/csrf`.
 *
 * The middleware lets `/api/auth/*` through unauthenticated (see
 * `isSsoSelfPath` in `~/features/sso/tools`) — gating the sign-in route on
 * being signed in is an infinite redirect.
 *
 * Node runtime: the token exchange with the gateway is a server-to-server POST
 * with a client secret, and the id_token signature check pulls the issuer's
 * JWKS. Neither belongs on the edge.
 */
import { handlers } from "@/auth";

export const runtime = "nodejs";

export const { GET, POST } = handlers;
