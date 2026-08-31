import AdminEventDetailPage from "@/app/admin/_tools/daily-events/AdminEventDetailPage";
import type { AdminToolQueryPromise } from "@/app/admin/_tools/query";
import { requireSsoAdmin } from "~/features/sso/guard";

/**
 * v2: `/admin/daily-events/{projectId}` — no credential in the URL. A Microsoft
 * SSO session holding the `access` role is what opens it.
 *
 * The nested twin of the v1 portal deep-link shim, and it exists because the
 * v1 tree has one: `admin-tools.test.ts` walks `app/admin/[token]/**` and
 * demands the same relative path under `app/admin/` for every SSO tool, so a
 * deep link that resolves on the token URL resolves on the clean one too.
 */

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectId: string }>;
  searchParams: AdminToolQueryPromise;
};

export default async function Page({ params, searchParams }: Props) {
  await requireSsoAdmin();
  const { projectId } = await params;
  return <AdminEventDetailPage projectId={projectId} query={await searchParams} />;
}
