/**
 * Base URL for calling our OWN `/api/*` routes from data-layer code that may run
 * BOTH in the browser and on the server.
 *
 * - Browser → `""` (relative, same origin) — unchanged behavior.
 * - Server → an absolute origin, because Node's `fetch` rejects relative URLs.
 *   Lets server code (e.g. the cached kiosk-availability endpoint) reuse the
 *   same client data-layer fetchers by self-calling our API.
 *
 * Mirrors the `NEXT_PUBLIC_SITE_URL` + prod-fallback convention already used for
 * server-side self-calls (see lib/booking-confirmation-link.ts,
 * features/booking/service/kiosk-post-reserve.ts).
 */
export function apiBase(): string {
  if (typeof window !== "undefined") return "";
  return process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
}
