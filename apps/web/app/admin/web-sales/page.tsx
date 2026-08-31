import AdminToolPage from "@/app/admin/_tools/web-sales/AdminToolPage";
import type { AdminToolQueryPromise } from "@/app/admin/_tools/query";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/web-sales` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it. The filter query behaves exactly
 * as on the v1 route; it is the same component.
 *
 * This is where `deals` links its "all web sales" button, via `adminToolUrl()`
 * — the clean staff URL, never a tokened one.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page({ searchParams }: { searchParams: AdminToolQueryPromise }) {
  await requireSsoAdmin();
  return <AdminToolPage query={await searchParams} />;
}
