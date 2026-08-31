import { adminPoppins } from "~/components/features/admin-skin/font";
import DiscountCodesClient from "@/app/admin/[token]/discount-codes/DiscountCodesClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Discount-code management — create, edit, expire and audit the codes the
 * booking flows accept.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/discount-codes` (v1 — the static token in the path) and
 * `/admin/discount-codes` (v2 — a Microsoft SSO session, no credential in the
 * URL at all). Anyone who can open this board can mint money off every product
 * on the site, which is what a per-person sign-in is for.
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
      <DiscountCodesClient token={apiToken} />
    </div>
  );
}
