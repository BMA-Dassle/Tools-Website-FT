import { adminPoppins } from "~/components/features/admin-skin/font";
import GroupApprovalsClient from "@/app/admin/[token]/group-approvals/GroupApprovalsClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Group-function approvals — the queue of proposed group bookings awaiting a
 * yes or a no, with the guest's contact details and the money on each.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/group-approvals` (v1 — the static token in the path) and
 * `/admin/group-approvals` (v2 — a Microsoft SSO session, no credential in the
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
      <GroupApprovalsClient token={apiToken} />
    </div>
  );
}
