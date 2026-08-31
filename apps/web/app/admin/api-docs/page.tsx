import AdminToolPage from "@/app/admin/_tools/api-docs/AdminToolPage";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/api-docs` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it.
 *
 * `requireSsoAdmin()` re-asks the question the middleware already answered.
 * For this tool that is not merely defence in depth: `api-docs` spent its whole
 * life as a `"use client"` page with the middleware as its only gate, and the
 * audit called that out by name. It now has a server-side check on both routes.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  await requireSsoAdmin();
  return <AdminToolPage />;
}
