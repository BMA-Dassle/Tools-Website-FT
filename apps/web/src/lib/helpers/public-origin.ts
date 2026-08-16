/**
 * publicOrigin — the origin to bake into absolute URLs that must be reachable
 * WITHOUT a Vercel Authentication session: guest payment links, QR payloads,
 * TV startup scripts, and server-side self-fetches of our own public API.
 *
 * On the main project NEXT_PUBLIC_ADMIN_PUBLIC_ORIGIN is unset, so this is
 * the identity function — behavior is byte-identical to before it existed.
 * On the admin Vercel project (which serves the same code behind Vercel
 * Authentication) the var carries the public site origin, because anything
 * derived from THAT deployment's own origin would point guests and
 * cookie-less devices at the auth wall — and a serverless self-fetch of the
 * protected origin gets the auth interstitial instead of JSON.
 * (Audit finding 2026-08-16; the var is set per-project in Vercel.)
 */
export const publicOrigin = (fallback: string): string =>
  process.env.NEXT_PUBLIC_ADMIN_PUBLIC_ORIGIN || fallback;
