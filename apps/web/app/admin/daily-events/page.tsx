import AdminToolPage from "@/app/admin/_tools/daily-events/AdminToolPage";
import type { AdminToolQueryPromise } from "@/app/admin/_tools/query";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/daily-events` — no credential in the URL. A Microsoft SSO session
 * holding the `access` role is what opens it.
 *
 * It is a REDIRECT, not a board: it forwards to `daily-events-v2` exactly as
 * the v1 route does. The gate still applies, and deliberately — a redirect that
 * names internal tool URLs and forwards arbitrary query params is not something
 * to leave open just because it renders nothing.
 */

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: AdminToolQueryPromise }) {
  await requireSsoAdmin();
  return <AdminToolPage query={await searchParams} />;
}
