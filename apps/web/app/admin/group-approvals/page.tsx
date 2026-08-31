import AdminToolPage from "@/app/admin/_tools/group-approvals/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/group-approvals` — no credential in the URL. A Microsoft SSO
 * session holding the `access` role is what opens it.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is, and for the same
 * reason: an approval here commits the building to an event and a price.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
