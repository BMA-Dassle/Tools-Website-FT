import { adminPoppins } from "~/components/features/admin-skin/font";
import SalesAdminClient from "@/app/admin/[token]/sales/SalesAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Sales / web-reservations admin — every confirmed reservation since the deploy
 * of `lib/sales-log.ts`, powered by `/api/admin/sales/list` over the
 * `sales:log:{date}` keys.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/sales` (v1 — the static token in the path) and
 * `/admin/sales` (v2 — a Microsoft SSO session, no credential in the URL at
 * all). The board is a searchable list of guest names, emails, phone numbers
 * and card outcomes, which is the whole argument for a sign-in.
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
      <SalesAdminClient token={apiToken} />
    </div>
  );
}
