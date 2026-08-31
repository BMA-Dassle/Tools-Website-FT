import { notFound } from "next/navigation";
import AdminEventDetailPage from "@/app/admin/_tools/daily-events/AdminEventDetailPage";
import type { AdminToolQueryPromise } from "@/app/admin/_tools/query";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/daily-events/{projectId}` — the portal
 * deep-link shim.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/daily-events/{projectId}` (same shim, no credential in the URL);
 * the middleware 307s this URL to the clean one, deeper segment intact.
 */

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string; projectId: string }>;
  searchParams: AdminToolQueryPromise;
};

export default async function Page({ params, searchParams }: Props) {
  const { token, projectId } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <AdminEventDetailPage projectId={projectId} query={await searchParams} />;
}
