import AdminToolPage from "@/app/admin/_tools/e-tickets/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/e-tickets` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it.
 *
 * Next resolves the static `e-tickets` segment ahead of the sibling `[token]`
 * dynamic segment, so this route and the v1 one coexist; `admin-tools.test.ts`
 * pins that both trees carry every migrated tool.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is, and for the same
 * reason: this board resends tickets to real guests and shows their contact
 * details, so it does not get to rely on one gate.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
