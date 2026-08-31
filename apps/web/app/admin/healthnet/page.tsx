import AdminToolPage from "@/app/admin/_tools/healthnet/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/healthnet` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it.
 *
 * Not to be confused with the guest shortlink at `/healthnet`, a top-level
 * brand-host route that forwards to the event's confirm flow. Different tree,
 * different gate, untouched by this.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is, and for the same
 * reason: the roster is a named list of a corporate client's employees, with
 * their phone numbers.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
