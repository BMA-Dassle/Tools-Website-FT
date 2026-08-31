import AdminToolPage from "@/app/admin/_tools/discount-codes/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/discount-codes` — no credential in the URL. A Microsoft SSO
 * session holding the `access` role is what opens it.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is, and for the same
 * reason: a code created here comes off the price of every booking that uses it.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
