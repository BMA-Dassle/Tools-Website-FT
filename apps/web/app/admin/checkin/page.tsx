import AdminToolPage from "@/app/admin/_tools/checkin/AdminToolPage";
import type { AdminToolQueryPromise } from "@/app/admin/_tools/query";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/checkin` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it. `?board=1` and `?loc=` behave
 * exactly as on the v1 route; they are the same component.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page({ searchParams }: { searchParams: AdminToolQueryPromise }) {
  await requireSsoAdmin();
  return <AdminToolPage query={await searchParams} />;
}
