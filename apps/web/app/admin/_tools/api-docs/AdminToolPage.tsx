import ApiDocsClient from "@/app/admin/[token]/api-docs/ApiDocsClient";

/**
 * Swagger UI for the FastTrax Admin API — the server shell around the client
 * module that draws it.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/api-docs` (v1 — the static token in the path) and
 * `/admin/api-docs` (v2 — a Microsoft SSO session, no credential in the URL).
 *
 * This tool is the one that had NO server-side check of its own: it was a
 * `"use client"` page, gated by the middleware alone, and it is the example
 * `lib/admin-api-token.ts` cites for why a browser-held credential is not a
 * page credential. Both routes now ask for a real one before this renders.
 *
 * No `mintAdminApiToken()` here, deliberately. The docs page authenticates its
 * "Try it out" calls with an `x-api-key` the operator pastes in — it never
 * calls `/api/admin/*` on the staff member's behalf, so there is nothing to
 * mint and nothing to hand a browser.
 */
export default function AdminToolPage() {
  return <ApiDocsClient />;
}
