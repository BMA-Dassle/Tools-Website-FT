import AdminToolPage from "@/app/admin/_tools/reservations/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/reservations` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it.
 *
 * Next resolves the static `reservations` segment ahead of the sibling `[token]`
 * dynamic segment, so this route and the v1 one coexist; `tools.test.ts` pins
 * that both trees carry every tool.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is, and for the same
 * reason: this board mutates real money and real screens, so it does not get to
 * rely on one gate.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
