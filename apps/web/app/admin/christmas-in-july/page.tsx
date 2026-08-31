import AdminToolPage from "@/app/admin/_tools/christmas-in-july/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/christmas-in-july` — no credential in the URL. A Microsoft SSO
 * session holding the `access` role is what opens it.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is. The board is a list
 * of guest names, emails and phone numbers, so it does not get to rely on one
 * gate.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
