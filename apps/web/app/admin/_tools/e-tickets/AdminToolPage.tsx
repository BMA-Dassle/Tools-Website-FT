import { adminPoppins } from "~/components/features/admin-skin/font";
import EticketAdminClient from "@/app/admin/[token]/e-tickets/EticketAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * E-ticket delivery admin — every ticket that was sent (or failed to send),
 * filterable, with a resend button per row.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/e-tickets` (v1 — the static token in the path, kept alive
 * for staff bookmarks and the shell) and `/admin/e-tickets` (v2 — a Microsoft
 * SSO session, no credential in the URL at all). Splitting them into two page
 * implementations would guarantee they drift; one of the two would get the next
 * fix and nobody would notice which.
 *
 * WHY THIS TOOL SIGNS IN (owner decision, 2026-08-28). It is a desk tool — the
 * same front-desk keyboard that runs check-in — and the screen it paints is a
 * list of guest email addresses and phone numbers. On the token, its URL was a
 * forwardable bearer credential for that list. A sign-in costs the person at
 * the desk one click a shift.
 *
 * The token it hands its client is a SIGNED 8-hour credential
 * (`mintAdminApiToken`), never `ADMIN_CAMERA_TOKEN` — the client sends it back
 * as `x-admin-token` / `?token=` exactly where it always sent one, and the
 * middleware accepts it for `/api/admin/*` only. Pinned by
 * scripts/check-admin-token-leak.mjs.
 */
export default async function AdminToolPage() {
  const apiToken = await mintAdminApiToken();

  return (
    <div className={adminPoppins.variable}>
      <EticketAdminClient token={apiToken} />
    </div>
  );
}
