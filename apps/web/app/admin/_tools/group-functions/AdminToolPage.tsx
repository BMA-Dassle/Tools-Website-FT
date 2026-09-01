import { adminPoppins } from "~/components/features/admin-skin/font";
import GroupFunctionsClient from "@/app/admin/[token]/group-functions/GroupFunctionsClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Group functions — the booked-event board: contracts, deposits, headcounts and
 * the guest contact on every one.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/group-functions` (v1 — the static token in the path) and
 * `/admin/group-functions` (v2 — a Microsoft SSO session, no credential in the
 * URL at all).
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
      <GroupFunctionsClient token={apiToken} />
    </div>
  );
}
