import AdminToolPage from "@/app/admin/_tools/daily-events-v2/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/daily-events-v2` — no credential in the URL. A Microsoft SSO
 * session holding the `access` role is what opens it.
 *
 * This is where the `daily-events` shim lands, on both of its routes. The shim
 * redirects to `/admin/daily-events-v2` — SAME-ORIGIN on purpose, so a visitor
 * who signed in on the brand host is not sent to the admin host to sign in a
 * second time (Auth.js session cookies are host-only). This path resolves on
 * either host: on `admin.fasttraxent.com` it is a `pass` in
 * `resolveAdminHostPath` and falls through to the same SSO branch.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered —
 * the same defence in depth the v1 page's token check is, and for the same
 * reason: this board moves money and event bookings for real customers.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
