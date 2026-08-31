import { adminPoppins } from "~/components/features/admin-skin/font";
import DealsAdminClient from "@/app/admin/[token]/deals/DealsAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Prepaid deal-pack sales — every pack sold, its voucher codes and redemptions.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/deals` (v1 — the static token in the path) and
 * `/admin/deals` (v2 — a Microsoft SSO session, no credential in the URL).
 *
 * NOT `/deals`, the guest storefront for the same product. The staff board wins
 * that name only on the admin host; the guest page keeps its canonical home.
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
      <DealsAdminClient token={apiToken} />
    </div>
  );
}
