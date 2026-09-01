import AdminToolPage from "@/app/admin/_tools/deals/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/deals` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it.
 *
 * Distinct from the guest `/deals` storefront, which is a top-level route on
 * the brand hosts and is not an admin path at all.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
