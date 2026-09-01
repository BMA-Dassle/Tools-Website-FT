import AdminToolPage from "@/app/admin/_tools/signage/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/signage` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it.
 *
 * The tool signs in; the screens it configures do not. Those run on the public
 * `/tv/*` routes, which the middleware early-returns before the admin gate sees
 * them — the same distinction that keeps `pit` and `briefing` on the token.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is, and for the same
 * reason: what this board saves goes on a screen guests can read.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
